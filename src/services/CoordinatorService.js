import { TOOLS_API_URL } from "../../secrets.js";
import { resolve, relative } from "node:path";
import { existsSync } from "node:fs";
import logger from "../utils/logger.js";
import mutationQueue from "./MutationQueue.js";
import { getProvider } from "../providers/index.js";
import { getInstancesByType, getInstanceType } from "../providers/instance-registry.js";
import RequestLogger from "./RequestLogger.js";
import { estimateTokens, calculateTextCost } from "../utils/CostCalculator.js";
import { TYPES, getPricing } from "../config.js";
import { calculateTokensPerSec } from "../utils/math.js";
import { roundMs } from "../utils/utilities.js";
import localModelQueue from "./LocalModelQueue.js";
import ToolOrchestratorService from "./ToolOrchestratorService.js";
import { COORDINATOR_ONLY_TOOLS } from "./CoordinatorPrompt.js";
import SettingsService from "./SettingsService.js";
import { createAbortController } from "../utils/AbortController.js";
import { registerCleanup } from "../utils/CleanupRegistry.js";

// ────────────────────────────────────────────────────────────
// CoordinatorService — Multi-Agent Orchestration
// ────────────────────────────────────────────────────────────
// Decomposes complex refactoring tasks into sub-tasks, spawns
// parallel AgenticLoopService workers in isolated git worktrees,
// and merges results back into the main branch.
//
// Two entry points:
//   1. Manual Panel: decompose() → execute() → approveMerge()
//   2. Chat Tools:   spawnFromTool() / sendMessage() / stopAgent()
//      Called when the LLM invokes team_create / send_message / stop_agent
// ────────────────────────────────────────────────────────────

function getDefaultWorkspaceRoot() {
  return ToolOrchestratorService.getWorkspaceRoot()
    || resolve(process.env.HOME || "/home");
}

/**
 * Derive the git repo path from a worker's file list.
 *
 * If files live under a git subdirectory of the workspace root
 * (e.g. /workspace/projectA/.git exists), return that subdirectory
 * as the repo path so worktrees branch from it.
 *
 * Falls back to workspaceRoot if no git repo is found.
 */
function resolveRepoPath(workspaceRoot, files) {
  if (!files?.length) return workspaceRoot;

  // Check if workspace root itself is a git repo
  if (existsSync(resolve(workspaceRoot, ".git"))) return workspaceRoot;

  // Take the first file, get its path relative to workspace root,
  // extract the first directory segment (the project dir)
  const firstFile = resolve(files[0]);
  const rel = relative(workspaceRoot, firstFile);
  const firstSegment = rel.split("/")[0];
  if (!firstSegment) return workspaceRoot;

  const candidate = resolve(workspaceRoot, firstSegment);
  if (existsSync(resolve(candidate, ".git"))) {
    return candidate;
  }

  return workspaceRoot;
}

/** Max parallel workers */
const MAX_WORKERS = 5;

/** Max iterations per worker agent loop */
const MAX_WORKER_ITERATIONS = 15;

/** Model used for task decomposition */
const DECOMPOSITION_PROVIDER = "anthropic";
const DECOMPOSITION_MODEL = "claude-sonnet-4-20250514";

/**
 * Resolve the user-configured subagent provider/model from settings.
 * Returns null when no subagent model is configured — callers should
 * keep the local provider (queuing) when this returns null.
 * @returns {Promise<{ provider: string, model: string }|null>}
 */
async function getWorkerFallback() {
  try {
    const agents = await SettingsService.getSection("agents");
    if (agents?.subagentProvider && agents?.subagentModel) {
      return { provider: agents.subagentProvider, model: agents.subagentModel };
    }
    return null;
  } catch {
    return null;
  }
}

/** Active coordinator tasks keyed by taskId (manual panel flow) */
const activeTasks = new Map();

/** Active agents spawned via chat tools, keyed by agentId */
const activeWorkers = new Map();

/**
 * Synchronous per-instance reservation counter.
 * Prevents race conditions when multiple team_create calls fire concurrently
 * via Promise.all — each spawn increments the counter immediately at selection
 * time, so the next spawn sees the correct active count.
 * Keyed by instance id (provider name).
 */
const instanceReservations = new Map();

/** Counter for generating sequential agent IDs */
let agentCounter = 0;

// Register shutdown cleanup — abort all running workers and remove worktrees
registerCleanup(async () => {
  const running = [...activeWorkers.values()].filter((w) => w.status === "running");
  if (running.length === 0) return;

  logger.info(`[Coordinator] Shutdown: aborting ${running.length} running worker(s)…`);
  for (const worker of running) {
    worker.abortController?.abort();
    worker.status = "stopped";
    worker.durationMs = Date.now() - worker.startedAt;
  }

  // Clean up worktrees in parallel
  const cleanups = running
    .filter((w) => w.isolated && w.worktreePath)
    .map((w) =>
      removeWorktree(w.repoPath, w.worktreePath)
        .then(() => { w.worktreePath = null; })
        .catch((e) => logger.warn(`[Coordinator] Shutdown worktree cleanup failed for ${w.agentId}: ${e.message}`)),
    );

  if (cleanups.length > 0) {
    await Promise.allSettled(cleanups);
    logger.info(`[Coordinator] Shutdown: cleaned up ${cleanups.length} worktree(s)`);
  }
});

// ────────────────────────────────────────────────────────────
// Quantization-Level Fallback for Multi-Device Workers
// ────────────────────────────────────────────────────────────
// When the orchestrator's exact model isn't available on a worker
// instance (e.g. the Desktop has Q8_0 but the Laptop only has Q4_K_M),
// find the best available variant of the same base model.
//
// Instead of maintaining a hardcoded quant ranking list, we use the
// model's `size_bytes` from the LM Studio API — file size on disk is
// the canonical proxy for quantization quality (more bits = larger file
// = higher fidelity). This automatically handles any quant scheme
// (standard Q/IQ, K-quants, future formats) without updates.

/**
 * Regex matching known GGUF quantization suffixes.
 * Captures the quant tag (e.g. "Q8_0", "IQ4_XS", "F16", "BF16").
 * Used to strip the suffix and extract the base model name.
 */
const GGUF_QUANT_SUFFIX_RE = /[-_]((?:I?Q[0-9]+(?:_[A-Z0-9]+)*|[BF](?:16|32)))(?:\.gguf)?$/i;

/**
 * Extract the base model name from a GGUF model key by stripping the
 * quantization suffix. Handles both path-style and flat-style keys.
 *
 * Examples:
 *   "lmstudio-community/qwen3-32b-GGUF/qwen3-32b-Q8_0.gguf"
 *     → base: "lmstudio-community/qwen3-32b-GGUF/qwen3-32b"
 *     → quant: "Q8_0"
 *
 *   "qwen3-32b@q4_k_m"
 *     → base: "qwen3-32b"
 *     → quant: "Q4_K_M"
 *
 * @param {string} modelKey
 * @returns {{ base: string, quant: string|null }}
 */
function parseModelQuant(modelKey) {
  // Handle @quant suffix (e.g. "qwen3-32b@q4_k_m")
  if (modelKey.includes("@")) {
    const [base, quant] = modelKey.split("@");
    return { base, quant: quant.toUpperCase() };
  }

  // Handle GGUF path-style keys — strip .gguf, then match the quant suffix via regex
  const stripped = modelKey.replace(/\.gguf$/i, "");
  const match = stripped.match(GGUF_QUANT_SUFFIX_RE);
  if (match) {
    const quant = match[1].toUpperCase();
    const base = stripped.slice(0, match.index);
    return { base, quant };
  }

  return { base: modelKey, quant: null };
}

/**
 * Find the best available variant of a model among the available models
 * on a specific instance. Ranks by `size_bytes` (file size on disk) —
 * the largest file is the highest-quality quantization.
 *
 * Unlike the old approach that only considered lower quants, this picks
 * the best available variant period — so a Laptop with Q8_0 can serve
 * workers even when the coordinator loaded Q4_K_M on the Desktop.
 *
 * @param {string} targetModel - The model key to find a fallback for
 * @param {Array<{key?: string, id?: string, size_bytes?: number}>} availableModels - Models on the instance
 * @returns {string|null} The best available model key (by file size), or null
 */
function findBestQuantFallback(targetModel, availableModels) {
  const { base: targetBase, quant: targetQuant } = parseModelQuant(targetModel);

  // Find all available models that share the same base name (any quant variant)
  const candidates = [];
  for (const m of availableModels) {
    const mKey = m.key || m.id;
    const { base, quant } = parseModelQuant(mKey);

    // Compare bases case-insensitively
    if (base.toLowerCase() !== targetBase.toLowerCase()) continue;

    // Skip exact same key (already checked before calling this)
    if (mKey === targetModel) continue;
    // Skip identical quant (both could be null for no-quant keys)
    if (quant === targetQuant) continue;

    candidates.push({ key: mKey, quant, sizeBytes: m.size_bytes || 0 });
  }

  if (candidates.length === 0) return null;

  // Sort by file size descending — largest file = highest quality quant
  candidates.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return candidates[0].key;
}

// ────────────────────────────────────────────────────────────
// Instance Selection & Reservation
// ────────────────────────────────────────────────────────────
// Shared by both spawnFromTool (single) and createTeam (batch).
// Selects the least-busy instance and increments the reservation
// counter synchronously so the next call sees the updated count.

/**
 * Count active workers + pending reservations on an instance.
 * @param {string} instanceId
 * @returns {number}
 */
function getActiveOn(instanceId) {
  const reserved = instanceReservations.get(instanceId) || 0;
  const running = [...activeWorkers.values()].filter(
    (w) => w.providerName === instanceId && w.status === "running",
  ).length;
  return reserved + running;
}

/**
 * Select the best instance from `siblings`, increment its reservation
 * counter, and return the assignment. Returns null if all instances
 * are at capacity.
 *
 * @param {Array<{id: string, concurrency: number}>} siblings - Available instances
 * @param {string} coordinatorInstanceId - The coordinator's own instance id
 * @param {Map<string, string>} instanceModelOverrides - Per-instance model overrides (quant fallback)
 * @param {string} defaultModel - The default model to use when no override exists
 * @returns {{ provider: string, model: string, slotsAvailable: number }|null}
 */
function selectAndReserveInstance(siblings, coordinatorInstanceId, instanceModelOverrides, defaultModel) {
  // Debug: log the full instance state for tracing assignment decisions
  const stateSnapshot = siblings.map((s) => {
    const active = getActiveOn(s.id);
    return `${s.id}(concurrency=${s.concurrency}, active=${active}, free=${s.concurrency - active})`;
  }).join(", ");
  logger.info(`[Coordinator] selectAndReserveInstance: siblings=[${stateSnapshot}], coordinator=${coordinatorInstanceId}`);

  // Greedy least-loaded: pick the instance with the most available slots.
  // This distributes workers evenly across all instances rather than
  // filling the coordinator's instance first.
  //
  // The coordinator's own instance gets a small tiebreaker bonus (+0.5)
  // because its orchestrator inference is IDLE while workers run —
  // it finished generating tool calls and only resumes after all complete.
  // This means we slightly prefer the coord instance when slots are equal,
  // but will use a secondary if it has strictly more capacity.
  let bestInstance = null;
  let bestScore = -1; // available + tiebreaker

  for (const inst of siblings) {
    const active = getActiveOn(inst.id);
    const available = inst.concurrency - active;
    if (available <= 0) continue;

    // Tiebreaker: coordinator's instance gets +0.5 since orchestrator is idle
    const score = inst.id === coordinatorInstanceId ? available + 0.5 : available;
    if (score > bestScore) {
      bestScore = score;
      bestInstance = inst;
    }
  }

  if (!bestInstance) {
    logger.info(`[Coordinator] selectAndReserveInstance: no instance available`);
    return null;
  }

  const available = bestInstance.concurrency - getActiveOn(bestInstance.id);

  // Increment reservation synchronously so the next call sees it
  instanceReservations.set(bestInstance.id, (instanceReservations.get(bestInstance.id) || 0) + 1);

  // Apply quant fallback model if the selected instance has an override
  const model = instanceModelOverrides.get(bestInstance.id) || defaultModel;

  return { provider: bestInstance.id, model, slotsAvailable: available };
}

// ────────────────────────────────────────────────────────────
// Tools-API Helpers
// ────────────────────────────────────────────────────────────

async function toolsApiPost(path, body) {
  try {
    const res = await fetch(`${TOOLS_API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { error: err.error || `API returned ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    return { error: `Failed to reach tools-api: ${err.message}` };
  }
}

async function createWorktree(repoPath, branchName) {
  return toolsApiPost("/agentic/git/worktree/create", { path: repoPath, branch: branchName });
}

async function removeWorktree(repoPath, worktreePath) {
  return toolsApiPost("/agentic/git/worktree/remove", { path: repoPath, worktreePath });
}

async function getWorktreeDiff(repoPath, branch) {
  return toolsApiPost("/agentic/git/worktree/diff", { path: repoPath, branch });
}

async function mergeWorktree(repoPath, branch, message) {
  return toolsApiPost("/agentic/git/worktree/merge", { path: repoPath, branch, message });
}

async function cleanupWorktrees(repoPath) {
  return toolsApiPost("/agentic/git/worktree/cleanup", { path: repoPath });
}

// ────────────────────────────────────────────────────────────
// Worker Result Builder
// ────────────────────────────────────────────────────────────
// Returns a structured result object that becomes the team_create
// tool call's response. The coordinator LLM receives it directly
// as the tool result — no separate user-role notification needed.

/**
 * Extract the text content from the last assistant message in a conversation.
 * Mirrors Claude Code's finalizeAgentTool pattern — only the final report is
 * returned to the orchestrator, keeping the parent context clean.
 *
 * If the last assistant message has no text (e.g. it was a pure tool_use),
 * walks backward to find the most recent assistant message with text.
 */
function getLastAssistantText(messages) {
  if (!messages?.length) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text = (typeof m.content === "string" ? m.content : "").trim();
    if (text) return text;
  }
  return "";
}

function buildWorkerResult(worker) {
  const status = worker.status === "complete" ? "completed" : worker.status;
  const summary = status === "completed"
    ? `Agent "${worker.description}" completed`
    : status === "failed"
      ? `Agent "${worker.description}" failed: ${worker.error || "Unknown error"}`
      : `Agent "${worker.description}" was stopped`;

  // Return the full last assistant message text (no truncation).
  // Like Claude Code, we trust the model to produce a concise final report.
  const lastText = getLastAssistantText(worker.messages);

  const result = {
    agent_id: worker.agentId,
    description: worker.description,
    status,
    summary,
    result: lastText || (worker.output || "").trim() || null,
    toolUses: worker.toolCalls?.length || 0,
    iterations: worker.iterations || 0,
    durationMs: worker.durationMs || 0,
  };

  if (worker.diff?.hasChanges) {
    result.diff = {
      additions: worker.diff.additions || 0,
      deletions: worker.diff.deletions || 0,
      files: worker.diff.files || [],
    };
  }

  if (worker.error) result.error = worker.error;

  return result;
}

// ────────────────────────────────────────────────────────────
// Decomposition Prompt
// ────────────────────────────────────────────────────────────

const DECOMPOSITION_PROMPT = `You are a task decomposition engine for a multi-agent coding system.

Given a refactoring task description and a list of target files, decompose the task into independent sub-tasks that can be executed in parallel by separate coding agents.

Rules:
1. Each sub-task should target 1-3 files maximum
2. Sub-tasks must be independent — no sub-task should depend on the output of another
3. If files have tight coupling and MUST be edited together, group them in one sub-task
4. Each sub-task instruction should be self-contained and specific
5. Include the exact file paths in each sub-task

Respond with a JSON object (no markdown fences):
{
  "subTasks": [
    {
      "id": "task-1",
      "files": ["/absolute/path/to/file1.js"],
      "instruction": "Detailed instruction for what the worker agent should do to these files",
      "complexity": "low|medium|high"
    }
  ],
  "summary": "Brief overall plan summary"
}`;

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

export default class CoordinatorService {
  // ══════════════════════════════════════════════════════════
  // Chat-Triggered Tools (team_create / send_message / stop_agent)
  // ══════════════════════════════════════════════════════════

  /**
   * Spawn a worker agent from a team_create tool call.
   *
   * Creates a git worktree, runs AgenticLoopService.runAgenticLoop() in it,
   * collects the diff when complete, and injects a [WORKER COMPLETED] notification into
   * the coordinator's conversation.
   *
   * @param {object} params
   * @param {string} params.description - Short label for the worker
   * @param {string} params.prompt - Self-contained task prompt for the worker
   * @param {string[]} [params.files] - Optional file paths to focus on
   * @param {string} [params.model] - Optional model override for the worker
   * @param {string} [params.assignedProvider] - Pre-assigned provider (from createTeam)
   * @param {string} [params.assignedModel] - Pre-assigned model (from createTeam)
   * @param {object} params.coordinatorCtx - Coordinator's loop context
   * @returns {Promise<object>} Spawn result with agentId
   */
  static async spawnFromTool({ description, prompt, files, model, assignedProvider, assignedModel, coordinatorCtx }) {
    const { project, username, agent, providerName, resolvedModel, traceId, agentSessionId: parentAgentSessionId, maxWorkerIterations: clientMaxWorkerIter, minContextLength } = coordinatorCtx;

    // Resolve max worker iterations: 0 = unlimited (Infinity), positive = clamped 1-100, default = constant
    const resolvedMaxWorkerIterations = clientMaxWorkerIter === 0
      ? Infinity
      : clientMaxWorkerIter
        ? Math.min(100, Math.max(1, clientMaxWorkerIter))
        : MAX_WORKER_ITERATIONS;

    // Check concurrency limit
    const runningCount = Array.from(activeWorkers.values()).filter((w) => w.status === "running").length;
    if (runningCount >= MAX_WORKERS) {
      return { error: `Maximum concurrent workers (${MAX_WORKERS}) reached. Wait for a worker to complete or stop one.` };
    }

    // ── Pre-assigned instance (from createTeam batch assignment) ──
    // When createTeam calls us, it has already resolved model availability
    // and assigned instances serially with proper reservation counting.
    // Skip the entire instance selection path to avoid double-counting.
    let workerProvider = assignedProvider || providerName;
    // For local providers, the LLM can't know valid GGUF identifiers —
    // skip the LLM-provided `model` param to prevent hallucinated names.
    const isLocal = localModelQueue.isLocal(providerName);
    let workerModel = assignedModel || (isLocal ? resolvedModel : (model || resolvedModel));
    const preAssigned = !!(assignedProvider);

    if (preAssigned) {
      logger.info(`[Coordinator] spawnFromTool: pre-assigned to ${workerProvider} — model "${workerModel}" (skipping instance selection)`);
    }
    if (!preAssigned && localModelQueue.isLocal(providerName)) {
      const providerType = getInstanceType(providerName) || providerName;
      let siblings = getInstancesByType(providerType);

      // ── Model availability filter ─────────────────────────────
      // When multiple instances exist, verify the worker model is
      // downloaded on each before routing there. Prevents 404 errors
      // from instances that don't have the model on disk.
      //
      // If the exact model isn't found, attempt quantization-level
      // fallback: search for the same base model at a different quant.
      // This enables heterogeneous GPU setups where different machines
      // have different quant levels.
      /** @type {Map<string, string>} Per-instance model override (when quant fallback is used) */
      const instanceModelOverrides = new Map();

      if (siblings.length > 1) {
        try {
          const checks = await Promise.allSettled(
            siblings.map(async (inst) => {
              const provider = getProvider(inst.id);
              if (!provider?.listModels) return { exact: false, fallback: null };
              const result = await Promise.race([
                provider.listModels(),
                new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
              ]);
              const models = result?.models || result?.data || [];
              const exactMatch = models.some((m) => (m.key || m.id) === workerModel);
              if (exactMatch) return { exact: true, fallback: null };

              // No exact key match — find the best variant with the same base name
              const fallback = findBestQuantFallback(workerModel, models);
              return { exact: false, fallback };
            }),
          );

          // Build per-instance model map — keep all usable instances
          const usable = [];
          for (let i = 0; i < siblings.length; i++) {
            if (checks[i].status !== "fulfilled") continue;
            const { exact, fallback } = checks[i].value;

            if (exact) {
              usable.push(siblings[i]);
            } else if (fallback) {
              instanceModelOverrides.set(siblings[i].id, fallback);
              usable.push(siblings[i]);
            }
          }

          const summary = usable.map((s) => {
            const override = instanceModelOverrides.get(s.id);
            return override ? `${s.id}→"${override}"` : `${s.id} (exact)`;
          }).join(", ");
          logger.info(`[Coordinator] Model resolution for "${workerModel}": ${usable.length}/${siblings.length} instances usable [${summary}]`);

          if (usable.length > 0) {
            siblings = usable;
          } else {
            logger.warn(`[Coordinator] Model "${workerModel}" not available on any ${getInstanceType(providerName) || providerName} instance`);
            siblings = [];
          }
        } catch (err) {
          logger.warn(`[Coordinator] Model availability check failed: ${err.message}`);
        }
      }

      // ── Instance selection: respect concurrency per instance ──
      // concurrency is the max parallel inference requests an instance handles.
      // The orchestrator's inference is IDLE while workers run (it finished
      // generating team_create tool calls), but we reserve 1 slot on its
      // instance for the continuation turn after workers complete.
      //
      // instanceReservations prevents race conditions when multiple team_create
      // calls fire concurrently — the counter is incremented synchronously.
      const assigned = selectAndReserveInstance(siblings, providerName, instanceModelOverrides, workerModel);

      if (assigned) {
        workerProvider = assigned.provider;
        workerModel = assigned.model;
        logger.info(
          `[Coordinator] Assigned agent to ${assigned.provider} (${assigned.slotsAvailable} slots free, ${siblings.length} instance${siblings.length > 1 ? "s" : ""} pooled) — model "${assigned.model}"`,
        );
      } else {
        // Resolve the user-configured (or hardcoded) subagent fallback
        const workerFallback = await getWorkerFallback();
        if (workerFallback) {
          workerProvider = workerFallback.provider;
          workerModel = workerFallback.model;
          logger.info(`[Coordinator] All instances at capacity — agent will use ${workerFallback.model}`);
        } else {
          logger.info(`[Coordinator] All instances at capacity and no subagent model configured — agent will queue on local provider`);
        }
      }
    }

    const agentId = `agent-${(++agentCounter).toString(36)}-${crypto.randomUUID().slice(0, 4)}`;
    const branchName = `coordinator/${agentId}`;
    const workspaceRoot = getDefaultWorkspaceRoot();

    // Derive the git repo path from worker files.
    // If files live under a git subdirectory (e.g. /workspace/projectA/),
    // use that as the worktree source. Otherwise fall back to workspace root.
    const repoPath = resolveRepoPath(workspaceRoot, files);

    // Attempt git worktree creation — best-effort
    // Non-git workspaces gracefully degrade to shared directory mode
    let worktreePath = null;
    const worktreeResult = await createWorktree(repoPath, branchName);
    if (worktreeResult.error) {
      logger.warn(`[Coordinator] Worktree creation skipped for ${agentId}: ${worktreeResult.error}. Running in workspace root.`);
      worktreePath = workspaceRoot;
    } else {
      worktreePath = worktreeResult.worktreePath;
    }

    const workerAgentSessionId = crypto.randomUUID();

    const workerState = {
      agentId,
      workerAgentSessionId,
      parentAgentSessionId,
      description,
      branchName: worktreeResult.error ? null : branchName,
      worktreePath,
      repoPath,
      isolated: !worktreeResult.error, // true if running in a worktree
      status: "running",
      output: "",
      toolCalls: [],
      diff: null,
      error: null,
      startedAt: Date.now(),
      durationMs: 0,
      totalCost: null,
      usage: null,
      abortController: createAbortController(),
      messages: [],
      files: files || [],
      // Carry coordinator context for continuation
      project,
      username,
      agent,
      providerName: workerProvider,
      resolvedModel: workerModel,
      traceId,
      maxIterations: resolvedMaxWorkerIterations,
      minContextLength: minContextLength || null,
    };

    activeWorkers.set(agentId, workerState);

    logger.info(`[Coordinator] Spawned worker ${agentId}: "${description}" → ${workerProvider} (model="${workerModel}") in ${worktreePath}${workerState.isolated ? " (isolated worktree)" : " (shared workspace)"}`);

    // Emit early so the frontend can show live status immediately
    // (before the blocking loop starts and before a result is available)
    if (coordinatorCtx.emit) {
      coordinatorCtx.emit({
        type: "worker_status",
        workerId: agentId,
        message: "spawned",
        description,
      });
    }
    // Run the worker loop — blocks until the worker completes.
    // When multiple team_create calls appear in the same model response,
    // the agentic loop's Promise.all executes them concurrently.
    try {
      await CoordinatorService._runWorkerLoop(workerState, prompt, coordinatorCtx);
    } catch (err) {
      logger.error(`[Coordinator] Worker ${agentId} loop error: ${err.message}`);
      workerState.status = "failed";
      workerState.error = err.message;
      workerState.durationMs = Date.now() - workerState.startedAt;

      // Clean up worktree on failure to prevent orphaned branches
      if (workerState.isolated && workerState.worktreePath) {
        await removeWorktree(workerState.repoPath, workerState.worktreePath).catch((e) =>
          logger.warn(`[Coordinator] Worktree cleanup failed for ${agentId}: ${e.message}`),
        );
      }

      // Notify frontend immediately so the StatusBar stops showing "Generating..."
      if (coordinatorCtx.emit) {
        coordinatorCtx.emit({
          type: "worker_status",
          workerId: agentId,
          message: "failed",
          error: err.message,
        });
      }
    }

    // Notify UI that worker state changed
    if (coordinatorCtx.emit) {
      coordinatorCtx.emit({ type: "status", message: "workers_updated" });
    }

    const workerResult = buildWorkerResult(workerState);
    logger.info(`[Coordinator] Worker ${agentId} result: status=${workerResult.status} toolUses=${workerResult.toolUses} durationMs=${workerResult.durationMs}`);
    return workerResult;
  }

  /**
   * Send a follow-up message to a running/idle worker.
   * @param {string} agentId
   * @param {string} message
   * @param {object} coordinatorCtx
   * @returns {Promise<object>}
   */
  static async sendMessage(agentId, message, coordinatorCtx) {
    const worker = activeWorkers.get(agentId);
    if (!worker) {
      return { error: `Worker "${agentId}" not found` };
    }

    if (worker.status === "running") {
      // Worker still running — queue the message
      if (!worker.pendingMessages) worker.pendingMessages = [];
      worker.pendingMessages.push(message);
      return { agent_id: agentId, status: "message_queued", message: "Worker is running. Follow-up queued." };
    }

    if (worker.status !== "complete" && worker.status !== "idle") {
      return { error: `Worker "${agentId}" is in "${worker.status}" state. Cannot send message.` };
    }

    // Re-activate the worker with the follow-up prompt
    worker.status = "running";
    worker.startedAt = Date.now();

    logger.info(`[Coordinator] Continuing worker ${agentId} with follow-up`);

    CoordinatorService._runWorkerLoop(worker, message, coordinatorCtx)
      .catch((err) => {
        logger.error(`[Coordinator] Worker ${agentId} continuation error: ${err.message}`);
        worker.status = "failed";
        worker.error = err.message;
      });

    return { agent_id: agentId, status: "running", message: "Worker continued with follow-up." };
  }

  /**
   * Stop a running worker and clean up its worktree.
   * @param {string} agentId
   * @returns {Promise<object>}
   */
  static async stopAgent(agentId) {
    const worker = activeWorkers.get(agentId);
    if (!worker) {
      return { error: `Worker "${agentId}" not found` };
    }

    // Abort the worker's loop
    if (worker.abortController) {
      worker.abortController.abort();
    }

    // Clean up worktree (only if worker was running in an isolated worktree)
    if (worker.isolated && worker.worktreePath) {
      await removeWorktree(worker.repoPath, worker.worktreePath);
      worker.worktreePath = null;
    }

    worker.status = "stopped";
    worker.durationMs = Date.now() - worker.startedAt;

    logger.info(`[Coordinator] Stopped worker ${agentId}`);

    return { agent_id: agentId, status: "stopped" };
  }

  /**
   * Read the output from a previously spawned worker agent.
   * Returns the full result if completed, or partial status if still running.
   * @param {string} agentId
   * @returns {object}
   */
  static getTaskOutput(agentId) {
    const worker = activeWorkers.get(agentId);
    if (!worker) {
      return { error: `Worker "${agentId}" not found. It may have been cleaned up.` };
    }

    if (worker.status === "running") {
      return {
        agent_id: agentId,
        description: worker.description,
        status: "running",
        partialOutput: (worker.output || "").slice(-2000) || null,
        toolUses: worker.toolCalls?.length || 0,
        iterations: worker.iterations || 0,
        durationMs: Date.now() - worker.startedAt,
        message: "Worker is still running. Partial output shown (last 2000 chars).",
      };
    }

    // Completed, failed, or stopped — return full result
    return buildWorkerResult(worker);
  }

  /**
   * Abort all running workers spawned under a given parent agent session.
   * Called when the coordinator's SSE connection is severed (user presses stop)
   * or explicitly via the REST endpoint.
   *
   * @param {string} parentAgentSessionId - The coordinator session ID
   * @returns {{ stopped: string[], alreadyStopped: string[] }}
   */
  static async abortWorkersBySession(parentAgentSessionId) {
    const stopped = [];
    const alreadyStopped = [];
    const cleanupPromises = [];

    for (const [agentId, worker] of activeWorkers) {
      if (worker.parentAgentSessionId !== parentAgentSessionId) continue;

      if (worker.status === "running") {
        if (worker.abortController) {
          worker.abortController.abort();
        }
        worker.status = "stopped";
        worker.durationMs = Date.now() - worker.startedAt;
        stopped.push(agentId);
        logger.info(`[Coordinator] Aborted worker ${agentId} (parent session stopped)`);

        // Queue worktree cleanup so orphaned worktrees don't accumulate
        if (worker.isolated && worker.worktreePath) {
          cleanupPromises.push(
            removeWorktree(worker.repoPath, worker.worktreePath)
              .then(() => { worker.worktreePath = null; })
              .catch((e) => logger.warn(`[Coordinator] Worktree cleanup failed for ${agentId}: ${e.message}`)),
          );
        }
      } else {
        alreadyStopped.push(agentId);
      }
    }

    // Clean up worktrees in parallel — non-blocking, best-effort
    if (cleanupPromises.length > 0) {
      await Promise.allSettled(cleanupPromises);
      logger.info(`[Coordinator] Cleaned up ${cleanupPromises.length} worktree(s) for session ${parentAgentSessionId}`);
    }

    if (stopped.length > 0) {
      logger.info(`[Coordinator] Bulk-aborted ${stopped.length} worker(s) for session ${parentAgentSessionId}`);
    }

    return { stopped, alreadyStopped };
  }

  /**
   * Get the status of a specific worker.
   * @param {string} agentId
   * @returns {object|null}
   */
  static getWorkerStatus(agentId) {
    const worker = activeWorkers.get(agentId);
    if (!worker) return null;
    return {
      agentId: worker.agentId,
      description: worker.description,
      status: worker.status,
      toolCallCount: worker.toolCalls?.length || 0,
      durationMs: worker.status === "running" ? Date.now() - worker.startedAt : worker.durationMs,
      diff: worker.diff,
      error: worker.error,
    };
  }

  /**
   * List all active workers spawned via chat tools.
   * @param {object} [options]
   * @param {string} [options.parentAgentSessionId] - Filter workers by parent coordinator session
   * @returns {Array}
   */
  static listWorkers({ parentAgentSessionId } = {}) {
    let workers = Array.from(activeWorkers.values());
    if (parentAgentSessionId) {
      workers = workers.filter((w) => w.parentAgentSessionId === parentAgentSessionId);
    }
    return workers.map((w) => ({
      agentId: w.agentId,
      workerAgentSessionId: w.workerAgentSessionId,
      parentAgentSessionId: w.parentAgentSessionId,
      description: w.description,
      status: w.status,
      branchName: w.branchName,
      toolCallCount: w.toolCalls?.length || 0,
      durationMs: w.status === "running" ? Date.now() - w.startedAt : w.durationMs,
      totalCost: w.totalCost || null,
      usage: w.usage || null,
      traceId: w.traceId,
      providerName: w.providerName,
      resolvedModel: w.resolvedModel,
      files: w.files,
      startedAt: w.startedAt,
    }));
  }

  // ══════════════════════════════════════════════════════════
  // Team Management (team_create / team_delete)
  // ══════════════════════════════════════════════════════════

  /** Active teams — keyed by team name, value is { agentIds: string[] } */
  static _activeTeams = new Map();

  /**
   * Create a named team of parallel worker agents.
   * Each member is spawned via spawnFromTool and runs concurrently.
   * Returns aggregated results from all members when they all complete.
   *
   * @param {object} args
   * @param {string} args.name - Team name
   * @param {Array} args.members - [{ description, prompt, files?, model? }]
   * @param {object} coordinatorCtx - Coordinator loop context
   * @returns {Promise<object>}
   */
  static async createTeam(args, coordinatorCtx) {
    const { name, members } = args;
    const { providerName, resolvedModel } = coordinatorCtx;

    if (!name || typeof name !== "string") {
      return { error: "'name' is required (string)" };
    }
    if (!Array.isArray(members) || members.length === 0) {
      return { error: "'members' must be a non-empty array" };
    }
    if (members.length > MAX_WORKERS) {
      return { error: `Maximum ${MAX_WORKERS} team members. Received ${members.length}.` };
    }
    if (CoordinatorService._activeTeams.has(name)) {
      return { error: `Team "${name}" already exists. Delete it first or use a different name.` };
    }

    logger.info(`[Coordinator] Creating team "${name}" with ${members.length} member(s)`);

    // ── Pre-assign instances serially to prevent race conditions ──
    // When team_create fires N spawnFromTool calls via Promise.allSettled,
    // each one does async model-availability checks before reaching the
    // synchronous reservation increment — so they all see 0 reservations
    // and pick the same instance. Fix: resolve model availability once,
    // then assign instances in a serial loop with synchronous increments.
    const assignments = []; // { provider, model } per member

    if (localModelQueue.isLocal(providerName)) {
      const providerType = getInstanceType(providerName) || providerName;
      let siblings = getInstancesByType(providerType);

      logger.info(`[Coordinator] Team "${name}": providerName=${providerName}, providerType=${providerType}, siblings=${siblings.length} [${siblings.map((s) => `${s.id}(c=${s.concurrency})`).join(", ")}]`);

      // Run model availability checks once for the entire team
      const defaultModel = resolvedModel;
      /** @type {Map<string, string>} */
      const instanceModelOverrides = new Map();

      if (siblings.length > 1) {
        try {
          const checks = await Promise.allSettled(
            siblings.map(async (inst) => {
              const provider = getProvider(inst.id);
              if (!provider?.listModels) return { exact: false, fallback: null };
              const result = await Promise.race([
                provider.listModels(),
                new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
              ]);
              const models = result?.models || result?.data || [];
              const exactMatch = models.some((m) => (m.key || m.id) === defaultModel);
              if (exactMatch) return { exact: true, fallback: null };

              // No exact key match — find the best variant with the same base name
              const fallback = findBestQuantFallback(defaultModel, models);
              return { exact: false, fallback };
            }),
          );

          // Build per-instance model map — never filter siblings, just set overrides.
          // Instances with exact match: no override needed (uses defaultModel).
          // Instances with variant match: override to the variant key.
          // Instances with neither: excluded from pool.
          const usable = [];
          for (let i = 0; i < siblings.length; i++) {
            if (checks[i].status !== "fulfilled") continue;
            const { exact, fallback } = checks[i].value;

            if (exact) {
              usable.push(siblings[i]);
            } else if (fallback) {
              instanceModelOverrides.set(siblings[i].id, fallback);
              usable.push(siblings[i]);
            }
            // else: instance has no matching model — skip it
          }

          // Log the resolution summary
          const summary = usable.map((s) => {
            const override = instanceModelOverrides.get(s.id);
            return override ? `${s.id}→"${override}"` : `${s.id} (exact)`;
          }).join(", ");
          logger.info(`[Coordinator] Model resolution for "${defaultModel}": ${usable.length}/${siblings.length} instances usable [${summary}]`);

          if (usable.length > 0) {
            siblings = usable;
          } else {
            logger.warn(`[Coordinator] Model "${defaultModel}" not available on any ${providerType} instance`);
            siblings = [];
          }
        } catch (err) {
          logger.warn(`[Coordinator] Model availability check failed: ${err.message}`);
        }
      }

      // Assign instances serially — each selectAndReserveInstance call
      // increments the reservation counter synchronously, so the next
      // member sees the updated count.
      const workerFallback = await getWorkerFallback();
      for (let i = 0; i < members.length; i++) {
        // For local providers, always use the coordinator's model — the LLM
        // can't know valid GGUF identifiers and will hallucinate names.
        // member.model overrides only work for cloud providers with well-known names.
        const memberModel = defaultModel;
        const assigned = selectAndReserveInstance(siblings, providerName, instanceModelOverrides, memberModel);

        if (assigned) {
          assignments.push({ provider: assigned.provider, model: assigned.model });
          logger.info(
            `[Coordinator] Team "${name}" member ${i}: assigned to ${assigned.provider} (${assigned.slotsAvailable} slots free) — model "${assigned.model}"`,
          );
        } else if (workerFallback) {
          assignments.push({ provider: workerFallback.provider, model: workerFallback.model });
          logger.info(`[Coordinator] Team "${name}" member ${i}: all instances full — using ${workerFallback.model}`);
        } else {
          // No slots and no cloud fallback — will queue on local provider
          assignments.push({ provider: null, model: null });
          logger.info(`[Coordinator] Team "${name}" member ${i}: all instances full — will queue on local provider`);
        }
      }
    }

    // Spawn all members in parallel — with pre-assigned instances
    const results = await Promise.allSettled(
      members.map((member, i) =>
        CoordinatorService.spawnFromTool({
          description: `[${name}] ${member.description}`,
          prompt: member.prompt,
          files: member.files,
          // For local providers, don't pass the LLM's model — the pre-assignment
          // already resolved the correct GGUF model identifier.
          model: localModelQueue.isLocal(providerName) ? undefined : member.model,
          assignedProvider: assignments[i]?.provider || undefined,
          assignedModel: assignments[i]?.model || undefined,
          coordinatorCtx,
        }),
      ),
    );

    // Collect agentIds and results
    const memberResults = results.map((r, i) => {
      if (r.status === "fulfilled") {
        return {
          index: i,
          description: members[i].description,
          ...r.value,
        };
      }
      return {
        index: i,
        description: members[i].description,
        status: "failed",
        error: r.reason?.message || "Unknown error",
      };
    });

    // Track team membership
    const agentIds = memberResults
      .filter((m) => m.agent_id)
      .map((m) => m.agent_id);

    CoordinatorService._activeTeams.set(name, {
      agentIds,
      createdAt: Date.now(),
    });

    const succeeded = memberResults.filter((m) => m.status === "completed" || m.agent_id).length;
    const failed = memberResults.length - succeeded;

    logger.info(`[Coordinator] Team "${name}" created: ${succeeded} succeeded, ${failed} failed`);

    return {
      team: name,
      totalMembers: members.length,
      succeeded,
      failed,
      members: memberResults,
    };
  }

  /**
   * Stop and remove all workers in a named team.
   * @param {string} teamName
   * @returns {Promise<object>}
   */
  static async deleteTeam(teamName) {
    if (!teamName || typeof teamName !== "string") {
      return { error: "'teamName' is required (string)" };
    }

    const team = CoordinatorService._activeTeams.get(teamName);
    if (!team) {
      return { error: `Team "${teamName}" not found` };
    }

    const stopResults = await Promise.allSettled(
      team.agentIds.map((agentId) => CoordinatorService.stopAgent(agentId)),
    );

    CoordinatorService._activeTeams.delete(teamName);

    const stopped = stopResults.filter(
      (r) => r.status === "fulfilled" && r.value?.status === "stopped",
    ).length;

    logger.info(`[Coordinator] Team "${teamName}" deleted: ${stopped}/${team.agentIds.length} stopped`);

    return {
      team: teamName,
      deleted: true,
      stopped,
      total: team.agentIds.length,
    };
  }

  // ──────────────────────────────────────────────────────────
  // Worker Execution Engine
  // ──────────────────────────────────────────────────────────

  /**
   * Run the worker's agentic loop in its isolated worktree.
   * @private
   */
  static async _runWorkerLoop(worker, prompt, coordinatorCtx) {
    const { default: AgenticLoopService } = await import("./AgenticLoopService.js");

    // Build the worker's initial messages
    const commitInstructions = worker.isolated
      ? `- Commit your changes when done and report what you accomplished`
      : `- Report what you accomplished when done`;
    const workerMessages = [
      ...worker.messages,
      {
        role: "user",
        content: `You are a worker agent in a multi-agent coding system.\n\n` +
          `Your workspace is: ${worker.worktreePath}\n` +
          (worker.files?.length ? `Focus on files: ${worker.files.join(", ")}\n` : "") +
          `\nTask:\n${prompt}\n\n` +
          `Important:\n` +
          `- Only modify files within your workspace\n` +
          `${commitInstructions}\n` +
          `- Focus on the specific task described above`,
      },
    ];

    // Capture worker output AND forward tool events to the parent coordinator's
    // SSE stream. This lets the frontend display live worker tool activity
    // without polling — events arrive as `worker_tool_execution`, `worker_tool_output`,
    // and `worker_status` with the worker's agentId for disambiguation.
    const parentEmit = coordinatorCtx.emit;
    let workerOutput = "";
    const workerToolCalls = [];
    let lastWorkerPhase = null;
    let workerChunkCount = 0;
    let workerFirstChunkTime = null;
    let workerLastChunkTime = null;
    const WORKER_PROGRESS_INTERVAL = 10; // emit progress every N chunks
    const workerEmit = (event) => {
      if (event.type === "chunk") {
        workerOutput += event.content || "";
        workerChunkCount++;
        // Use Date.now() (not performance.now()) since these timestamps
        // cross process boundaries — the frontend needs wall-clock time
        // to compute staleness and elapsed generation time correctly.
        if (!workerFirstChunkTime) workerFirstChunkTime = Date.now();
        workerLastChunkTime = Date.now();
        // Notify the frontend that the worker is actively generating text
        if (parentEmit && lastWorkerPhase !== "generating") {
          lastWorkerPhase = "generating";
          parentEmit({
            type: "worker_status",
            workerId: worker.agentId,
            message: "phase",
            phase: "generating",
          });
        }
        // Emit generation progress — first chunk immediately (so tok/s badge
        // appears right away), then at regular intervals for smooth updates
        const shouldEmit = workerChunkCount === 1
          || workerChunkCount % WORKER_PROGRESS_INTERVAL === 0;
        if (parentEmit && shouldEmit) {
          parentEmit({
            type: "worker_status",
            workerId: worker.agentId,
            message: "generation_progress",
            outputTokens: workerChunkCount,
            firstChunkTime: workerFirstChunkTime,
            lastChunkTime: workerLastChunkTime,
          });
        }
      } else if (event.type === "thinking") {
        // Emit final generation_progress for the burst that just ended
        // so the frontend gets tok/s data even for short generation runs
        if (parentEmit && lastWorkerPhase === "generating" && workerChunkCount > 0) {
          parentEmit({
            type: "worker_status",
            workerId: worker.agentId,
            message: "generation_progress",
            outputTokens: workerChunkCount,
            firstChunkTime: workerFirstChunkTime,
            lastChunkTime: workerLastChunkTime,
          });
        }
        // Notify the frontend that the worker is in the thinking phase
        if (parentEmit && lastWorkerPhase !== "thinking") {
          lastWorkerPhase = "thinking";
          parentEmit({
            type: "worker_status",
            workerId: worker.agentId,
            message: "phase",
            phase: "thinking",
          });
        }
      } else if (event.type === "tool_execution") {
        if (event.status === "calling") {
          workerToolCalls.push({ name: event.tool?.name, args: event.tool?.args });
        }
        // Emit final generation_progress before tool execution pauses generation
        if (parentEmit && lastWorkerPhase === "generating" && workerChunkCount > 0) {
          parentEmit({
            type: "worker_status",
            workerId: worker.agentId,
            message: "generation_progress",
            outputTokens: workerChunkCount,
            firstChunkTime: workerFirstChunkTime,
            lastChunkTime: workerLastChunkTime,
          });
        }
        // Reset phase so post-tool generation fires a fresh "generating" event
        lastWorkerPhase = null;
        // Forward to parent SSE stream — namespaced so the frontend can
        // distinguish worker tool calls from the coordinator's own
        if (parentEmit) {
          parentEmit({
            type: "worker_tool_execution",
            workerId: worker.agentId,
            workerDescription: worker.description,
            tool: event.tool,
            status: event.status,
          });
        }
      } else if (event.type === "tool_output") {
        // Forward streaming tool output (shell, python, etc.)
        if (parentEmit) {
          parentEmit({
            type: "worker_tool_output",
            workerId: worker.agentId,
            toolCallId: event.toolCallId,
            name: event.name,
            event: event.event,
            data: event.data,
          });
        }
      } else if (event.type === "status") {
        // Forward iteration progress and notable status updates
        if (parentEmit && (event.message === "iteration_progress" || event.message === "workers_updated")) {
          if (event.iteration) worker.iterations = event.iteration;
          parentEmit({
            type: "worker_status",
            workerId: worker.agentId,
            message: event.message,
            iteration: event.iteration,
            maxIterations: event.maxIterations,
          });
        }
        // Forward LM Studio lifecycle phases (loading, processing, generating)
        if (parentEmit && event.phase) {
          lastWorkerPhase = event.phase;
          parentEmit({
            type: "worker_status",
            workerId: worker.agentId,
            message: "phase",
            phase: event.phase,
          });
        }
      } else if (event.type === "done") {
        // Capture cost and usage from finalizeTextGeneration
        worker.totalCost = event.estimatedCost || null;
        worker.usage = event.usage || null;
      }
    };

    // Build enabled tools list for the worker.
    // If the parent agent has a persona with scoped tools (e.g. Lupos),
    // let AgenticLoopService resolve enabledTools from the persona — don't
    // override with all tools. For coding agents (no persona), build the
    // full list minus coordinator-only tools.
    let workerEnabledTools;
    if (worker.agent) {
      const { default: AgentPersonaRegistry } = await import("./AgentPersonaRegistry.js");
      const persona = AgentPersonaRegistry.get(worker.agent);
      if (persona?.enabledTools) {
        // Inherit the parent's persona-scoped tools
        workerEnabledTools = persona.enabledTools;
      }
    }

    if (!workerEnabledTools) {
      // Default: all tools minus coordinator-only (for coding agents)
      const allSchemas = ToolOrchestratorService.getToolSchemas();
      const coordinatorSet = new Set(COORDINATOR_ONLY_TOOLS);
      workerEnabledTools = allSchemas
        .map((t) => t.name)
        .filter((name) => !coordinatorSet.has(name));
    }

    const workerProvider = getProvider(worker.providerName);
    const { getModelByName } = await import("../config.js");
    const workerModelDef = getModelByName(worker.resolvedModel);

    try {
      await AgenticLoopService.runAgenticLoop({
        provider: workerProvider,
        providerName: worker.providerName,
        resolvedModel: worker.resolvedModel,
        modelDef: workerModelDef,
        messages: workerMessages,
        options: {
          autoApprove: true,
          agenticLoopEnabled: true,
          enabledTools: workerEnabledTools,
          maxIterations: worker.maxIterations,
          maxTokens: 8192,
          ...(worker.minContextLength && { minContextLength: worker.minContextLength }),
        },
        agentSessionId: worker.workerAgentSessionId,
        parentAgentSessionId: worker.parentAgentSessionId,
        traceId: worker.traceId,
        project: worker.project,
        username: worker.username,
        agent: worker.agent,
        requestStart: performance.now(),
        emit: workerEmit,
        signal: worker.abortController.signal,
      });
    } catch (err) {
      if (err.name === "AbortError" || worker.abortController.signal.aborted) {
        worker.status = "stopped";
      } else {
        throw err;
      }
    }

    // Always populate — including on abort/error paths
    worker.output = getLastAssistantText(workerMessages) || workerOutput;
    worker.toolCalls = workerToolCalls;
    worker.messages = workerMessages;
    worker.durationMs = Date.now() - worker.startedAt;

    // Stage and commit changes in the worktree
    await toolsApiPost("/agentic/command/run", {
      command: "git add -A",
      cwd: worker.worktreePath,
    });
    await toolsApiPost("/agentic/command/run", {
      command: `git commit -m "coordinator: ${worker.agentId} — ${worker.description}" --allow-empty`,
      cwd: worker.worktreePath,
    });

    // Collect diff
    const diffResult = await getWorktreeDiff(worker.repoPath, worker.branchName);
    worker.diff = diffResult.error ? null : diffResult;
    worker.status = "complete";

    // Remove worktree now that the diff has been collected — prevents orphaned
    // worktrees from accumulating on disk across sessions.
    if (worker.isolated && worker.worktreePath) {
      await removeWorktree(worker.repoPath, worker.worktreePath).catch((e) =>
        logger.warn(`[Coordinator] Post-completion worktree cleanup failed for ${worker.agentId}: ${e.message}`),
      );
    }

    // Notify frontend immediately so the per-worker StatusBar updates
    // from "Generating..." to a completed state. Each worker finishes
    // independently — can't wait for the parent's `workers_updated` event.
    if (parentEmit) {
      parentEmit({
        type: "worker_status",
        workerId: worker.agentId,
        message: "complete",
        durationMs: worker.durationMs,
        toolCount: workerToolCalls.length,
        // Include usage telemetry so the frontend can update token badges
        // in real-time as each worker finishes, without waiting for the
        // full backendSessionStats fetch at coordinator completion.
        usage: worker.usage || null,
        estimatedCost: worker.totalCost || null,
      });
    }

    // Release the per-instance reservation (synchronous counter)
    const currentRes = instanceReservations.get(worker.providerName) || 0;
    if (currentRes > 0) instanceReservations.set(worker.providerName, currentRes - 1);

    logger.info(
      `[Coordinator] Agent ${worker.agentId} completed in ${worker.durationMs}ms (${workerToolCalls.length} tool calls)`,
    );

    // ── VRAM eviction for secondary instances ──────────────────
    // When a worker finishes on a secondary LM Studio instance (not the
    // coordinator's own), check if any other workers are still active on
    // that instance. If none, unload the model to free GPU VRAM.
    // This prevents idle secondary GPUs from holding 14+ GB of model weights.
    // The primary instance is NEVER unloaded (orchestrator needs it).
    const workerInstanceId = worker.providerName;
    const coordinatorInstanceId = coordinatorCtx.providerName;
    if (workerInstanceId !== coordinatorInstanceId) {
      const othersOnSameInstance = [...activeWorkers.values()].filter(
        (w) => w.providerName === workerInstanceId && w.agentId !== worker.agentId && w.status === "running",
      );
      if (othersOnSameInstance.length === 0) {
        try {
          const workerProviderObj = getProvider(workerInstanceId);
          if (workerProviderObj?.unloadModelByKey) {
            logger.info(
              `[Coordinator] VRAM eviction: unloading "${worker.resolvedModel}" from secondary instance ${workerInstanceId} (no active workers remain)`,
            );
            await workerProviderObj.unloadModelByKey(worker.resolvedModel).catch((e) =>
              logger.warn(`[Coordinator] VRAM eviction failed on ${workerInstanceId}: ${e.message}`),
            );
          }
        } catch (e) {
          logger.warn(`[Coordinator] VRAM eviction error: ${e.message}`);
        }
      } else {
        logger.info(
          `[Coordinator] VRAM eviction deferred: ${othersOnSameInstance.length} worker(s) still active on ${workerInstanceId}`,
        );
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // Manual Panel Flow (decompose → execute → approve)
  // ══════════════════════════════════════════════════════════

  /**
   * Decompose a task into parallel sub-tasks using LLM.
   *
   * @param {object} params
   * @param {string} params.task - The refactoring task description
   * @param {string[]} params.files - Target file paths
   * @param {string} [params.repoPath] - Repository root path
   * @returns {Promise<object>} Decomposed plan with sub-tasks
   */
  static async decompose({ task, files, repoPath, endpoint, agentSessionId }) {
    const provider = getProvider(DECOMPOSITION_PROVIDER);

    const userMessage = `Task: ${task}\n\nTarget files:\n${files.map((f) => `- ${f}`).join("\n")}`;

    const messages = [
      { role: "system", content: DECOMPOSITION_PROMPT },
      { role: "user", content: userMessage },
    ];

    const requestId = crypto.randomUUID();
    const requestStart = performance.now();
    let llmSuccess = true;
    let llmError = null;

    const result = await provider.generateText(messages, DECOMPOSITION_MODEL, {
      maxTokens: 2000,
      temperature: 0.2,
    }).catch((err) => {
      llmSuccess = false;
      llmError = err.message;
      throw err;
    });

    // Log the decomposition LLM call
    {
      const llmTotalSec = (performance.now() - requestStart) / 1000;
      const inputText = messages.map((m) => m.content).join("\n");
      const approxInputTokens = estimateTokens(inputText);
      const approxOutputTokens = result ? estimateTokens(result.text || "") : 0;
      const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[DECOMPOSITION_MODEL];
      let estimatedCost = null;
      if (pricing) {
        estimatedCost = calculateTextCost(
          { inputTokens: approxInputTokens, outputTokens: approxOutputTokens },
          pricing,
        );
      }

      RequestLogger.log({
        requestId,
        endpoint: endpoint || "/coordinator/plan",
        operation: "coordinator:decompose",
        project: null,
        username: "system",
        clientIp: null,
        provider: DECOMPOSITION_PROVIDER,
        model: DECOMPOSITION_MODEL,
        success: llmSuccess,
        errorMessage: llmError,
        agentSessionId: agentSessionId || null,
        estimatedCost,
        inputTokens: approxInputTokens,
        outputTokens: approxOutputTokens,
        tokensPerSec: calculateTokensPerSec(approxOutputTokens, llmTotalSec),
        inputCharacters: inputText.length,
        totalTime: roundMs(llmTotalSec),
        modalities: { textIn: true, textOut: true },
        requestPayload: {
          operation: "coordinator:decompose",
          task: task.slice(0, 200),
          fileCount: files.length,
        },
        responsePayload: llmSuccess
          ? { textPreview: (result?.text || "").slice(0, 200) }
          : { error: llmError },
      });
    }

    let parsed;
    try {
      let jsonText = (result.text || "").trim();
      const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonText = jsonMatch[1].trim();
      parsed = JSON.parse(jsonText);
    } catch {
      return { error: "Failed to parse decomposition result", raw: result.text };
    }

    // Validate and cap sub-tasks
    const subTasks = (parsed.subTasks || []).slice(0, MAX_WORKERS);
    for (const st of subTasks) {
      if (!st.id) st.id = `task-${crypto.randomUUID().slice(0, 8)}`;
      st.branchName = `coordinator/${st.id}`;
    }

    return {
      taskId: crypto.randomUUID(),
      task,
      repoPath: repoPath || getDefaultWorkspaceRoot(),
      subTasks,
      summary: parsed.summary || `Decomposed into ${subTasks.length} sub-tasks`,
      status: "planned",
    };
  }

  /**
   * Execute an approved plan — spawn workers in git worktrees.
   *
   * @param {object} plan - The approved plan from decompose()
   * @param {object} [options]
   * @param {string} [options.provider] - LLM provider for workers
   * @param {string} [options.model] - LLM model for workers
   * @param {string} [options.project] - Project identifier
   * @param {string} [options.username] - Username
   * @param {Function} [options.onProgress] - Progress callback (taskId, workers)
   * @returns {Promise<object>} Execution results with diffs
   */
  static async execute(plan, options = {}) {
    const { taskId, subTasks, repoPath } = plan;

    if (activeTasks.has(taskId)) {
      return { error: "Task is already executing" };
    }

    const taskState = {
      taskId,
      status: "executing",
      repoPath,
      workers: subTasks.map((st) => ({
        id: st.id,
        files: st.files,
        instruction: st.instruction,
        branchName: st.branchName,
        worktreePath: null,
        status: "pending",
        error: null,
        diff: null,
      })),
      startedAt: new Date().toISOString(),
    };

    activeTasks.set(taskId, taskState);

    try {
      // Phase 1: Create all worktrees
      logger.info(`[Coordinator] Creating ${subTasks.length} worktrees for task ${taskId}`);

      for (const worker of taskState.workers) {
        const result = await createWorktree(repoPath, worker.branchName);
        if (result.error) {
          worker.status = "error";
          worker.error = `Worktree creation failed: ${result.error}`;
          logger.error(`[Coordinator] Worker ${worker.id} worktree failed: ${result.error}`);
          continue;
        }
        worker.worktreePath = result.worktreePath;
        worker.status = "ready";
      }

      // Phase 2: Execute workers in parallel
      const readyWorkers = taskState.workers.filter((w) => w.status === "ready");
      logger.info(`[Coordinator] Running ${readyWorkers.length} workers in parallel`);

      const workerPromises = readyWorkers.map((worker) =>
        CoordinatorService._runPanelWorker(worker, {
          repoPath,
          provider: options.provider,
          model: options.model,
          project: options.project,
          username: options.username,
          onProgress: (update) => {
            Object.assign(worker, update);
            options.onProgress?.(taskId, taskState.workers);
          },
        }),
      );

      await Promise.allSettled(workerPromises);

      // Phase 3: Collect diffs from completed workers
      const completedWorkers = taskState.workers.filter((w) => w.status === "complete");
      logger.info(`[Coordinator] ${completedWorkers.length}/${taskState.workers.length} workers completed`);

      for (const worker of completedWorkers) {
        const diffResult = await getWorktreeDiff(repoPath, worker.branchName);
        if (diffResult.error) {
          worker.diff = null;
          worker.error = `Diff retrieval failed: ${diffResult.error}`;
        } else {
          worker.diff = diffResult;
        }
      }

      taskState.status = "review";
      options.onProgress?.(taskId, taskState.workers);

      return {
        taskId,
        status: "review",
        workers: taskState.workers,
        completedCount: completedWorkers.length,
        totalCount: taskState.workers.length,
      };
    } catch (err) {
      taskState.status = "error";
      logger.error(`[Coordinator] Task ${taskId} failed: ${err.message}`);
      return { error: err.message, taskId };
    }
  }

  /**
   * Run a single worker agent in a worktree (manual panel flow).
   * @private
   */
  static async _runPanelWorker(worker, { repoPath: _repoPath, provider: providerName, model, project, username, onProgress }) {
    worker.status = "running";
    onProgress?.({ status: "running" });

    try {
      const { default: AgenticLoopService } = await import("./AgenticLoopService.js");

      const workerMessages = [
        {
          role: "user",
          content: `You are a worker agent in a multi-agent refactoring task.\n\n` +
            `Your workspace is: ${worker.worktreePath}\n` +
            `You are working on files: ${worker.files.join(", ")}\n\n` +
            `Task:\n${worker.instruction}\n\n` +
            `Important:\n` +
            `- Only modify files within your workspace\n` +
            `- Commit your changes when done and report what you accomplished\n` +
            `- Focus on the specific task described above`,
        },
      ];

      let workerOutput = "";
      const workerToolCalls = [];
      const workerEmit = (event) => {
        if (event.type === "chunk") {
          workerOutput += event.content || "";
        } else if (event.type === "tool_execution" && event.status === "calling") {
          workerToolCalls.push({ name: event.tool?.name, args: event.tool?.args });
        }
        onProgress?.({ toolCallCount: workerToolCalls.length });
      };

      // Build enabled tools — exclude coordinator tools
      const allSchemas = ToolOrchestratorService.getToolSchemas();
      const coordinatorSet = new Set(COORDINATOR_ONLY_TOOLS);
      const workerEnabledTools = allSchemas
        .map((t) => t.name)
        .filter((name) => !coordinatorSet.has(name));

      let resolvedProviderName = providerName || DECOMPOSITION_PROVIDER;
      let resolvedModel = model || DECOMPOSITION_MODEL;

      // Local model guard with instance pooling — same logic as spawnFromTool:
      // distribute workers across all instances of the same type.
      if (localModelQueue.isLocal(resolvedProviderName)) {
        const providerType = getInstanceType(resolvedProviderName) || resolvedProviderName;
        const siblings = getInstancesByType(providerType);
        const totalSlots = siblings.reduce((sum, inst) => sum + inst.concurrency, 0);

        if (totalSlots <= 1) {
          const panelFallback = await getWorkerFallback();
          if (panelFallback) {
            logger.info(`[Coordinator] Panel worker ${worker.id}: single-slot concurrency → falling back to ${panelFallback.model}`);
            resolvedProviderName = panelFallback.provider;
            resolvedModel = panelFallback.model;
          } else {
            logger.info(`[Coordinator] Panel worker ${worker.id}: single-slot concurrency, no subagent model configured — queuing on local provider`);
          }
        } else {
          // Find least-busy instance
          let bestInstance = null;
          let bestAvailable = -1;
          for (const inst of siblings) {
            const active = localModelQueue._getQueue(inst.id).activeCount;
            const available = inst.concurrency - active;
            if (available > bestAvailable) {
              bestAvailable = available;
              bestInstance = inst;
            }
          }
          if (bestInstance) {
            resolvedProviderName = bestInstance.id;
            logger.info(`[Coordinator] Panel worker ${worker.id}: assigned to ${bestInstance.id} (${siblings.length} instance${siblings.length > 1 ? "s" : ""} pooled, ${totalSlots} total slots) — model "${resolvedModel}"`);
          }
        }
      }

      const workerProvider = getProvider(resolvedProviderName);
      const { getModelByName } = await import("../config.js");
      const workerModelDef = getModelByName(resolvedModel);

      const abortController = createAbortController();
      worker.abortController = abortController;

      await AgenticLoopService.runAgenticLoop({
        provider: workerProvider,
        providerName: resolvedProviderName,
        resolvedModel,
        modelDef: workerModelDef,
        messages: workerMessages,
        options: {
          autoApprove: true,
          agenticLoopEnabled: true,
          enabledTools: workerEnabledTools,
          maxIterations: MAX_WORKER_ITERATIONS,
          maxTokens: 8192,
        },
        agentSessionId: `panel-worker-${worker.id}`,
        project: project || null,
        username: username || "system",
        requestStart: performance.now(),
        emit: workerEmit,
        signal: abortController.signal,
      });

      // Stage and commit changes
      await toolsApiPost("/agentic/command/run", {
        command: "git add -A",
        cwd: worker.worktreePath,
      });
      await toolsApiPost("/agentic/command/run", {
        command: `git commit -m "coordinator: ${worker.id}" --allow-empty`,
        cwd: worker.worktreePath,
      });

      worker.status = "complete";
      worker.toolCalls = workerToolCalls;
      worker.output = workerOutput;
      onProgress?.({ status: "complete" });

      logger.info(`[Coordinator] Panel worker ${worker.id} completed (${workerToolCalls.length} tool calls)`);
    } catch (err) {
      worker.status = "error";
      worker.error = err.message;
      onProgress?.({ status: "error", error: err.message });
      logger.error(`[Coordinator] Panel worker ${worker.id} failed: ${err.message}`);
    }
  }

  /**
   * Approve and merge all completed worker branches.
   *
   * @param {string} taskId
   * @returns {Promise<object>}
   */
  static async approveMerge(taskId) {
    const task = activeTasks.get(taskId);
    if (!task) return { error: "Task not found" };
    if (task.status !== "review") return { error: `Task is in '${task.status}' state, not 'review'` };

    const completedWorkers = task.workers.filter((w) => w.status === "complete" && w.diff?.hasChanges);
    const results = [];

    for (const worker of completedWorkers) {
      const mergeResult = await mergeWorktree(
        task.repoPath || getDefaultWorkspaceRoot(),
        worker.branchName,
        `[coordinator] ${worker.id}: ${worker.instruction.slice(0, 80)}`,
      );

      results.push({
        workerId: worker.id,
        merged: !mergeResult.error,
        error: mergeResult.error || null,
      });
    }

    // Cleanup all worktrees
    await CoordinatorService.cleanup(taskId);

    task.status = "merged";
    return { taskId, merged: results };
  }

  /**
   * Abort a running task — kill workers and clean up worktrees.
   *
   * @param {string} taskId
   * @returns {Promise<object>}
   */
  static async abort(taskId) {
    const task = activeTasks.get(taskId);
    if (!task) return { error: "Task not found" };

    // Abort running workers
    for (const worker of task.workers) {
      if (worker.abortController) {
        worker.abortController.abort();
      }
    }

    // Release any held mutation locks
    mutationQueue.releaseAll();

    // Cleanup worktrees
    await CoordinatorService.cleanup(taskId);

    task.status = "aborted";
    activeTasks.delete(taskId);

    return { taskId, status: "aborted" };
  }

  /**
   * Clean up worktrees for a task.
   * @private
   */
  static async cleanup(taskId) {
    const task = activeTasks.get(taskId);
    if (!task) return;

    const repoPath = task.repoPath || getDefaultWorkspaceRoot();

    for (const worker of task.workers) {
      if (worker.worktreePath) {
        await removeWorktree(repoPath, worker.worktreePath);
        worker.worktreePath = null;
      }
    }

    // Prune stale worktree references
    await cleanupWorktrees(repoPath);
  }

  /**
   * Get the current status of a coordinator task.
   *
   * @param {string} taskId
   * @returns {object|null}
   */
  static getStatus(taskId) {
    return activeTasks.get(taskId) || null;
  }

  /**
   * List all active coordinator tasks.
   * @returns {Array}
   */
  static listTasks() {
    return Array.from(activeTasks.values()).map((t) => ({
      taskId: t.taskId,
      status: t.status,
      workerCount: t.workers.length,
      startedAt: t.startedAt,
    }));
  }
}

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
import localModelQueue from "./LocalModelQueue.js";
import ToolOrchestratorService from "./ToolOrchestratorService.js";
import { COORDINATOR_ONLY_TOOLS } from "./CoordinatorPrompt.js";
import SettingsService from "./SettingsService.js";

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
//      Called when the LLM invokes spawn_agent / send_message / stop_agent
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

/** Active workers spawned via chat tools, keyed by agentId */
const activeWorkers = new Map();

/** Counter for generating sequential agent IDs */
let agentCounter = 0;

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
// Task Notification (XML format, matching Claude Code's design)
// ────────────────────────────────────────────────────────────
// Structured XML gives the coordinator consistent, machine-parseable
// boundaries. The <task-notification> opening tag lets both the system
// prompt and the frontend reliably distinguish worker results from
// real user messages.

function buildTaskNotification(worker) {
  const status = worker.status === "complete" ? "completed" : worker.status;
  const summary = status === "completed"
    ? `Agent "${worker.description}" completed`
    : status === "failed"
      ? `Agent "${worker.description}" failed: ${worker.error || "Unknown error"}`
      : `Agent "${worker.description}" was stopped`;

  const resultSection = (worker.output || "").trim().slice(0, 4000);
  const toolUseCount = worker.toolCalls?.length || 0;
  const durationMs = worker.durationMs || 0;

  let diffSection = "";
  if (worker.diff?.hasChanges) {
    diffSection = `\n<diff>+${worker.diff.additions || 0} -${worker.diff.deletions || 0} in ${(worker.diff.files || []).join(", ")}</diff>`;
  }

  return `<task-notification>
<task-id>${worker.agentId}</task-id>
<status>${status}</status>
<summary>${summary}</summary>${resultSection ? `\n<result>${resultSection}</result>` : ""}
<usage><tool_uses>${toolUseCount}</tool_uses><duration_ms>${durationMs}</duration_ms></usage>${diffSection}
</task-notification>`;
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
  // Chat-Triggered Tools (spawn_agent / send_message / stop_agent)
  // ══════════════════════════════════════════════════════════

  /**
   * Spawn a worker agent from a spawn_agent tool call.
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
   * @param {object} params.coordinatorCtx - Coordinator's loop context
   * @returns {Promise<object>} Spawn result with agentId
   */
  static async spawnFromTool({ description, prompt, files, model, coordinatorCtx }) {
    const { project, username, agent, providerName, resolvedModel, traceId, agentSessionId: parentAgentSessionId } = coordinatorCtx;

    // Check concurrency limit
    const runningCount = Array.from(activeWorkers.values()).filter((w) => w.status === "running").length;
    if (runningCount >= MAX_WORKERS) {
      return { error: `Maximum concurrent workers (${MAX_WORKERS}) reached. Wait for a worker to complete or stop one.` };
    }

    // Resolve the user-configured (or hardcoded) subagent fallback
    const workerFallback = await getWorkerFallback();

    // ── Local model guard with instance pooling ────────────────
    // When the coordinator is on a local provider, distribute workers
    // across ALL instances of the same type (e.g. lm-studio, lm-studio-2).
    // Reserve 1 slot on the coordinator's own instance, then fill workers
    // round-robin on the least-busy instances. If all local slots are full,
    // fall back to a cloud model.
    let workerProvider = providerName;
    let workerModel = model || resolvedModel;
    if (localModelQueue.isLocal(providerName)) {
      const providerType = getInstanceType(providerName) || providerName;
      const siblings = getInstancesByType(providerType);

      // Calculate total slots across all instances, reserving 1 for the coordinator
      const totalSlots = siblings.reduce((sum, inst) => sum + inst.concurrency, 0);
      const maxWorkerSlots = totalSlots - 1; // Reserve 1 for coordinator

      if (maxWorkerSlots >= 1) {
        // Count running local workers across ALL instances of this type
        const siblingIds = new Set(siblings.map((s) => s.id));
        const localRunning = Array.from(activeWorkers.values()).filter(
          (w) => w.status === "running" && siblingIds.has(w.providerName),
        ).length;

        if (localRunning >= maxWorkerSlots) {
          if (workerFallback) {
            workerProvider = workerFallback.provider;
            workerModel = workerFallback.model;
            logger.info(`[Coordinator] All local slots full (${localRunning}/${maxWorkerSlots} across ${siblings.length} instances) — worker will use ${workerFallback.model}`);
          } else {
            logger.info(`[Coordinator] All local slots full (${localRunning}/${maxWorkerSlots}) — no subagent model configured, worker will queue on local provider`);
          }
        } else {
          // Find the least-busy instance to assign this worker to
          let bestInstance = null;
          let bestAvailable = -1;
          for (const inst of siblings) {
            const active = localModelQueue._getQueue(inst.id).activeCount;
            const available = inst.concurrency - active;
            // Skip the coordinator's own instance if it has only 1 slot
            if (inst.id === providerName && inst.concurrency <= 1) continue;
            // Reserve 1 slot on coordinator's instance
            const reservedAvailable = inst.id === providerName ? available - 1 : available;
            if (reservedAvailable > bestAvailable) {
              bestAvailable = reservedAvailable;
              bestInstance = inst;
            }
          }

          if (bestInstance && bestAvailable > 0) {
            workerProvider = bestInstance.id;
            logger.info(
              `[Coordinator] Assigned worker to ${bestInstance.id} (${bestAvailable} slots free, ${siblings.length} instance${siblings.length > 1 ? "s" : ""} pooled) — model "${workerModel}"`,
            );
          } else if (workerFallback) {
            // All instances busy — fall back to configured cloud model
            workerProvider = workerFallback.provider;
            workerModel = workerFallback.model;
            logger.info(`[Coordinator] No available local slots — worker will use ${workerFallback.model}`);
          } else {
            logger.info(`[Coordinator] No available local slots and no subagent model configured — worker will queue on local provider`);
          }
        }
      } else {
        // Total concurrency across all instances is 1 — no spare slots
        if (workerFallback) {
          workerProvider = workerFallback.provider;
          workerModel = workerFallback.model;
          logger.info(`[Coordinator] Single-slot concurrency across ${siblings.length} instance(s) — workers will use ${workerFallback.model} instead`);
        } else {
          logger.info(`[Coordinator] Single-slot concurrency and no subagent model configured — worker will queue on local provider`);
        }
      }
    }

    const agentId = `agent-${(++agentCounter).toString(36)}`;
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
      abortController: new AbortController(),
      messages: [],
      files: files || [],
      // Carry coordinator context for continuation
      project,
      username,
      agent,
      providerName: workerProvider,
      resolvedModel: workerModel,
      traceId,
    };

    activeWorkers.set(agentId, workerState);

    logger.info(`[Coordinator] Spawned worker ${agentId}: "${description}" in ${worktreePath}${workerState.isolated ? " (isolated worktree)" : " (shared workspace)"}`);

    // Run the worker loop asynchronously — don't await
    CoordinatorService._runWorkerLoop(workerState, prompt, coordinatorCtx)
      .catch((err) => {
        logger.error(`[Coordinator] Worker ${agentId} loop error: ${err.message}`);
        workerState.status = "failed";
        workerState.error = err.message;
        workerState.durationMs = Date.now() - workerState.startedAt;
      });

    return {
      agent_id: agentId,
      description,
      branch: workerState.branchName || null,
      worktree: worktreePath,
      status: "running",
    };
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

    // Capture worker output
    let workerOutput = "";
    const workerToolCalls = [];
    const workerEmit = (event) => {
      if (event.type === "chunk") {
        workerOutput += event.content || "";
      } else if (event.type === "tool_execution" && event.status === "calling") {
        workerToolCalls.push({ name: event.tool?.name, args: event.tool?.args });
      } else if (event.type === "done") {
        // Capture cost and usage from finalizeTextGeneration
        worker.totalCost = event.estimatedCost || null;
        worker.usage = event.usage || null;
      }
    };

    // Build enabled tools list — exclude coordinator-only tools
    const allSchemas = ToolOrchestratorService.getToolSchemas();
    const coordinatorSet = new Set(COORDINATOR_ONLY_TOOLS);
    const workerEnabledTools = allSchemas
      .map((t) => t.name)
      .filter((name) => !coordinatorSet.has(name));

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
          maxIterations: MAX_WORKER_ITERATIONS,
          maxTokens: 8192,
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
        worker.durationMs = Date.now() - worker.startedAt;
        return;
      }
      throw err;
    }

    worker.output = workerOutput.slice(0, 4000);
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

    logger.info(
      `[Coordinator] Worker ${worker.agentId} completed in ${worker.durationMs}ms (${workerToolCalls.length} tool calls)`,
    );

    // Inject worker notification into the coordinator's active conversation
    const notification = buildTaskNotification(worker);
    if (coordinatorCtx.injectMessage) {
      coordinatorCtx.injectMessage(notification);
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
  static async decompose({ task, files, repoPath, endpoint }) {
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
        estimatedCost,
        inputTokens: approxInputTokens,
        outputTokens: approxOutputTokens,
        tokensPerSec: calculateTokensPerSec(approxOutputTokens, llmTotalSec),
        inputCharacters: inputText.length,
        totalTime: parseFloat(llmTotalSec.toFixed(3)),
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

      const abortController = new AbortController();
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
      worker.output = workerOutput.slice(0, 2000);
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

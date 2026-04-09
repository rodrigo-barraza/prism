import { randomUUID } from "node:crypto";
import { TOOLS_API_URL, WORKSPACE_ROOT as WORKSPACE_ROOT_RAW } from "../../secrets.js";
import { resolve } from "node:path";
import logger from "../utils/logger.js";
import mutationQueue from "./MutationQueue.js";
import { getProvider } from "../providers/index.js";
import RequestLogger from "./RequestLogger.js";
import { estimateTokens } from "../utils/CostCalculator.js";
import { TYPES, getPricing } from "../config.js";
import { calculateTokensPerSec } from "../utils/math.js";

// ────────────────────────────────────────────────────────────
// CoordinatorService — Multi-Agent Orchestration
// ────────────────────────────────────────────────────────────
// Decomposes complex refactoring tasks into sub-tasks, spawns
// parallel AgenticLoopService workers in isolated git worktrees,
// and merges results back into the main branch.
//
// Architecture:
//   User Request → Plan Decomposition (LLM) → N Workers
//   → Git Worktree Isolation → MutationQueue Safety
//   → Unified Diff → User Approval → Git Merge
// ────────────────────────────────────────────────────────────

const DEFAULT_WORKSPACE_ROOT = WORKSPACE_ROOT_RAW
  ? resolve(WORKSPACE_ROOT_RAW.split(",")[0].trim())
  : resolve(process.env.HOME || "/home");

/** Max parallel workers */
const MAX_WORKERS = 5;

/** Max iterations per worker agent loop (used when AgenticLoopService workers are wired in) */
const _MAX_WORKER_ITERATIONS = 15;

/** Model used for task decomposition */
const DECOMPOSITION_PROVIDER = "anthropic";
const DECOMPOSITION_MODEL = "claude-sonnet-4-20250514";

/** Active coordinator tasks keyed by taskId */
const activeTasks = new Map();

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

    const requestId = randomUUID();
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
        const inputCost = (approxInputTokens / 1_000_000) * (pricing.inputPerMillion || 0);
        const outputCost = (approxOutputTokens / 1_000_000) * (pricing.outputPerMillion || 0);
        estimatedCost = parseFloat((inputCost + outputCost).toFixed(8));
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
      if (!st.id) st.id = `task-${randomUUID().slice(0, 8)}`;
      st.branchName = `coordinator/${st.id}`;
    }

    return {
      taskId: randomUUID(),
      task,
      repoPath: repoPath || DEFAULT_WORKSPACE_ROOT,
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
        CoordinatorService._runWorker(worker, {
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
   * Run a single worker agent in a worktree.
   * @private
   */
  static async _runWorker(worker, { repoPath: _repoPath, provider: _provider, model: _model, project: _project, username: _username, onProgress }) {
    worker.status = "running";
    onProgress?.({ status: "running" });

    try {
      // Dynamically import to avoid circular dependency
      const { default: _AgenticLoopService } = await import("./AgenticLoopService.js");

      // Build a minimal context for the worker loop (reserved for future AgenticLoopService integration)
      const _workerMessages = [
        {
          role: "user",
          content: `You are a worker agent in a multi-agent refactoring task.\n\n` +
            `Your workspace is: ${worker.worktreePath}\n` +
            `You are working on files: ${worker.files.join(", ")}\n\n` +
            `Task:\n${worker.instruction}\n\n` +
            `Important:\n` +
            `- Only modify files within your workspace\n` +
            `- Do NOT commit your changes — the coordinator will handle git operations\n` +
            `- Focus on the specific task described above`,
        },
      ];

      // Create a simple emitter that captures output (reserved for future worker loop integration)
      let workerOutput = "";
      const workerToolCalls = [];
      const _workerEmit = (event) => {
        if (event.type === "chunk") {
          workerOutput += event.content || "";
        } else if (event.type === "toolCall") {
          workerToolCalls.push({ name: event.name, args: event.args });
        }
      };

      // Stage all changes in the worktree before we diff
      const stageResult = await toolsApiPost("/agentic/command/run", {
        command: "git add -A",
        cwd: worker.worktreePath,
      });

      // Commit changes so the diff is visible
      if (!stageResult.error) {
        await toolsApiPost("/agentic/command/run", {
          command: `git commit -m "coordinator: ${worker.id}" --allow-empty`,
          cwd: worker.worktreePath,
        });
      }

      worker.status = "complete";
      worker.toolCalls = workerToolCalls;
      worker.output = workerOutput.slice(0, 2000); // Cap output size
      onProgress?.({ status: "complete" });

      logger.info(`[Coordinator] Worker ${worker.id} completed (${workerToolCalls.length} tool calls)`);
    } catch (err) {
      worker.status = "error";
      worker.error = err.message;
      onProgress?.({ status: "error", error: err.message });
      logger.error(`[Coordinator] Worker ${worker.id} failed: ${err.message}`);
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
        task.repoPath || DEFAULT_WORKSPACE_ROOT,
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

    const repoPath = task.repoPath || DEFAULT_WORKSPACE_ROOT;

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

// @ts-ignore
import { sleep, roundMs } from "@rodrigo-barraza/utilities-library";
// ─── Custom LLM Accuracy Benchmarking ───────────────────────
import crypto from "crypto";
import { handleConversation, handleAgent } from "../routes/ChatRoutes.js";
import { MODELS, MODEL_TYPES, getModelByName } from "../config.js";
import { getProvider } from "../providers/index.js";
import { isInstance } from "../providers/instance-registry.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
// @ts-ignore
import { MONGO_DB_NAME } from "../../config.js";
import logger from "../utils/logger.js";
import {} from "../utils/utilities.js";
import { COLLECTIONS } from "../constants.js";
const BENCHMARKS_COL = COLLECTIONS.BENCHMARKS;
const RUNS_COL = COLLECTIONS.BENCHMARK_RUNS;
// In-memory counter: how many benchmark model calls are actively generating
let activeGenerationCount = 0;
// ─── evaluate model response against expected value ─────────
const MATCH_MODES = {
  CONTAINS: "contains",
  EXACT: "exact",
  STARTS_WITH: "startsWith",
  REGEX: "regex",
};
/**
 * Evaluate whether a model response matches the expected value.
 * @param {string} response   The raw model output
 * @param {string} expected   The expected value
 * @param {string} matchMode  One of: "contains", "exact", "startsWith", "regex"
 * @returns {boolean}
 */
function evaluate(
  response: any,
  expected: any,
  matchMode = MATCH_MODES.CONTAINS,
) {
  if (!response || !expected) return false;
  const norm = (s: any) => s.trim().toLowerCase();
  switch (matchMode) {
    case MATCH_MODES.EXACT:
      return norm(response) === norm(expected);
    case MATCH_MODES.STARTS_WITH:
      return norm(response).startsWith(norm(expected));
    case MATCH_MODES.REGEX: {
      try {
        const re = new RegExp(expected, "i");
        return re.test(response);
      } catch {
        logger.warn(`[benchmark] Invalid regex: ${expected}`);
        return false;
      }
    }
    case MATCH_MODES.CONTAINS:
    default:
      return norm(response).includes(norm(expected));
  }
}
/**
 * Evaluate a response against multiple assertions using AND/OR logic.
 *
 * @param {string} response          The raw model output
 * @param {Object} benchmark         The benchmark definition
 * @param {Array}  benchmark.assertions       Array of { expectedValue, matchMode }
 * @param {string} benchmark.assertionOperator "AND" or "OR"
 * @returns {boolean}
 */
function evaluateAssertions(response: any, benchmark: any) {
  const assertions = benchmark.assertions;
  if (!assertions || assertions.length === 0) {
    return false;
  }
  const operator = benchmark.assertionOperator || "AND";
  if (operator === "OR") {
    // Disjunction: ANY assertion must pass
    return assertions.some((a: any) =>
      evaluate(response, a.expectedValue, a.matchMode || MATCH_MODES.CONTAINS),
    );
  }
  // Conjunction (AND): ALL assertions must pass
  return assertions.every((a: any) =>
    evaluate(response, a.expectedValue, a.matchMode || MATCH_MODES.CONTAINS),
  );
}
// ─── behavioral assertions ──────────────────────────────────
/**
 * Comparison operators for numeric agent assertions.
 */
const COMPARATORS = {
  gte: (a: any, b: any) => a >= b,
  lte: (a: any, b: any) => a <= b,
  gt: (a: any, b: any) => a > b,
  lt: (a: any, b: any) => a < b,
  eq: (a: any, b: any) => a === b,
};
/**
 * Evaluate a single agent assertion against execution result data.
 *
 * @param {Object} assertion       — { type, operator?, operand? }
 * @param {Object} executionData   — { response, thinking, toolCalls, turnCount }
 * @returns {boolean}
 */
function evaluateSingleAgentAssertion(assertion: any, executionData: any) {
  const { type, operator, operand } = assertion;
  switch (type) {
    case "replied":
      return (
        !!executionData.response && executionData.response.trim().length > 0
      );
    case "used_tool_calls": {
      const count = executionData.toolCalls?.length || 0;
      const target = parseInt(operand, 10);
      if (isNaN(target)) return count > 0; // Fallback: any tool calls
      // @ts-ignore
      const compareFn = COMPARATORS[operator || "gte"];
      return compareFn ? compareFn(count, target) : count >= target;
    }
    case "thought":
      return (
        !!executionData.thinking && executionData.thinking.trim().length > 0
      );
    case "max_turns": {
      const turns = executionData.turnCount || 1;
      const limit = parseInt(operand, 10);
      if (isNaN(limit)) return true; // No limit specified
      // @ts-ignore
      const compareFn = COMPARATORS[operator || "lte"];
      return compareFn ? compareFn(turns, limit) : turns <= limit;
    }
    default:
      logger.warn(`[benchmark] Unknown agent assertion type: ${type}`);
      return false;
  }
}
/**
 * Evaluate all agent assertions against execution result data.
 *
 * @param {Object} benchmark       The benchmark definition
 * @param {Object} executionData   — { response, thinking, toolCalls, turnCount }
 * @returns {boolean}
 */
function evaluateAgentAssertions(benchmark: any, executionData: any) {
  const assertions = benchmark.agentAssertions;
  if (!assertions || assertions.length === 0) {
    return true; // No agent assertions = pass by default
  }
  const operator = benchmark.agentAssertionOperator || "AND";
  if (operator === "OR") {
    return assertions.some((a: any) =>
      evaluateSingleAgentAssertion(a, executionData),
    );
  }
  return assertions.every((a: any) =>
    evaluateSingleAgentAssertion(a, executionData),
  );
}
// ─── list available conversation models ─────────────────────
/**
 * Get all listed conversation-type models grouped by provider.
 * Returns flat array of { provider, model, label }.
 */
function getConversationModels() {
  const results = [];
  // @ts-ignore
  for ( const m of Object.values(MODELS)) {
    if (m.modelType !== MODEL_TYPES.CONVERSATION) continue;
    // @ts-ignore
    if (m.listed === false) continue;
    // Skip image-only output models (no text output)
    if (!m.outputTypes?.includes("text")) continue;
    // Skip image API models (generate images, not text completions)
    // @ts-ignore
    if (m.imageAPI) continue;
    results.push({
      provider: m.provider,
      model: m.name,
      label: m.label,
    });
  }
  return results;
}
/**
 * Filter a model list to only those whose providers are actually
 * reachable (have API keys configured / servers running).
 * For cloud providers we check if getProvider() doesn't throw.
 * For local providers we also do a quick health check.
 */
function filterAvailableModels(models: any) {
  const checked = new Map();
  return models.filter((m: any) => {
    if (checked.has(m.provider)) return checked.get(m.provider);
    try {
      getProvider(m.provider);
      checked.set(m.provider, true);
      return true;
    } catch {
      checked.set(m.provider, false);
      return false;
    }
  });
}
// ─── Run a single model against a benchmark prompt ──────────
// @ts-ignore
async function runSingleModel(
  benchmark: any,
  model: any,
  project: any,
  username: any,
  // @ts-ignore
  { signal, onEvent } = {},
) {
  // Config flags carried on every result for stats differentiation
  const configFlags = {
    thinkingEnabled: model.thinkingEnabled || false,
    toolsEnabled: model.toolsEnabled || false,
    ...(model.agent && { agent: model.agent }),
  };
  // Bail immediately if already aborted
  if (signal?.aborted) {
    logger.info(
      `[benchmark] ⏭ Skipping ${model.provider}/${model.model} — already aborted`,
    );
    return {
      provider: model.provider,
      model: model.model,
      label: model.label,
      ...configFlags,
      response: null,
      thinking: null,
      passed: false,
      matchMode: benchmark.matchMode || MATCH_MODES.CONTAINS,
      latency: 0,
      usage: null,
      estimatedCost: null,
      error: "Aborted",
      completedAt: new Date().toISOString(),
    };
  }
  const start = performance.now();
  const messages = [];
  // Optional system prompt
  if (benchmark.systemPrompt) {
    messages.push({ role: "system", content: benchmark.systemPrompt });
  }
  messages.push({ role: "user", content: benchmark.prompt });
  logger.info(`[benchmark] ▶ Running ${model.provider}/${model.model}`);
  try {
    // @ts-ignore
    const events = [];
    const handler = model.agent ? handleAgent : handleConversation;
    await handler(
      {
        provider: model.provider,
        model: model.model,
        messages,
        temperature: benchmark.temperature ?? 0,
        maxTokens: Math.max(benchmark.maxTokens ?? 2048, 2048),
        project,
        username,
        skipConversation: true,
        thinkingEnabled: model.thinkingEnabled || false,
        ...(model.agent && {
          agent: model.agent,
          agenticLoopEnabled: true,
          autoApprove: true,
          maxIterations: 10,
        }),
        ...(model.toolsEnabled && {
          functionCallingEnabled: true,
          enabledTools: ["precise_calculator"],
        }),
      },
      (event: any) => {
        events.push(event);
        // Forward chunk/thinking/tool events in real-time for live preview
        if (
          event.type === "chunk" ||
          event.type === "thinking" ||
          event.type === "toolCall" ||
          event.type === "tool_execution" ||
          event.type === "tool_output"
        ) {
          if (onEvent) {
            try {
              onEvent(event);
            } catch {
              /* noop */
            }
          }
        }
        // Log every event for debugging
        if (event.type === "chunk") {
          logger.info(
            `[benchmark]   📦 ${model.model} chunk (${event.content?.length || 0} chars)`,
          );
        } else if (event.type === "error") {
          logger.error(
            `[benchmark]   ❌ ${model.model} error: ${event.message}`,
          );
        } else if (event.type === "done") {
          logger.info(
            `[benchmark]   ✅ ${model.model} done — usage: ${JSON.stringify(event.usage || null)}, cost: ${event.estimatedCost ?? "N/A"}`,
          );
        } else {
          logger.info(`[benchmark]   📨 ${model.model} event: ${event.type}`);
        }
      },
      { signal },
    );
    const latency = (performance.now() - start) / 1000;
    // Log all event types received
    // @ts-ignore
    const eventTypes = events.map((e: any) => e.type);
    logger.info(
      `[benchmark] ◀ ${model.model} finished in ${latency.toFixed(2)}s — events: [${eventTypes.join(", ")}]`,
    );
    // Check for errors
    // @ts-ignore
    const errorEvent = events.find((e: any) => e.type === "error");
    if (errorEvent) {
      logger.warn(
        `[benchmark]   ⚠ ${model.model} returned error event: ${errorEvent.message}`,
      );
      return {
        provider: model.provider,
        model: model.model,
        label: model.label,
        ...configFlags,
        response: null,
        thinking: null,
        passed: false,
        matchMode: benchmark.matchMode || MATCH_MODES.CONTAINS,
        latency: roundMs(latency),
        usage: null,
        estimatedCost: null,
        error: errorEvent.message,
        completedAt: new Date().toISOString(),
      };
    }
    // Extract text response
    // @ts-ignore
    const text = events
      .filter((e: any) => e.type === "chunk")
      .map((e: any) => e.content)
      .join("");
    if (!text) {
      logger.warn(
        // @ts-ignore
        `[benchmark]   ⚠ ${model.model} produced NO text — chunk count: ${events.filter((e: any) => e.type === "chunk").length}, all events: ${JSON.stringify(eventTypes)}`,
      );
    }
    // @ts-ignore
    const doneEvent = events.find((e: any) => e.type === "done") || {};
    const matchMode = benchmark.matchMode || MATCH_MODES.CONTAINS;
    // Extract thinking content (emitted as type: "thinking")
    // @ts-ignore
    const thinkingText = events
      .filter((e: any) => e.type === "thinking")
      .map((e: any) => e.content)
      .join("");
    // Extract tool calls from both event paths:
    // - "toolCall" with status "done" — native MCP path (e.g. LM Studio)
    // - "tool_execution" with status "done" — standard agentic path (cloud providers)
    // @ts-ignore
    const nativeToolCalls = events
      .filter((e: any) => e.type === "toolCall" && e.status === "done")
      .map((tc: any) => ({
        id: tc.id,
        name: tc.name,
        args: tc.args,
        result: tc.result,
        status: "done",
      }));
    // @ts-ignore
    const agenticToolCalls = events
      .filter(
        (e: any) =>
          e.type === "tool_execution" &&
          (e.status === "done" || e.status === "error"),
      )
      .map((e: any) => ({
        id: e.tool?.id,
        name: e.tool?.name,
        args: e.tool?.args,
        result: e.tool?.result,
        status: e.status,
      }));
    const toolCalls = [...nativeToolCalls, ...agenticToolCalls];
    const toolCallsResult = toolCalls.length > 0 ? toolCalls : null;
    // Count agentic loop turns (each chunk of tool calls + response = 1 turn)
    // A turn is roughly: user→model→(tools)→model. Count "done" events as turn markers.
    // @ts-ignore
    const turnCount = events.filter((e: any) => e.type === "done").length || 1;
    // ── Mode-aware pass/fail evaluation ──────────────────────
    const mode = benchmark.benchmarkMode || "model";
    let passed: any;
    if (mode === "agent") {
      // Agent mode: only behavioral assertions
      passed = evaluateAgentAssertions(benchmark, {
        response: text,
        thinking: thinkingText,
        toolCalls,
        turnCount,
      });
    } else if (mode === "combined") {
      // Combined mode: both text + behavioral assertions must pass
      const textPassed = evaluateAssertions(text, benchmark);
      const agentPassed = evaluateAgentAssertions(benchmark, {
        response: text,
        thinking: thinkingText,
        toolCalls,
        turnCount,
      });
      passed = textPassed && agentPassed;
    } else {
      // Model mode (default): text assertions only
      passed = evaluateAssertions(text, benchmark);
    }
    return {
      provider: model.provider,
      model: model.model,
      label: model.label,
      ...configFlags,
      response: text || null,
      thinking: thinkingText || null,
      toolCalls: toolCallsResult,
      passed,
      matchMode,
      turnCount,
      latency: roundMs(latency),
      usage: doneEvent.usage || null,
      estimatedCost: doneEvent.estimatedCost ?? null,
      error: null,
      completedAt: new Date().toISOString(),
    };
  } catch (error: any) {
    const latency = (performance.now() - start) / 1000;
    logger.error(`[benchmark]   💥 ${model.model} threw: ${error.message}`);
    return {
      provider: model.provider,
      model: model.model,
      label: model.label,
      ...configFlags,
      response: null,
      thinking: null,
      passed: false,
      matchMode: benchmark.matchMode || MATCH_MODES.CONTAINS,
      latency: roundMs(latency),
      usage: null,
      estimatedCost: null,
      error: error.message,
      completedAt: new Date().toISOString(),
    };
  }
}
// ─── public API ─────────────────────────────────────────────
const BenchmarkService = {
  MATCH_MODES,
  evaluate,
  getConversationModels,
  /** Number of benchmark model calls currently in-flight. */
  get activeGenerationCount() {
    return activeGenerationCount;
  },
  /**
   * Run a benchmark test against the specified models (or all available).
   * @param {Object}   benchmark   The benchmark definition document
   * @param {Array}    [modelTargets]  Optional array of { provider, model } to test
   * @param {string}   project
   * @param {string}   username
   * @returns {Object} The completed run document
   */
  async runBenchmark(
    benchmark: any,
    modelTargets: any,
    project: any,
    username: any,
    // @ts-ignore
    { onRunStart, onModelStart, onModelComplete, onEvent, signal } = {},
  ) {
    // Resolve target models
    let models: any;
    if (modelTargets && modelTargets.length > 0) {
      // Validate and enrich with labels
      models = modelTargets.map((t: any) => {
        const def = getModelByName(t.model);
        return {
          provider: t.provider,
          model: t.model,
          label: def?.label || t.display_name || t.model,
          thinkingEnabled: t.thinkingEnabled || false,
          toolsEnabled: t.toolsEnabled || false,
          ...(t.agent && { agent: t.agent }),
        };
      });
    } else {
      models = filterAvailableModels(getConversationModels());
    }
    if (models.length === 0) {
      throw new Error("No models available for benchmarking");
    }
    // Notify caller of total model count (used for live reconnection state)
    if (onRunStart) {
      try {
        onRunStart({ totalModels: models.length });
      } catch {
        /* noop */
      }
    }
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    logger.info(
      `[benchmark] Starting run ${runId} — "${benchmark.name}" against ${models.length} model(s)`,
    );
    // ── Instance-aware concurrent execution ─────────────────────
    // Cloud providers: all models under the same provider run sequentially
    // within a bucket, but different providers run concurrently.
    // Local providers: models are bucketed per instance (e.g. lm-studio,
    // lm-studio-2), and each instance runs up to its concurrency limit.
    // Two instances means two concurrent local inference streams.
    const INTRA_PROVIDER_DELAY_MS = 100;
    // Group models by provider; local providers use their instance ID as key
    const buckets = new Map();
    // @ts-ignore
    for ( const m of models) {
      const key = m.provider; // Instance IDs are already unique (lm-studio, lm-studio-2, etc.)
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(m);
    }
    logger.info(
      `[benchmark] Executing across ${buckets.size} provider bucket(s): ${[...buckets.keys()].join(", ")}`,
    );
    // Each bucket runs its models sequentially; all buckets run concurrently.
    // The process-level GPU mutex (LocalModelQueue) still serializes at the
    // instance level, so concurrent benchmark runs and chat requests are safe.
    let aborted = false;
    const bucketPromises = [...buckets.entries()].map(
      async ([_key, bucketModels]: any) => {
        const bucketResults = [];
        for (let i = 0; i < bucketModels.length; i++) {
          // Check abort signal before each model
          if (signal?.aborted || aborted) {
            logger.info(`[benchmark] Aborting bucket — signal received`);
            break;
          }
          if (i > 0) await sleep(INTRA_PROVIDER_DELAY_MS);
          const model = bucketModels[i];
          if (onModelStart) {
            try {
              onModelStart({ ...model, isLocal: isInstance(model.provider) });
            } catch {
              /* noop */
            }
          }
          activeGenerationCount++;
          // Wrap onEvent to tag each event with the source model (enables
          // correct attribution when multiple provider buckets stream concurrently).
          const modelOnEvent = onEvent
            ? (event: any) =>
                onEvent({
                  ...event,
                  _sourceModel: {
                    provider: model.provider,
                    model: model.model,
                  },
                })
            : undefined;
          let result: any;
          try {
            result = await runSingleModel(benchmark, model, project, username, {
              signal,
              onEvent: modelOnEvent,
            });
          } finally {
            activeGenerationCount = Math.max(0, activeGenerationCount - 1);
          }
          if (signal?.aborted || aborted) {
            logger.info(
              `[benchmark] Aborting after model ${model.model} completed`,
            );
            // Still record this model's result even though we're stopping
            if (onModelComplete) {
              try {
                onModelComplete(result);
              } catch {
                /* noop */
              }
            }
            bucketResults.push(result);
            break;
          }
          if (onModelComplete) {
            try {
              onModelComplete(result);
            } catch {
              /* noop */
            }
          }
          bucketResults.push(result);
        }
        return bucketResults;
      },
    );
    // Listen for abort signal to propagate to all buckets
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
    }
    const bucketOutputs = await Promise.all(bucketPromises);
    const results = bucketOutputs.flat();
    const completedAt = new Date().toISOString();
    const wasAborted = signal?.aborted || aborted;
    const passed = results.filter((r: any) => r.passed).length;
    const failed = results.filter((r: any) => !r.passed && !r.error).length;
    const errored = results.filter((r: any) => r.error).length;
    const totalCost = results.reduce(
      (sum: any, r: any) => sum + (r.estimatedCost || 0),
      0,
    );
    const run = {
      id: runId,
      benchmarkId: benchmark.id,
      project,
      models: results,
      aborted: wasAborted || false,
      summary: {
        total: results.length,
        passed,
        failed,
        errored,
        totalCost,
      },
      startedAt,
      completedAt,
    };
    // Persist run (even partial / aborted runs)
    if (results.length > 0) {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      if (db) {
        await db.collection(RUNS_COL).insertOne(run);
      }
    }
    logger.success(
      `[benchmark] Run ${runId} ${wasAborted ? "ABORTED" : "complete"} — ${passed}/${results.length} passed` +
        (errored > 0 ? `, ${errored} error(s)` : ""),
    );
    return run;
  },
  // ── CRUD Helpers ────────────────────────────────────────────
  async create(data: any, project: any, username: any) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      project,
      username,
      name: data.name,
      prompt: data.prompt,
      systemPrompt: data.systemPrompt || null,
      expectedValue: data.expectedValue,
      matchMode: data.matchMode || MATCH_MODES.CONTAINS,
      benchmarkMode: data.benchmarkMode || "model",
      assertions: data.assertions || [],
      assertionOperator: data.assertionOperator || "AND",
      agentAssertions: data.agentAssertions || [],
      agentAssertionOperator: data.agentAssertionOperator || "AND",
      temperature: data.temperature ?? 0,
      maxTokens: data.maxTokens ?? 256,
      tags: data.tags || [],
      createdAt: now,
      updatedAt: now,
    };
    await db.collection(BENCHMARKS_COL).insertOne(doc);
    return doc;
  },
  async list(project: any) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    return db
      .collection(BENCHMARKS_COL)
      .find({ project })
      .sort({ updatedAt: -1 })
      .toArray();
  },
  async getById(id: any, project: any) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    return db.collection(BENCHMARKS_COL).findOne({ id, project });
  },
  async remove(id: any, project: any) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    await db.collection(BENCHMARKS_COL).deleteOne({ id, project });
    await db.collection(RUNS_COL).deleteMany({ benchmarkId: id, project });
  },
  async getRuns(benchmarkId: any, project: any) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    return db
      .collection(RUNS_COL)
      .find({ benchmarkId, project })
      .sort({ startedAt: -1 })
      .toArray();
  },
  async getRunById(runId: any, project: any) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    return db.collection(RUNS_COL).findOne({ id: runId, project });
  },
  async getLatestRun(benchmarkId: any, project: any) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    return db
      .collection(RUNS_COL)
      .findOne({ benchmarkId, project }, { sort: { startedAt: -1 } });
  },
};
export default BenchmarkService;

// ============================================================
// BenchmarkService — Custom LLM Accuracy Benchmarking
// ============================================================
// Orchestrates benchmark test execution against multiple models,
// evaluates responses against expected values, and persists results.

import crypto from "crypto";
import { handleConversation, handleAgent } from "../routes/chat.js";
import {
  MODELS,
  MODEL_TYPES,
  getModelByName,
} from "../config.js";
import { getProvider } from "../providers/index.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";
import { sleep } from "../utils/utilities.js";
import { COLLECTIONS } from "../constants.js";

// Providers that run on local GPU — grouped into a single sequential bucket
const LOCAL_PROVIDERS = new Set(["lm-studio", "vllm", "ollama", "llama-cpp"]);

const BENCHMARKS_COL = COLLECTIONS.BENCHMARKS;
const RUNS_COL = COLLECTIONS.BENCHMARK_RUNS;

// In-memory counter: how many benchmark model calls are actively generating
let activeGenerationCount = 0;


// ============================================================
// Match Modes — evaluate model response against expected value
// ============================================================

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
function evaluate(response, expected, matchMode = MATCH_MODES.CONTAINS) {
  if (!response || !expected) return false;

  const norm = (s) => s.trim().toLowerCase();

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
 * Falls back to single evaluate() for legacy benchmarks without assertions.
 *
 * @param {string} response          The raw model output
 * @param {Object} benchmark         The benchmark definition
 * @param {Array}  benchmark.assertions       Array of { expectedValue, matchMode }
 * @param {string} benchmark.assertionOperator "AND" or "OR"
 * @param {string} benchmark.expectedValue     Legacy single expected value
 * @param {string} benchmark.matchMode         Legacy single match mode
 * @returns {boolean}
 */
function evaluateAssertions(response, benchmark) {
  const assertions = benchmark.assertions;
  if (!assertions || assertions.length === 0) {
    // Legacy: fall back to single expectedValue/matchMode
    return evaluate(response, benchmark.expectedValue, benchmark.matchMode || MATCH_MODES.CONTAINS);
  }

  const operator = benchmark.assertionOperator || "AND";

  if (operator === "OR") {
    // Disjunction: ANY assertion must pass
    return assertions.some((a) =>
      evaluate(response, a.expectedValue, a.matchMode || MATCH_MODES.CONTAINS),
    );
  }

  // Conjunction (AND): ALL assertions must pass
  return assertions.every((a) =>
    evaluate(response, a.expectedValue, a.matchMode || MATCH_MODES.CONTAINS),
  );
}

// ============================================================
// Model Discovery — list available conversation models
// ============================================================

/**
 * Get all listed conversation-type models grouped by provider.
 * Returns flat array of { provider, model, label }.
 */
function getConversationModels() {
  const results = [];
  for (const m of Object.values(MODELS)) {
    if (m.modelType !== MODEL_TYPES.CONVERSATION) continue;
    if (m.listed === false) continue;
    // Skip image-only output models (no text output)
    if (!m.outputTypes?.includes("text")) continue;
    // Skip image API models (generate images, not text completions)
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
function filterAvailableModels(models) {
  const checked = new Map();
  return models.filter((m) => {
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

// ============================================================
// Database helpers
// ============================================================

function getDb() {
  const client = MongoWrapper.getClient(MONGO_DB_NAME);
  if (!client) return null;
  return client.db(MONGO_DB_NAME);
}


// ============================================================
// Run a single model against a benchmark prompt
// ============================================================

async function runSingleModel(benchmark, model, project, username, { signal, onEvent } = {}) {
  // Config flags carried on every result for stats differentiation
  const configFlags = {
    thinkingEnabled: model.thinkingEnabled || false,
    toolsEnabled: model.toolsEnabled || false,
    ...(model.agent && { agent: model.agent }),
  };
  // Bail immediately if already aborted
  if (signal?.aborted) {
    logger.info(`[benchmark] ⏭ Skipping ${model.provider}/${model.model} — already aborted`);
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

  logger.info(
    `[benchmark] ▶ Running ${model.provider}/${model.model}`,
  );

  try {
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
      (event) => {
        events.push(event);
        // Forward chunk/thinking events in real-time for live preview
        if (event.type === "chunk" || event.type === "thinking") {
          if (onEvent) {
            try { onEvent(event); } catch { /* noop */ }
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
          logger.info(
            `[benchmark]   📨 ${model.model} event: ${event.type}`,
          );
        }
      },
      { signal },
    );

    const latency = (performance.now() - start) / 1000;

    // Log all event types received
    const eventTypes = events.map((e) => e.type);
    logger.info(
      `[benchmark] ◀ ${model.model} finished in ${latency.toFixed(2)}s — events: [${eventTypes.join(", ")}]`,
    );

    // Check for errors
    const errorEvent = events.find((e) => e.type === "error");
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
        latency: parseFloat(latency.toFixed(3)),
        usage: null,
        estimatedCost: null,
        error: errorEvent.message,
        completedAt: new Date().toISOString(),
      };
    }

    // Extract text response
    const text = events
      .filter((e) => e.type === "chunk")
      .map((e) => e.content)
      .join("");

    if (!text) {
      logger.warn(
        `[benchmark]   ⚠ ${model.model} produced NO text — chunk count: ${events.filter((e) => e.type === "chunk").length}, all events: ${JSON.stringify(eventTypes)}`,
      );
    }

    const doneEvent = events.find((e) => e.type === "done") || {};
    const matchMode = benchmark.matchMode || MATCH_MODES.CONTAINS;
    const passed = evaluateAssertions(text, benchmark);

    // Extract thinking content (emitted as type: "thinking")
    const thinkingText = events
      .filter((e) => e.type === "thinking")
      .map((e) => e.content)
      .join("");

    // Extract tool calls (emitted as type: "toolCall")
    const toolCallEvents = events.filter((e) => e.type === "toolCall" && e.status === "done");
    const toolCalls = toolCallEvents.length > 0
      ? toolCallEvents.map((tc) => ({
        id: tc.id,
        name: tc.name,
        args: tc.args,
        result: tc.result,
      }))
      : null;

    return {
      provider: model.provider,
      model: model.model,
      label: model.label,
      ...configFlags,
      response: text || null,
      thinking: thinkingText || null,
      toolCalls,
      passed,
      matchMode,
      latency: parseFloat(latency.toFixed(3)),
      usage: doneEvent.usage || null,
      estimatedCost: doneEvent.estimatedCost ?? null,
      error: null,
      completedAt: new Date().toISOString(),
    };
  } catch (err) {
    const latency = (performance.now() - start) / 1000;
    logger.error(
      `[benchmark]   💥 ${model.model} threw: ${err.message}`,
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
      latency: parseFloat(latency.toFixed(3)),
      usage: null,
      estimatedCost: null,
      error: err.message,
      completedAt: new Date().toISOString(),
    };
  }
}

// ============================================================
// BenchmarkService — public API
// ============================================================

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
    benchmark,
    modelTargets,
    project,
    username,
    { onRunStart, onModelStart, onModelComplete, onEvent, signal } = {},
  ) {
    // Resolve target models
    let models;
    if (modelTargets && modelTargets.length > 0) {
      // Validate and enrich with labels
      models = modelTargets.map((t) => {
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
      try { onRunStart({ totalModels: models.length }); } catch { /* noop */ }
    }

    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    logger.info(
      `[benchmark] Starting run ${runId} — "${benchmark.name}" against ${models.length} model(s)`,
    );

    // ── Provider-bucketed concurrent execution ──────────────────
    // Different providers run concurrently (parallel Promise.all).
    // Models within the same provider run sequentially with a
    // 100ms stagger to avoid rate-limiting.
    // Local GPU providers share a single sequential bucket.

    const INTRA_PROVIDER_DELAY_MS = 100;

    // Group models by provider; collapse all local providers into one bucket
    const buckets = new Map();
    for (const m of models) {
      const key = LOCAL_PROVIDERS.has(m.provider) ? "__local__" : m.provider;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(m);
    }

    logger.info(
      `[benchmark] Executing across ${buckets.size} provider bucket(s): ${[...buckets.keys()].join(", ")}`,
    );

    // Each bucket runs its models sequentially; all buckets run concurrently.
    // NOTE: The process-level GPU mutex lives in prepareGenerationContext() (via LocalModelQueue),
    // so concurrent benchmark runs and chat requests are globally serialized there.
    let aborted = false;
    const bucketPromises = [...buckets.entries()].map(
      async ([_key, bucketModels]) => {
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
            try { onModelStart({ ...model, isLocal: LOCAL_PROVIDERS.has(model.provider) }); } catch { /* noop */ }
          }
          activeGenerationCount++;
          let result;
          try {
            result = await runSingleModel(benchmark, model, project, username, { signal, onEvent });
          } finally {
            activeGenerationCount = Math.max(0, activeGenerationCount - 1);
          }
          if (signal?.aborted || aborted) {
            logger.info(`[benchmark] Aborting after model ${model.model} completed`);
            // Still record this model's result even though we're stopping
            if (onModelComplete) {
              try { onModelComplete(result); } catch { /* noop */ }
            }
            bucketResults.push(result);
            break;
          }
          if (onModelComplete) {
            try { onModelComplete(result); } catch { /* noop */ }
          }
          bucketResults.push(result);
        }
        return bucketResults;
      },
    );

    // Listen for abort signal to propagate to all buckets
    if (signal) {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    }

    const bucketOutputs = await Promise.all(bucketPromises);
    const results = bucketOutputs.flat();

    const completedAt = new Date().toISOString();
    const wasAborted = signal?.aborted || aborted;
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed && !r.error).length;
    const errored = results.filter((r) => r.error).length;
    const totalCost = results.reduce(
      (sum, r) => sum + (r.estimatedCost || 0),
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
      const db = getDb();
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

  async create(data, project, username) {
    const db = getDb();
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
      assertions: data.assertions || [],
      assertionOperator: data.assertionOperator || "AND",
      temperature: data.temperature ?? 0,
      maxTokens: data.maxTokens ?? 256,
      tags: data.tags || [],
      createdAt: now,
      updatedAt: now,
    };

    await db.collection(BENCHMARKS_COL).insertOne(doc);
    return doc;
  },

  async list(project) {
    const db = getDb();
    if (!db) throw new Error("Database not available");

    return db
      .collection(BENCHMARKS_COL)
      .find({ project })
      .sort({ updatedAt: -1 })
      .toArray();
  },

  async getById(id, project) {
    const db = getDb();
    if (!db) throw new Error("Database not available");

    return db.collection(BENCHMARKS_COL).findOne({ id, project });
  },


  async remove(id, project) {
    const db = getDb();
    if (!db) throw new Error("Database not available");

    await db.collection(BENCHMARKS_COL).deleteOne({ id, project });
    await db.collection(RUNS_COL).deleteMany({ benchmarkId: id, project });
  },

  async getRuns(benchmarkId, project) {
    const db = getDb();
    if (!db) throw new Error("Database not available");

    return db
      .collection(RUNS_COL)
      .find({ benchmarkId, project })
      .sort({ startedAt: -1 })
      .toArray();
  },

  async getRunById(runId, project) {
    const db = getDb();
    if (!db) throw new Error("Database not available");

    return db.collection(RUNS_COL).findOne({ id: runId, project });
  },

  async getLatestRun(benchmarkId, project) {
    const db = getDb();
    if (!db) throw new Error("Database not available");

    return db
      .collection(RUNS_COL)
      .findOne({ benchmarkId, project }, { sort: { startedAt: -1 } });
  },
};

export default BenchmarkService;

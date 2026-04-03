// ============================================================
// BenchmarkService — Custom LLM Accuracy Benchmarking
// ============================================================
// Orchestrates benchmark test execution against multiple models,
// evaluates responses against expected values, and persists results.

import crypto from "crypto";
import { handleChat } from "../routes/chat.js";
import {
  MODELS,
  MODEL_TYPES,
  getModelByName,
} from "../config.js";
import { getProvider } from "../providers/index.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";

const BENCHMARKS_COL = "benchmarks";
const RUNS_COL = "benchmark_runs";

// Providers that run on local GPU — must execute sequentially
const LOCAL_PROVIDERS = new Set(["lm-studio", "vllm", "ollama", "llama-cpp"]);

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

async function runSingleModel(benchmark, model, project, username) {
  const start = performance.now();

  const messages = [];

  // Optional system prompt
  if (benchmark.systemPrompt) {
    messages.push({ role: "system", content: benchmark.systemPrompt });
  }

  messages.push({ role: "user", content: benchmark.prompt });

  try {
    const events = [];
    await handleChat(
      {
        provider: model.provider,
        model: model.model,
        messages,
        temperature: benchmark.temperature ?? 0,
        maxTokens: benchmark.maxTokens ?? 256,
        project,
        username,
        skipConversation: true,
        thinkingEnabled: false,
      },
      (event) => events.push(event),
    );

    const latency = (performance.now() - start) / 1000;

    // Check for errors
    const errorEvent = events.find((e) => e.type === "error");
    if (errorEvent) {
      return {
        provider: model.provider,
        model: model.model,
        label: model.label,
        response: null,
        passed: false,
        matchMode: benchmark.matchMode || MATCH_MODES.CONTAINS,
        latency: parseFloat(latency.toFixed(3)),
        usage: null,
        estimatedCost: null,
        error: errorEvent.message,
      };
    }

    // Extract text response
    const text = events
      .filter((e) => e.type === "chunk")
      .map((e) => e.content)
      .join("");

    const doneEvent = events.find((e) => e.type === "done") || {};
    const matchMode = benchmark.matchMode || MATCH_MODES.CONTAINS;
    const passed = evaluate(text, benchmark.expectedValue, matchMode);

    return {
      provider: model.provider,
      model: model.model,
      label: model.label,
      response: text || null,
      passed,
      matchMode,
      latency: parseFloat(latency.toFixed(3)),
      usage: doneEvent.usage || null,
      estimatedCost: doneEvent.estimatedCost ?? null,
      error: null,
    };
  } catch (err) {
    const latency = (performance.now() - start) / 1000;
    return {
      provider: model.provider,
      model: model.model,
      label: model.label,
      response: null,
      passed: false,
      matchMode: benchmark.matchMode || MATCH_MODES.CONTAINS,
      latency: parseFloat(latency.toFixed(3)),
      usage: null,
      estimatedCost: null,
      error: err.message,
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
          label: def?.label || t.model,
        };
      });
    } else {
      models = filterAvailableModels(getConversationModels());
    }

    if (models.length === 0) {
      throw new Error("No models available for benchmarking");
    }

    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    logger.info(
      `[benchmark] Starting run ${runId} — "${benchmark.name}" against ${models.length} model(s)`,
    );

    // ── Smart concurrency: cloud parallel, local sequential ──
    // Cloud providers can all run at the same time (different API endpoints).
    // Local providers share a single GPU — must run one at a time.
    const cloudModels = models.filter((m) => !LOCAL_PROVIDERS.has(m.provider));
    const localModels = models.filter((m) => LOCAL_PROVIDERS.has(m.provider));

    // Phase 1: Run all cloud models in parallel
    const cloudResults = await Promise.all(
      cloudModels.map((model) =>
        runSingleModel(benchmark, model, project, username),
      ),
    );

    // Phase 2: Run local models sequentially (shared GPU)
    const localResults = [];
    for (const model of localModels) {
      localResults.push(
        await runSingleModel(benchmark, model, project, username),
      );
    }

    const results = [...cloudResults, ...localResults];

    const completedAt = new Date().toISOString();
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed && !r.error).length;
    const errored = results.filter((r) => r.error).length;

    const run = {
      id: runId,
      benchmarkId: benchmark.id,
      project,
      models: results,
      summary: {
        total: results.length,
        passed,
        failed,
        errored,
      },
      startedAt,
      completedAt,
    };

    // Persist run
    const db = getDb();
    if (db) {
      await db.collection(RUNS_COL).insertOne(run);
    }

    logger.success(
      `[benchmark] Run ${runId} complete — ${passed}/${results.length} passed` +
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

  async update(id, project, updates) {
    const db = getDb();
    if (!db) throw new Error("Database not available");

    const allowed = [
      "name",
      "prompt",
      "systemPrompt",
      "expectedValue",
      "matchMode",
      "temperature",
      "maxTokens",
      "tags",
    ];
    const $set = { updatedAt: new Date().toISOString() };
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        $set[key] = updates[key];
      }
    }

    const result = await db
      .collection(BENCHMARKS_COL)
      .findOneAndUpdate({ id, project }, { $set }, { returnDocument: "after" });

    return result;
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

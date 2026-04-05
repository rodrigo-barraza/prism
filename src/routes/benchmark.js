import express from "express";
import { EventEmitter } from "node:events";
import BenchmarkService from "../services/BenchmarkService.js";
import logger from "../utils/logger.js";

const router = express.Router();

// Process-level registry of in-flight benchmark runs → AbortControllers
// Used by the explicit POST /benchmark/abort/:runId endpoint.
const activeRuns = new Map();

// Pub/sub for live benchmark progress — allows reconnecting clients
// to receive events from an already-running benchmark.
const runEmitters = new Map();   // benchmarkId → EventEmitter
const runStates = new Map();     // benchmarkId → { completedResults, activeModel, startedAt }

// ============================================================
// GET /benchmark — List all benchmark tests for the caller's project
// ============================================================

router.get("/", async (req, res, next) => {
  try {
    const benchmarks = await BenchmarkService.list(req.project);

    // Attach latest run summary + cumulative cost across ALL runs
    const enriched = await Promise.all(
      benchmarks.map(async (b) => {
        const [latestRun, allRuns] = await Promise.all([
          BenchmarkService.getLatestRun(b.id, req.project),
          BenchmarkService.getRuns(b.id, req.project),
        ]);
        const cumulativeCost = allRuns.reduce(
          (sum, r) => sum + (r.summary?.totalCost || 0),
          0,
        );
        return {
          ...b,
          cumulativeCost,
          runCount: allRuns.length,
          latestRun: latestRun
            ? { id: latestRun.id, summary: latestRun.summary, completedAt: latestRun.completedAt }
            : null,
        };
      }),
    );

    res.json({ benchmarks: enriched, count: enriched.length });
  } catch (error) {
    logger.error(`GET /benchmark error: ${error.message}`);
    next(error);
  }
});

// ============================================================
// GET /benchmark/models — List available conversation models for benchmarking
// ============================================================

router.get("/models", (_req, res) => {
  const models = BenchmarkService.getConversationModels();
  res.json({ models, count: models.length });
});

// ============================================================
// GET /benchmark/active-list — List all benchmarks with active runs
// ============================================================
// Returns an array of benchmark IDs that currently have in-progress runs.
// Used by the benchmark list page to show running indicators on cards.

router.get("/active-list", (_req, res) => {
  const activeIds = [...runStates.keys()];
  res.json({ activeIds });
});

// ============================================================
// POST /benchmark — Create a new benchmark test
// ============================================================

router.post("/", async (req, res, next) => {
  try {
    const { name, prompt, systemPrompt, expectedValue, matchMode, temperature, maxTokens, tags, assertions, assertionOperator } =
      req.body;

    if (!name || !prompt || !expectedValue) {
      return res
        .status(400)
        .json({ error: "Missing required fields: name, prompt, expectedValue" });
    }

    const validModes = Object.values(BenchmarkService.MATCH_MODES);

    // Validate top-level matchMode (backward compat)
    if (matchMode && !validModes.includes(matchMode)) {
      return res.status(400).json({
        error: `Invalid matchMode. Must be one of: ${validModes.join(", ")}`,
      });
    }

    // Validate assertions array if provided
    if (assertions && Array.isArray(assertions)) {
      for (const a of assertions) {
        if (a.matchMode && !validModes.includes(a.matchMode)) {
          return res.status(400).json({
            error: `Invalid matchMode in assertion. Must be one of: ${validModes.join(", ")}`,
          });
        }
      }
    }

    if (assertionOperator && !["AND", "OR"].includes(assertionOperator)) {
      return res.status(400).json({
        error: "Invalid assertionOperator. Must be AND or OR.",
      });
    }

    const benchmark = await BenchmarkService.create(
      { name, prompt, systemPrompt, expectedValue, matchMode, temperature, maxTokens, tags, assertions, assertionOperator },
      req.project,
      req.username,
    );

    res.status(201).json(benchmark);
  } catch (error) {
    logger.error(`POST /benchmark error: ${error.message}`);
    next(error);
  }
});


// ============================================================
// GET /benchmark/:id — Get a single benchmark test + latest run
// ============================================================

router.get("/:id", async (req, res, next) => {
  try {
    const benchmark = await BenchmarkService.getById(req.params.id, req.project);
    if (!benchmark) {
      return res.status(404).json({ error: "Benchmark not found" });
    }

    const latestRun = await BenchmarkService.getLatestRun(benchmark.id, req.project);

    res.json({ ...benchmark, latestRun: latestRun || null });
  } catch (error) {
    logger.error(`GET /benchmark/:id error: ${error.message}`);
    next(error);
  }
});


// ============================================================
// DELETE /benchmark/:id — Delete a benchmark test and its runs
// ============================================================

router.delete("/:id", async (req, res, next) => {
  try {
    const existing = await BenchmarkService.getById(req.params.id, req.project);
    if (!existing) {
      return res.status(404).json({ error: "Benchmark not found" });
    }

    await BenchmarkService.remove(req.params.id, req.project);
    res.json({ deleted: true, id: req.params.id });
  } catch (error) {
    logger.error(`DELETE /benchmark/:id error: ${error.message}`);
    next(error);
  }
});

// ============================================================
// POST /benchmark/:id/run — Execute a benchmark against models (SSE)
// ============================================================
// Body (optional):
//   { models: [{ provider: "openai", model: "gpt-5.4" }, ...] }
// If models is omitted, all available conversation models are tested.
//
// Streams SSE events:
//   model_start   { provider, model, label }
//   model_complete { ...result }
//   run_complete  { ...run }

router.post("/:id/run", async (req, res) => {
  try {
    const benchmark = await BenchmarkService.getById(req.params.id, req.project);
    if (!benchmark) {
      return res.status(404).json({ error: "Benchmark not found" });
    }

    // Disable Node's default socket/request timeout for long-running SSE streams
    req.setTimeout(0);
    if (req.socket) req.socket.setTimeout(0);

    // Set up SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Abort controller — wired to client disconnect AND explicit abort endpoint
    const abortController = new AbortController();
    let clientClosed = false;

    const registryKey = req.params.id;
    activeRuns.set(registryKey, abortController);

    // Set up pub/sub emitter and state for live reconnection
    const emitter = new EventEmitter();
    emitter.setMaxListeners(20);
    runEmitters.set(registryKey, emitter);
    runStates.set(registryKey, {
      completedResults: [],
      activeModel: null,
      totalModels: 0,
      startedAt: new Date().toISOString(),
    });

    // Keepalive: send SSE comment ping every 15s to prevent proxy/browser timeouts
    const keepalive = setInterval(() => {
      if (clientClosed) return;
      try {
        res.write(":keepalive\n\n");
      } catch { /* client already gone */ }
    }, 15_000);

    const cleanup = () => {
      clientClosed = true;
      clearInterval(keepalive);
      activeRuns.delete(registryKey);
      runEmitters.delete(registryKey);
      runStates.delete(registryKey);
    };

    req.on("close", () => {
      cleanup();
      abortController.abort();
    });

    const send = (type, data) => {
      if (clientClosed) return;
      try {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      } catch { /* client already gone */ }
    };

    const { models: modelTargets } = req.body || {};

    const run = await BenchmarkService.runBenchmark(
      benchmark,
      modelTargets,
      req.project,
      req.username,
      {
        signal: abortController.signal,
        onRunStart: (info) => {
          // Store total model count for reconnecting clients
          const state = runStates.get(registryKey);
          if (state) state.totalModels = info.totalModels;
          emitter.emit("event", { type: "run_info", totalModels: info.totalModels });
          send("run_info", { totalModels: info.totalModels });
        },
        onModelStart: (model) => {
          const data = {
            provider: model.provider,
            model: model.model,
            label: model.label,
            isLocal: !!model.isLocal,
          };
          // Update live state for followers
          const state = runStates.get(registryKey);
          if (state) state.activeModel = data;
          // Emit to followers
          emitter.emit("event", { type: "model_start", ...data });
          // Send to original connection
          send("model_start", data);
        },
        onModelComplete: (result) => {
          // Update live state for followers
          const state = runStates.get(registryKey);
          if (state) {
            state.completedResults.push(result);
            state.activeModel = null;
          }
          // Emit to followers
          emitter.emit("event", { type: "model_complete", ...result });
          // Send to original connection
          send("model_complete", result);
        },
      },
    );

    // Emit run_complete to followers before cleanup
    emitter.emit("event", { type: "run_complete", ...run });

    cleanup();
    send("run_complete", run);
    if (!clientClosed) res.end();
  } catch (error) {
    logger.error(`POST /benchmark/:id/run error: ${error.message}`);
    if (res.headersSent) {
      try {
        res.write(`data: ${JSON.stringify({ type: "error", message: error.message })}\n\n`);
        res.end();
      } catch { /* client already gone */ }
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// ============================================================
// POST /benchmark/:id/abort — Explicitly cancel a running benchmark
// ============================================================

router.post("/:id/abort", (req, res) => {
  const controller = activeRuns.get(req.params.id);
  if (controller) {
    logger.info(`[benchmark] Explicit abort requested for benchmark ${req.params.id}`);
    controller.abort();
    activeRuns.delete(req.params.id);
    res.json({ aborted: true });
  } else {
    res.json({ aborted: false, message: "No active run found for this benchmark" });
  }
});


// ============================================================
// GET /benchmark/:id/active — Check if a benchmark has an active run
// ============================================================
// Returns the current live state (completed results, active model)
// so reconnecting clients can catch up immediately.

router.get("/:id/active", (req, res) => {
  const state = runStates.get(req.params.id);
  if (!state) {
    return res.json({ active: false });
  }
  res.json({
    active: true,
    totalModels: state.totalModels,
    completedResults: state.completedResults,
    activeModel: state.activeModel,
    startedAt: state.startedAt,
  });
});

// ============================================================
// GET /benchmark/:id/follow — Reconnect to an in-progress run (SSE)
// ============================================================
// Replays completed results, then streams live events from the
// running benchmark. Allows clients that navigated away and
// returned to see live progress without starting a new run.

router.get("/:id/follow", (req, res) => {
  const state = runStates.get(req.params.id);
  const emitter = runEmitters.get(req.params.id);
  if (!state || !emitter) {
    return res.status(404).json({ error: "No active run for this benchmark" });
  }

  // Disable timeouts
  req.setTimeout(0);
  if (req.socket) req.socket.setTimeout(0);

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send total model count first so the client knows the denominator
  res.write(`data: ${JSON.stringify({ type: "run_info", totalModels: state.totalModels })}\n\n`);

  // Replay completed results
  for (const result of state.completedResults) {
    res.write(`data: ${JSON.stringify({ type: "model_complete", ...result })}\n\n`);
  }

  // Send active model if one is currently running
  if (state.activeModel) {
    res.write(`data: ${JSON.stringify({ type: "model_start", ...state.activeModel })}\n\n`);
  }

  // Subscribe to live events going forward
  const handler = (event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch { /* follower disconnected */ }
  };
  emitter.on("event", handler);

  // Keepalive
  const keepalive = setInterval(() => {
    try { res.write(":keepalive\n\n"); }
    catch { /* gone */ }
  }, 15_000);

  req.on("close", () => {
    emitter.off("event", handler);
    clearInterval(keepalive);
  });
});

// ============================================================
// GET /benchmark/:id/runs — Get all past runs for a benchmark
// ============================================================

router.get("/:id/runs", async (req, res, next) => {
  try {
    const benchmark = await BenchmarkService.getById(req.params.id, req.project);
    if (!benchmark) {
      return res.status(404).json({ error: "Benchmark not found" });
    }

    const runs = await BenchmarkService.getRuns(benchmark.id, req.project);
    res.json({ runs, count: runs.length });
  } catch (error) {
    logger.error(`GET /benchmark/:id/runs error: ${error.message}`);
    next(error);
  }
});

// ============================================================
// POST /benchmark/:id/runs/:runId/rerun — Re-run with same models
// ============================================================

router.post("/:id/runs/:runId/rerun", async (req, res, next) => {
  try {
    const benchmark = await BenchmarkService.getById(req.params.id, req.project);
    if (!benchmark) {
      return res.status(404).json({ error: "Benchmark not found" });
    }

    const previousRun = await BenchmarkService.getRunById(req.params.runId, req.project);
    if (!previousRun) {
      return res.status(404).json({ error: "Run not found" });
    }

    // Re-run with the same model set from the previous run
    const modelTargets = previousRun.models.map((m) => ({
      provider: m.provider,
      model: m.model,
    }));

    const run = await BenchmarkService.runBenchmark(
      benchmark,
      modelTargets,
      req.project,
      req.username,
    );

    res.json(run);
  } catch (error) {
    logger.error(`POST /benchmark/:id/runs/:runId/rerun error: ${error.message}`);
    next(error);
  }
});

export default router;

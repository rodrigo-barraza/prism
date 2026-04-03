import express from "express";
import BenchmarkService from "../services/BenchmarkService.js";
import logger from "../utils/logger.js";

const router = express.Router();

// ============================================================
// GET /benchmark — List all benchmark tests for the caller's project
// ============================================================

router.get("/", async (req, res, next) => {
  try {
    const benchmarks = await BenchmarkService.list(req.project);
    res.json({ benchmarks, count: benchmarks.length });
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
// POST /benchmark — Create a new benchmark test
// ============================================================

router.post("/", async (req, res, next) => {
  try {
    const { name, prompt, systemPrompt, expectedValue, matchMode, temperature, maxTokens, tags } =
      req.body;

    if (!name || !prompt || !expectedValue) {
      return res
        .status(400)
        .json({ error: "Missing required fields: name, prompt, expectedValue" });
    }

    const validModes = Object.values(BenchmarkService.MATCH_MODES);
    if (matchMode && !validModes.includes(matchMode)) {
      return res.status(400).json({
        error: `Invalid matchMode. Must be one of: ${validModes.join(", ")}`,
      });
    }

    const benchmark = await BenchmarkService.create(
      { name, prompt, systemPrompt, expectedValue, matchMode, temperature, maxTokens, tags },
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
// PUT /benchmark/:id — Update a benchmark test
// ============================================================

router.put("/:id", async (req, res, next) => {
  try {
    const existing = await BenchmarkService.getById(req.params.id, req.project);
    if (!existing) {
      return res.status(404).json({ error: "Benchmark not found" });
    }

    if (req.body.matchMode) {
      const validModes = Object.values(BenchmarkService.MATCH_MODES);
      if (!validModes.includes(req.body.matchMode)) {
        return res.status(400).json({
          error: `Invalid matchMode. Must be one of: ${validModes.join(", ")}`,
        });
      }
    }

    const updated = await BenchmarkService.update(req.params.id, req.project, req.body);
    res.json(updated);
  } catch (error) {
    logger.error(`PUT /benchmark/:id error: ${error.message}`);
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
// POST /benchmark/:id/run — Execute a benchmark against models
// ============================================================
// Body (optional):
//   { models: [{ provider: "openai", model: "gpt-5.4" }, ...], concurrency: 3 }
// If models is omitted, all available conversation models are tested.

router.post("/:id/run", async (req, res, next) => {
  try {
    const benchmark = await BenchmarkService.getById(req.params.id, req.project);
    if (!benchmark) {
      return res.status(404).json({ error: "Benchmark not found" });
    }

    const { models: modelTargets } = req.body || {};

    const run = await BenchmarkService.runBenchmark(
      benchmark,
      modelTargets,
      req.project,
      req.username,
    );

    res.json(run);
  } catch (error) {
    logger.error(`POST /benchmark/:id/run error: ${error.message}`);
    next(error);
  }
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

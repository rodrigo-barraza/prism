import { Router } from "express";
import logger from "../utils/logger.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";

const router = Router();
const COLLECTION = "vram_benchmarks";

function getDb() {
  const client = MongoWrapper.getClient(MONGO_DB_NAME);
  if (!client) return null;
  return client.db(MONGO_DB_NAME);
}

/**
 * GET /vram-benchmarks
 * Returns all benchmark entries, with optional query filters.
 *
 * Query params:
 *   settings  — filter by settings label (default: "default")
 *   hostname  — filter by system.hostname
 *   ctx       — filter by contextLength (number)
 *   limit     — max documents (default: 1000)
 */
router.get("/", async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "Database not available" });

    const filter = { error: null };

    if (req.query.settings) {
      filter["settings.label"] = req.query.settings;
    }
    if (req.query.hostname) {
      filter["system.hostname"] = req.query.hostname;
    }
    if (req.query.ctx) {
      filter.contextLength = parseInt(req.query.ctx);
    }

    const limit = Math.min(parseInt(req.query.limit) || 1000, 5000);

    const projection = {
      _id: 0,
      displayName: 1,
      model: 1,
      contextLength: 1,
      modelVramGiB: 1,
      modelVramMiB: 1,
      estimatedGiB: 1,
      fileSizeGB: 1,
      fileSizeBytes: 1,
      tokensPerSecond: 1,
      quantization: 1,
      architecture: 1,
      bitsPerWeight: 1,
      loadTimeMs: 1,
      "settings.label": 1,
      "system.hostname": 1,
      "system.gpu.name": 1,
      "system.gpu.totalMiB": 1,
      "system.cpu.model": 1,
      "system.ram.totalGiB": 1,
      createdAt: 1,
    };

    const docs = await db
      .collection(COLLECTION)
      .find(filter, { projection })
      .sort({ modelVramGiB: 1 })
      .limit(limit)
      .toArray();

    res.json({ count: docs.length, data: docs });
  } catch (error) {
    logger.error(`GET /vram-benchmarks error: ${error.message}`);
    next(error);
  }
});

/**
 * GET /vram-benchmarks/machines
 * Returns distinct machines that have run benchmarks.
 */
router.get("/machines", async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "Database not available" });

    const pipeline = [
      { $match: { "system.hostname": { $exists: true } } },
      {
        $group: {
          _id: "$system.hostname",
          gpu: { $first: "$system.gpu.name" },
          gpuVramMiB: { $first: "$system.gpu.totalMiB" },
          cpu: { $first: "$system.cpu.model" },
          ramGiB: { $first: "$system.ram.totalGiB" },
          benchmarkCount: { $sum: 1 },
          lastRun: { $max: "$createdAt" },
        },
      },
      { $sort: { benchmarkCount: -1 } },
    ];

    const machines = await db
      .collection(COLLECTION)
      .aggregate(pipeline)
      .toArray();

    res.json(
      machines.map((m) => ({
        hostname: m._id,
        gpu: m.gpu,
        gpuVramGB: m.gpuVramMiB ? Math.round(m.gpuVramMiB / 1024) : null,
        cpu: m.cpu,
        ramGiB: m.ramGiB,
        benchmarkCount: m.benchmarkCount,
        lastRun: m.lastRun,
      })),
    );
  } catch (error) {
    logger.error(`GET /vram-benchmarks/machines error: ${error.message}`);
    next(error);
  }
});

export default router;

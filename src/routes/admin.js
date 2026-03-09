import express from "express";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME, ADMIN_SECRET } from "../../secrets.js";
import { getProvider } from "../providers/index.js";
import logger from "../utils/logger.js";
import os from "os";

const router = express.Router();
const REQUESTS_COL = "requests";
const CONVERSATIONS_COL = "conversations";

// ── Admin auth middleware ────────────────────────────────────
function adminAuth(req, res, next) {
  const secret = req.headers["x-admin-secret"];
  if (!secret || secret !== ADMIN_SECRET) {
    return res
      .status(401)
      .json({ error: true, message: "Unauthorized — invalid x-admin-secret" });
  }
  next();
}

router.use(adminAuth);

// ── Helper: get DB handle ────────────────────────────────────
function getDb() {
  const client = MongoWrapper.getClient(MONGO_DB_NAME);
  if (!client) return null;
  return client.db(MONGO_DB_NAME);
}

// ============================================================
// GET /admin/requests — paginated, filtered request logs
// ============================================================
router.get("/requests", async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "Database not available" });

    const {
      page = 1,
      limit = 50,
      project,
      username,
      provider,
      model,
      endpoint,
      success,
      from,
      to,
      sort = "timestamp",
      order = "desc",
    } = req.query;

    const filter = {};
    if (project) filter.project = project;
    if (username) filter.username = username;
    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (endpoint) filter.endpoint = endpoint;
    if (success !== undefined) filter.success = success === "true";
    if (from || to) {
      filter.timestamp = {};
      if (from) filter.timestamp.$gte = from;
      if (to) filter.timestamp.$lte = to;
    }

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const lim = parseInt(limit, 10);
    const sortDir = order === "asc" ? 1 : -1;

    const [docs, total] = await Promise.all([
      db
        .collection(REQUESTS_COL)
        .find(filter)
        .sort({ [sort]: sortDir })
        .skip(skip)
        .limit(lim)
        .toArray(),
      db.collection(REQUESTS_COL).countDocuments(filter),
    ]);

    res.json({ data: docs, total, page: parseInt(page, 10), limit: lim });
  } catch (error) {
    logger.error(`Admin /requests error: ${error.message}`);
    next(error);
  }
});

// ============================================================
// GET /admin/requests/:id — single request detail
// ============================================================
router.get("/requests/:id", async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "Database not available" });

    const doc = await db
      .collection(REQUESTS_COL)
      .findOne({ requestId: req.params.id });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    res.json(doc);
  } catch (error) {
    logger.error(`Admin /requests/:id error: ${error.message}`);
    next(error);
  }
});

// ============================================================
// GET /admin/stats — aggregate stats
// ============================================================
router.get("/stats", async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "Database not available" });

    const { from, to } = req.query;
    const match = {};
    if (from || to) {
      match.timestamp = {};
      if (from) match.timestamp.$gte = from;
      if (to) match.timestamp.$lte = to;
    }

    const pipeline = [
      ...(Object.keys(match).length ? [{ $match: match }] : []),
      {
        $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
          totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
          totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
          avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
          avgTokensPerSec: { $avg: { $ifNull: ["$tokensPerSec", 0] } },
          successCount: {
            $sum: { $cond: [{ $eq: ["$success", true] }, 1, 0] },
          },
          errorCount: {
            $sum: { $cond: [{ $eq: ["$success", false] }, 1, 0] },
          },
        },
      },
    ];

    const [result] = await db
      .collection(REQUESTS_COL)
      .aggregate(pipeline)
      .toArray();

    res.json(
      result || {
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        avgLatency: 0,
        avgTokensPerSec: 0,
        successCount: 0,
        errorCount: 0,
      },
    );
  } catch (error) {
    logger.error(`Admin /stats error: ${error.message}`);
    next(error);
  }
});

// ============================================================
// GET /admin/stats/projects — per-project breakdown
// ============================================================
router.get("/stats/projects", async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "Database not available" });

    const pipeline = [
      {
        $group: {
          _id: "$project",
          totalRequests: { $sum: 1 },
          totalTokens: {
            $sum: {
              $add: [
                { $ifNull: ["$inputTokens", 0] },
                { $ifNull: ["$outputTokens", 0] },
              ],
            },
          },
          totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
          avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
          lastRequest: { $max: "$timestamp" },
        },
      },
      { $sort: { totalRequests: -1 } },
    ];

    const results = await db
      .collection(REQUESTS_COL)
      .aggregate(pipeline)
      .toArray();

    res.json(
      results.map((r) => ({
        project: r._id || "unknown",
        totalRequests: r.totalRequests,
        totalTokens: r.totalTokens,
        totalCost: r.totalCost,
        avgLatency: r.avgLatency,
        lastRequest: r.lastRequest,
      })),
    );
  } catch (error) {
    logger.error(`Admin /stats/projects error: ${error.message}`);
    next(error);
  }
});

// ============================================================
// GET /admin/stats/users — per-user breakdown
// ============================================================
router.get("/stats/users", async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "Database not available" });

    const pipeline = [
      {
        $group: {
          _id: "$username",
          totalRequests: { $sum: 1 },
          totalTokens: {
            $sum: {
              $add: [
                { $ifNull: ["$inputTokens", 0] },
                { $ifNull: ["$outputTokens", 0] },
              ],
            },
          },
          totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
          avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
          lastRequest: { $max: "$timestamp" },
        },
      },
      { $sort: { totalRequests: -1 } },
    ];

    const results = await db
      .collection(REQUESTS_COL)
      .aggregate(pipeline)
      .toArray();

    res.json(
      results.map((r) => ({
        username: r._id || "unknown",
        totalRequests: r.totalRequests,
        totalTokens: r.totalTokens,
        totalCost: r.totalCost,
        avgLatency: r.avgLatency,
        lastRequest: r.lastRequest,
      })),
    );
  } catch (error) {
    logger.error(`Admin /stats/users error: ${error.message}`);
    next(error);
  }
});

// ============================================================
// GET /admin/stats/models — per-model breakdown
// ============================================================
router.get("/stats/models", async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "Database not available" });

    const pipeline = [
      {
        $group: {
          _id: { model: "$model", provider: "$provider" },
          totalRequests: { $sum: 1 },
          totalTokens: {
            $sum: {
              $add: [
                { $ifNull: ["$inputTokens", 0] },
                { $ifNull: ["$outputTokens", 0] },
              ],
            },
          },
          totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
          avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
        },
      },
      { $sort: { totalRequests: -1 } },
    ];

    const results = await db
      .collection(REQUESTS_COL)
      .aggregate(pipeline)
      .toArray();

    res.json(
      results.map((r) => ({
        model: r._id.model,
        provider: r._id.provider,
        totalRequests: r.totalRequests,
        totalTokens: r.totalTokens,
        totalCost: r.totalCost,
        avgLatency: r.avgLatency,
      })),
    );
  } catch (error) {
    logger.error(`Admin /stats/models error: ${error.message}`);
    next(error);
  }
});

// ============================================================
// GET /admin/stats/endpoints — per-endpoint breakdown
// ============================================================
router.get("/stats/endpoints", async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "Database not available" });

    const pipeline = [
      {
        $group: {
          _id: "$endpoint",
          totalRequests: { $sum: 1 },
          totalTokens: {
            $sum: {
              $add: [
                { $ifNull: ["$inputTokens", 0] },
                { $ifNull: ["$outputTokens", 0] },
              ],
            },
          },
          totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
          avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
          successRate: { $avg: { $cond: [{ $eq: ["$success", true] }, 1, 0] } },
        },
      },
      { $sort: { totalRequests: -1 } },
    ];

    const results = await db
      .collection(REQUESTS_COL)
      .aggregate(pipeline)
      .toArray();

    res.json(
      results.map((r) => ({
        endpoint: r._id || "unknown",
        totalRequests: r.totalRequests,
        totalTokens: r.totalTokens,
        totalCost: r.totalCost,
        avgLatency: r.avgLatency,
        successRate: r.successRate,
      })),
    );
  } catch (error) {
    logger.error(`Admin /stats/endpoints error: ${error.message}`);
    next(error);
  }
});

// ============================================================
// GET /admin/stats/timeline — requests grouped by hour/day
// ============================================================
router.get("/stats/timeline", async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "Database not available" });

    const { hours = 24 } = req.query;
    const since = new Date(
      Date.now() - parseInt(hours, 10) * 60 * 60 * 1000,
    ).toISOString();

    const pipeline = [
      { $match: { timestamp: { $gte: since } } },
      {
        $group: {
          _id: { $substr: ["$timestamp", 0, 13] }, // group by hour
          requests: { $sum: 1 },
          tokens: {
            $sum: {
              $add: [
                { $ifNull: ["$inputTokens", 0] },
                { $ifNull: ["$outputTokens", 0] },
              ],
            },
          },
          cost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ];

    const results = await db
      .collection(REQUESTS_COL)
      .aggregate(pipeline)
      .toArray();

    res.json(
      results.map((r) => ({
        hour: r._id,
        requests: r.requests,
        tokens: r.tokens,
        cost: r.cost,
      })),
    );
  } catch (error) {
    logger.error(`Admin /stats/timeline error: ${error.message}`);
    next(error);
  }
});

// ============================================================
// GET /admin/conversations — cross-project conversation list
// ============================================================
router.get("/conversations", async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "Database not available" });

    const {
      page = 1,
      limit = 50,
      project,
      username,
      search,
      sort = "updatedAt",
      order = "desc",
    } = req.query;

    const filter = {};
    if (project) filter.project = project;
    if (username) filter.username = username;
    if (search) filter.title = { $regex: search, $options: "i" };

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const lim = parseInt(limit, 10);
    const sortDir = order === "asc" ? 1 : -1;

    const [docs, total] = await Promise.all([
      db
        .collection(CONVERSATIONS_COL)
        .find(filter)
        .project({
          id: 1,
          project: 1,
          username: 1,
          title: 1,
          createdAt: 1,
          updatedAt: 1,
          messageCount: { $size: { $ifNull: ["$messages", []] } },
        })
        .sort({ [sort]: sortDir })
        .skip(skip)
        .limit(lim)
        .toArray(),
      db.collection(CONVERSATIONS_COL).countDocuments(filter),
    ]);

    res.json({ data: docs, total, page: parseInt(page, 10), limit: lim });
  } catch (error) {
    logger.error(`Admin /conversations error: ${error.message}`);
    next(error);
  }
});

// ============================================================
// GET /admin/conversations/:id — single conversation, full msgs
// ============================================================
router.get("/conversations/:id", async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "Database not available" });

    const doc = await db
      .collection(CONVERSATIONS_COL)
      .findOne({ id: req.params.id });
    if (!doc)
      return res.status(404).json({ error: "Conversation not found" });

    res.json(doc);
  } catch (error) {
    logger.error(`Admin /conversations/:id error: ${error.message}`);
    next(error);
  }
});

// ============================================================
// GET /admin/live — conversations updated in last N minutes
// ============================================================
router.get("/live", async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "Database not available" });

    const { minutes = 5 } = req.query;
    const since = new Date(
      Date.now() - parseInt(minutes, 10) * 60 * 1000,
    ).toISOString();

    const [rawConversations, recentRequests] = await Promise.all([
      db
        .collection(CONVERSATIONS_COL)
        .find({ updatedAt: { $gte: since } })
        .project({
          id: 1,
          project: 1,
          username: 1,
          title: 1,
          updatedAt: 1,
          messages: 1,
          isGenerating: 1,
        })
        .sort({ updatedAt: -1 })
        .toArray(),
      db
        .collection(REQUESTS_COL)
        .find({ timestamp: { $gte: since } })
        .sort({ timestamp: -1 })
        .limit(20)
        .toArray(),
    ]);

    // Enrich conversations with lastMessage info and remap fields
    const conversations = rawConversations.map((c) => {
      const msgs = c.messages || [];
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      let lastMessageText = null;
      if (lastMsg) {
        const content = lastMsg.content;
        if (typeof content === "string") {
          lastMessageText = content;
        } else if (Array.isArray(content)) {
          const textPart = content.find((p) => p.type === "text");
          lastMessageText = textPart?.text || null;
        }
      }
      return {
        id: c.id,
        project: c.project,
        username: c.username,
        title: c.title,
        lastActivity: c.updatedAt,
        messageCount: msgs.length,
        lastMessage: lastMessageText,
        lastMessageRole: lastMsg?.role || null,
        isGenerating: c.isGenerating || false,
      };
    });

    // Calc requests per minute
    const totalRecent = await db
      .collection(REQUESTS_COL)
      .countDocuments({ timestamp: { $gte: since } });
    const requestsPerMinute = totalRecent / parseInt(minutes, 10);

    res.json({
      conversations,
      recentRequests,
      requestsPerMinute: Math.round(requestsPerMinute * 100) / 100,
      activeCount: conversations.length,
    });
  } catch (error) {
    logger.error(`Admin /live error: ${error.message}`);
    next(error);
  }
});

// ============================================================
// GET /admin/health — system health
// ============================================================
router.get("/health", async (_req, res) => {
  const db = getDb();
  const mongoStatus = db ? "connected" : "disconnected";

  let dbStats = null;
  if (db) {
    try {
      const [requestCount, conversationCount] = await Promise.all([
        db.collection(REQUESTS_COL).estimatedDocumentCount(),
        db.collection(CONVERSATIONS_COL).estimatedDocumentCount(),
      ]);
      dbStats = { requestCount, conversationCount };
    } catch {
      // ignore
    }
  }

  res.json({
    status: mongoStatus === "connected" ? "healthy" : "degraded",
    mongo: mongoStatus,
    dbStats,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    system: {
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
    },
  });
});

// ============================================================
// LM Studio — Model Management
// ============================================================

/**
 * GET /admin/lm-studio/models
 * List all models available in LM Studio (loaded + downloaded).
 */
router.get("/lm-studio/models", async (_req, res, next) => {
  try {
    const provider = getProvider("lm-studio");
    const data = await provider.listModels();
    res.json(data);
  } catch (error) {
    logger.error(`Admin /lm-studio/models error: ${error.message}`);
    next(error);
  }
});

/**
 * POST /admin/lm-studio/load
 * Load a model into LM Studio. Auto-unloads any other loaded model first
 * to enforce single-model-at-a-time.
 * Body: { model: "model-key" }
 */
router.post("/lm-studio/load", async (req, res, next) => {
  try {
    const { model } = req.body;
    if (!model) {
      return res.status(400).json({ error: true, message: "Missing 'model' in request body" });
    }

    const provider = getProvider("lm-studio");

    // Enforce single model — unload anything currently loaded that isn't the requested model
    try {
      const { models } = await provider.listModels();
      for (const m of models || []) {
        for (const instance of m.loaded_instances || []) {
          if (instance.id !== model) {
            logger.info(`Auto-unloading ${instance.id} before loading ${model}`);
            await provider.unloadModel(instance.id);
          }
        }
      }
    } catch (listErr) {
      logger.warn(`Could not list models before loading: ${listErr.message}`);
    }

    const data = await provider.loadModel(model);
    res.json(data);
  } catch (error) {
    logger.error(`Admin /lm-studio/load error: ${error.message}`);
    next(error);
  }
});

/**
 * POST /admin/lm-studio/unload
 * Unload a model from LM Studio memory.
 * Body: { instance_id: "model-instance-id" }
 */
router.post("/lm-studio/unload", async (req, res, next) => {
  try {
    const { instance_id } = req.body;
    if (!instance_id) {
      return res.status(400).json({ error: true, message: "Missing 'instance_id' in request body" });
    }

    const provider = getProvider("lm-studio");
    const data = await provider.unloadModel(instance_id);
    res.json(data);
  } catch (error) {
    logger.error(`Admin /lm-studio/unload error: ${error.message}`);
    next(error);
  }
});

export default router;

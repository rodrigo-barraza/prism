import { Router } from "express";
import logger from "../utils/logger.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";

const router = Router();
const REQUESTS_COL = "requests";

function getDb() {
  const client = MongoWrapper.getClient(MONGO_DB_NAME);
  if (!client) return null;
  return client.db(MONGO_DB_NAME);
}

/**
 * GET /stats/models
 * Per-model usage stats scoped to the current user (req.username).
 * Returns: [{ model, provider, totalRequests }]
 */
router.get("/models", async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "Database not available" });

    const username = req.username;
    if (!username) return res.json([]);

    const pipeline = [
      { $match: { username } },
      {
        $group: {
          _id: { model: "$model", provider: "$provider" },
          totalRequests: { $sum: 1 },
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
      })),
    );
  } catch (error) {
    logger.error(`GET /stats/models error: ${error.message}`);
    next(error);
  }
});

export default router;

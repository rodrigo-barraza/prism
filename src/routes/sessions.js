import { Router } from "express";
import logger from "../utils/logger.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";

const router = Router();
const SESSIONS_COL = "sessions";
const CONVERSATIONS_COL = "conversations";

function getDb() {
  const client = MongoWrapper.getClient(MONGO_DB_NAME);
  if (!client) return null;
  return client.db(MONGO_DB_NAME);
}

/**
 * GET /sessions
 * List sessions.
 */
router.get("/", async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "Database not available" });

    const { limit = 50, page = 1 } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const lim = parseInt(limit, 10);

    const [docs, total] = await Promise.all([
      db
        .collection(SESSIONS_COL)
        .find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(lim)
        .toArray(),
      db.collection(SESSIONS_COL).countDocuments(),
    ]);

    res.json({ data: docs, total, page: parseInt(page, 10), limit: lim });
  } catch (error) {
    logger.error(`GET /sessions error: ${error.message}`);
    next(error);
  }
});

/**
 * GET /sessions/:id
 * Get a single session with its conversations.
 */
router.get("/:id", async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "Database not available" });

    const session = await db
      .collection(SESSIONS_COL)
      .findOne({ id: req.params.id });
    if (!session) return res.status(404).json({ error: "Session not found" });

    // Fetch linked conversations (without message bodies)
    let conversations = [];
    if (
      Array.isArray(session.conversationIds) &&
      session.conversationIds.length > 0
    ) {
      conversations = await db
        .collection(CONVERSATIONS_COL)
        .find({ id: { $in: session.conversationIds } })
        .project({ messages: 0 })
        .toArray();
    }

    res.json({ ...session, conversations });
  } catch (error) {
    logger.error(`GET /sessions/:id error: ${error.message}`);
    next(error);
  }
});

export default router;

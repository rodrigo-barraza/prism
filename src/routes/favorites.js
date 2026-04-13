import express from "express";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";

const router = express.Router();
import { COLLECTIONS } from "../constants.js";

const COLLECTION = COLLECTIONS.FAVORITES;

/**
 * GET /favorites?type=model
 * List favorites, optionally filtered by type.
 */
router.get("/", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;
    const filter = { project, username };
    if (req.query.type) filter.type = req.query.type;

    const favorites = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.json(favorites);
  } catch (error) {
    logger.error(`Error fetching favorites: ${error.message}`);
    next(error);
  }
});

/**
 * POST /favorites
 * Add a favorite. Body: { type, key, meta? }
 * - type: "model", "workflow", "conversation", etc.
 * - key: unique identifier within the type (e.g. "openai:gpt-4o")
 * - meta: optional metadata object (e.g. { provider, name })
 */
router.post("/", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;
    const { type, key, meta } = req.body;

    if (!type || !key) {
      return res.status(400).json({ error: "type and key are required" });
    }

    const doc = {
      project,
      username,
      type,
      key,
      meta: meta || {},
      createdAt: new Date().toISOString(),
    };

    // Upsert to prevent duplicates
    await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .updateOne(
        { project, username, type, key },
        { $set: doc },
        { upsert: true },
      );

    res.json({ success: true, favorite: doc });
  } catch (error) {
    logger.error(`Error adding favorite: ${error.message}`);
    next(error);
  }
});

/**
 * DELETE /favorites?type=model&key=openai:gpt-4o
 * Remove a specific favorite by type + key.
 */
router.delete("/", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;
    const { type, key } = req.query;

    if (!type || !key) {
      return res
        .status(400)
        .json({ error: "type and key query params are required" });
    }

    const result = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .deleteOne({ project, username, type, key });

    res.json({ success: true, deleted: result.deletedCount });
  } catch (error) {
    logger.error(`Error removing favorite: ${error.message}`);
    next(error);
  }
});

export default router;

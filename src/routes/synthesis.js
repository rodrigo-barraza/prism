import express from "express";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";

const router = express.Router();
import { COLLECTIONS } from "../constants.js";

const COLLECTION = COLLECTIONS.SYNTHESIS;

/**
 * GET /synthesis
 * List all synthesis runs for the current project/user.
 */
router.get("/", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;
    const runs = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .find({ project, username })
      .sort({ updatedAt: -1 })
      .toArray();

    res.json(runs);
  } catch (error) {
    logger.error(`Error fetching synthesis runs: ${error.message}`);
    next(error);
  }
});

/**
 * GET /synthesis/:id
 * Get a specific synthesis run.
 */
router.get("/:id", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;
    const run = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .findOne({ id: req.params.id, project, username });

    if (!run) {
      return res.status(404).json({ error: "Synthesis run not found" });
    }

    res.json(run);
  } catch (error) {
    logger.error(`Error fetching synthesis run: ${error.message}`);
    next(error);
  }
});

/**
 * POST /synthesis
 * Create a new synthesis run.
 */
router.post("/", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;
    const {
      id,
      title,
      systemPrompt,
      userPersona,
      category,
      targetTurns,
      seedMessages,
      settings,
      conversationId,
    } = req.body;

    if (!id) {
      return res.status(400).json({ error: "id is required" });
    }

    const now = new Date().toISOString();
    const doc = {
      id,
      project,
      username,
      title: title || "Untitled Synthesis",
      systemPrompt: systemPrompt || "",

      userPersona: userPersona || "",
      category: category || "Chat",
      targetTurns: targetTurns || 4,
      seedMessages: seedMessages || [],
      settings: settings || {},
      conversationId: conversationId || null,
      createdAt: now,
      updatedAt: now,
    };

    await client.db(MONGO_DB_NAME).collection(COLLECTION).insertOne(doc);

    res.json(doc);
  } catch (error) {
    logger.error(`Error creating synthesis run: ${error.message}`);
    next(error);
  }
});

/**
 * PATCH /synthesis/:id
 * Update specific fields of a synthesis run.
 */
router.patch("/:id", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;
    const allowedFields = [
      "title",
      "systemPrompt",
      "assistantPersona",
      "userPersona",
      "category",
      "targetTurns",
      "seedMessages",
      "settings",
      "conversationId",
    ];

    const setFields = { updatedAt: new Date().toISOString() };
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        setFields[field] = req.body[field];
      }
    }

    const result = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .updateOne({ id: req.params.id, project, username }, { $set: setFields });

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Synthesis run not found" });
    }

    const updated = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .findOne({ id: req.params.id, project, username });

    res.json(updated);
  } catch (error) {
    logger.error(`Error patching synthesis run: ${error.message}`);
    next(error);
  }
});

/**
 * DELETE /synthesis/:id
 * Delete a specific synthesis run.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;
    const result = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .deleteOne({ id: req.params.id, project, username });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Synthesis run not found" });
    }

    res.json({ success: true, id: req.params.id });
  } catch (error) {
    logger.error(`Error deleting synthesis run: ${error.message}`);
    next(error);
  }
});

export default router;

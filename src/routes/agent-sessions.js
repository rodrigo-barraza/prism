import express from "express";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import {
  computeModalities,
  extractProviders,
  computeTotalCost,
} from "../services/ConversationService.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import { COLLECTIONS } from "../constants.js";
import logger from "../utils/logger.js";

const router = express.Router();
const COLLECTION = COLLECTIONS.AGENT_SESSIONS;

/**
 * GET /agent-sessions
 * List all agent sessions for the given project.
 */
router.get("/", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;
    const sessions = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .find({ project, username })
      .sort({ updatedAt: -1 })
      .toArray();

    res.json(sessions);
  } catch (error) {
    logger.error(`Error fetching agent sessions: ${error.message}`);
    next(error);
  }
});

/**
 * GET /agent-sessions/:id
 * Get a specific agent session.
 */
router.get("/:id", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;
    const session = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .findOne({ id: req.params.id, project, username });

    if (!session) {
      return res.status(404).json({ error: "Agent session not found" });
    }

    res.json(session);
  } catch (error) {
    logger.error(`Error fetching agent session: ${error.message}`);
    next(error);
  }
});

/**
 * PATCH /agent-sessions/:id
 * Update specific fields of an agent session.
 */
router.patch("/:id", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;
    const { title, messages, systemPrompt, settings } = req.body;

    const setFields = { updatedAt: new Date().toISOString() };
    if (title !== undefined) setFields.title = title;
    if (messages !== undefined) {
      setFields.messages = messages;
      setFields.modalities = computeModalities(messages);
      setFields.providers = extractProviders(messages, settings);
      setFields.totalCost = computeTotalCost(messages);
    }
    if (systemPrompt !== undefined) setFields.systemPrompt = systemPrompt;
    if (settings !== undefined) {
      setFields.settings = { ...settings, systemPrompt: systemPrompt || "" };
    }

    const result = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .updateOne({ id: req.params.id, project, username }, { $set: setFields });

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Agent session not found" });
    }

    const session = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .findOne({ id: req.params.id, project, username });

    res.json(session);
  } catch (error) {
    logger.error(`Error patching agent session: ${error.message}`);
    next(error);
  }
});

/**
 * DELETE /agent-sessions/:id
 * Delete a specific agent session.
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
      return res.status(404).json({ error: "Agent session not found" });
    }

    res.json({ success: true, id: req.params.id });
  } catch (error) {
    logger.error(`Error deleting agent session: ${error.message}`);
    next(error);
  }
});

export default router;

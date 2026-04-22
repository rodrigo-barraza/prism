import express from "express";
import requireDb from "../middleware/RequireDbMiddleware.js";
import ConversationService, {
  buildConversationPatchFields,
} from "../services/ConversationService.js";
import { COLLECTIONS } from "../constants.js";
import logger from "../utils/logger.js";

const router = express.Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.CONVERSATIONS;

/**
 * GET /conversations
 * List all conversations for the given project.
 */
router.get("/", async (req, res, next) => {
  try {
    const { project, username, db } = req;
    const conversations = await db
      .collection(COLLECTION)
      .find({ project, username })
      .sort({ updatedAt: -1 })
      .toArray();

    res.json(conversations);
  } catch (error) {
    logger.error(`Error fetching conversations: ${error.message}`);
    next(error);
  }
});

/**
 * GET /conversations/:id
 * Get a specific conversation.
 */
router.get("/:id", async (req, res, next) => {
  try {
    const { project, username, db } = req;
    const conversation = await db
      .collection(COLLECTION)
      .findOne({ id: req.params.id, project, username });

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    res.json(conversation);
  } catch (error) {
    logger.error(`Error fetching conversation: ${error.message}`);
    next(error);
  }
});

/**
 * GET /conversations/:id/workflows
 * Find workflows that include this conversation ID.
 */
router.get("/:id/workflows", async (req, res, next) => {
  try {
    const { db } = req;

    const workflows = await db
      .collection("workflows")
      .find({ conversationIds: req.params.id })
      .project({ workflowName: 1, updatedAt: 1 })
      .toArray();

    res.json(workflows);
  } catch (error) {
    logger.error(`Error fetching conversation workflows: ${error.message}`);
    next(error);
  }
});

/**
 * POST /conversations/:id/messages
 * Append messages to an existing conversation (e.g. tool results after execution).
 */
router.post("/:id/messages", async (req, res, next) => {
  try {
    const { project, username } = req;
    const { messages, conversationMeta } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res
        .status(400)
        .json({ error: "messages must be a non-empty array" });
    }

    const conversation = await ConversationService.appendMessages(
      req.params.id,
      project,
      username,
      messages,
      conversationMeta || null,
    );

    res.json(conversation);
  } catch (error) {
    logger.error(`Error appending messages: ${error.message}`);
    next(error);
  }
});

/**
 * PATCH /conversations/:id
 * Update specific fields of a conversation (messages, title, systemPrompt, settings).
 * Used for non-generation mutations (edit/delete messages, rename, etc.).
 */
router.patch("/:id", async (req, res, next) => {
  try {
    const { project, username, db } = req;
    const setFields = buildConversationPatchFields(req.body);

    const result = await db
      .collection(COLLECTION)
      .updateOne({ id: req.params.id, project, username }, { $set: setFields });

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const conversation = await db
      .collection(COLLECTION)
      .findOne({ id: req.params.id, project, username });

    res.json(conversation);
  } catch (error) {
    logger.error(`Error patching conversation: ${error.message}`);
    next(error);
  }
});

/**
 * DELETE /conversations/:id
 * Delete a specific conversation.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const { project, username, db } = req;
    const result = await db
      .collection(COLLECTION)
      .deleteOne({ id: req.params.id, project, username });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    res.json({ success: true, id: req.params.id });
  } catch (error) {
    logger.error(`Error deleting conversation: ${error.message}`);
    next(error);
  }
});

export default router;

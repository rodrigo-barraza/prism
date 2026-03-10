import express from "express";
import crypto from "crypto";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";
import ConversationService, {
    extractFiles,
    computeModalities,
    extractProviders,
    computeTotalCost,
} from "../services/ConversationService.js";

const router = express.Router();
const COLLECTION = "conversations";

/**
 * POST /conversations/start
 * Create a conversation shell (or return existing one).
 * Body: { id?: string, title?: string, systemPrompt?: string, settings?: object }
 * Response: { id, ... }
 */
router.post("/start", async (req, res, next) => {
    try {
        const project = req.project || "default";
        const username = req.username || "default";
        const { id, title, systemPrompt, settings } = req.body;

        const conversation = await ConversationService.startConversation({
            id,
            project,
            username,
            title,
            systemPrompt,
            settings,
        });

        res.json(conversation);
    } catch (error) {
        logger.error(`Error starting conversation: ${error.message}`);
        next(error);
    }
});

/**
 * POST /conversations/:id/finalize
 * Update conversation metadata without re-sending messages.
 * Body: { title?: string, systemPrompt?: string, settings?: object, isGenerating?: boolean }
 * Response: updated conversation
 */
router.post("/:id/finalize", async (req, res, next) => {
    try {
        const project = req.project || "default";
        const username = req.username || "default";
        const { title, systemPrompt, settings, isGenerating } = req.body;

        const conversation = await ConversationService.finalizeConversation(
            req.params.id,
            project,
            username,
            { title, systemPrompt, settings, isGenerating },
        );

        if (!conversation) {
            return res.status(404).json({ error: "Conversation not found" });
        }

        res.json(conversation);
    } catch (error) {
        logger.error(`Error finalizing conversation: ${error.message}`);
        next(error);
    }
});

/**
 * GET /conversations
 * List all conversations for the given project.
 */
router.get("/", async (req, res, next) => {
    try {
        const client = MongoWrapper.getClient(MONGO_DB_NAME);
        if (!client) {
            return res.status(503).json({ error: "Database not available" });
        }

        const project = req.project || "default";
        const username = req.username || "default";
        const conversations = await client
            .db(MONGO_DB_NAME)
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
        const client = MongoWrapper.getClient(MONGO_DB_NAME);
        if (!client) {
            return res.status(503).json({ error: "Database not available" });
        }

        const project = req.project || "default";
        const username = req.username || "default";
        const conversation = await client
            .db(MONGO_DB_NAME)
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
 * POST /conversations
 * Create or update a conversation (full-message save — backward compatible).
 * Body: { id?: string, title?: string, messages: array, systemPrompt?: string, settings?: object }
 */
router.post("/", async (req, res, next) => {
    try {
        const client = MongoWrapper.getClient(MONGO_DB_NAME);
        if (!client) {
            return res.status(503).json({ error: "Database not available" });
        }

        const project = req.project || "default";
        const username = req.username || "default";
        const { id, title, messages, systemPrompt, settings, isGenerating } =
            req.body;

        // Extract base64 files to MinIO (if available)
        const processedMessages = await extractFiles(messages, project, username);

        const conversationId = id || crypto.randomUUID();
        const now = new Date().toISOString();

        const updateDoc = {
            $set: {
                id: conversationId,
                project,
                username,
                title: title || "New Conversation",
                messages: processedMessages || [],
                systemPrompt: systemPrompt || "",
                ...(settings
                    ? { settings: { ...settings, systemPrompt: systemPrompt || "" } }
                    : { settings: { systemPrompt: systemPrompt || "" } }),
                ...(isGenerating !== undefined ? { isGenerating } : {}),
                modalities: computeModalities(processedMessages),
                providers: extractProviders(processedMessages, settings),
                totalCost: computeTotalCost(processedMessages),
                updatedAt: now,
            },
            $setOnInsert: {
                createdAt: now,
            },
        };

        await client
            .db(MONGO_DB_NAME)
            .collection(COLLECTION)
            .updateOne({ id: conversationId, project, username }, updateDoc, {
                upsert: true,
            });

        // Fetch the updated/created doc
        const conversation = await client
            .db(MONGO_DB_NAME)
            .collection(COLLECTION)
            .findOne({ id: conversationId, project, username });

        res.json(conversation);
    } catch (error) {
        logger.error(`Error saving conversation: ${error.message}`);
        next(error);
    }
});

/**
 * DELETE /conversations/:id
 * Delete a specific conversation.
 */
router.delete("/:id", async (req, res, next) => {
    try {
        const client = MongoWrapper.getClient(MONGO_DB_NAME);
        if (!client) {
            return res.status(503).json({ error: "Database not available" });
        }

        const project = req.project || "default";
        const username = req.username || "default";
        const result = await client
            .db(MONGO_DB_NAME)
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

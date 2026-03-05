import express from 'express';
import crypto from 'crypto';
import MongoWrapper from '../wrappers/MongoWrapper.js';
import { MONGO_DB_NAME } from '../secrets.js';
import logger from '../utils/logger.js';

const router = express.Router();
const COLLECTION = 'conversations';

/**
 * GET /conversations
 * List all conversations for the given project.
 */
router.get('/', async (req, res, next) => {
    try {
        const client = MongoWrapper.getClient(MONGO_DB_NAME);
        if (!client) {
            return res.status(503).json({ error: 'Database not available' });
        }

        const project = req.project || 'default';
        const conversations = await client
            .db(MONGO_DB_NAME)
            .collection(COLLECTION)
            .find({ project })
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
router.get('/:id', async (req, res, next) => {
    try {
        const client = MongoWrapper.getClient(MONGO_DB_NAME);
        if (!client) {
            return res.status(503).json({ error: 'Database not available' });
        }

        const project = req.project || 'default';
        const conversation = await client
            .db(MONGO_DB_NAME)
            .collection(COLLECTION)
            .findOne({ id: req.params.id, project });

        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        res.json(conversation);
    } catch (error) {
        logger.error(`Error fetching conversation: ${error.message}`);
        next(error);
    }
});

/**
 * POST /conversations
 * Create or update a conversation.
 * Body: { id?: string, title?: string, messages: array, systemPrompt?: string, settings?: object }
 */
router.post('/', async (req, res, next) => {
    try {
        const client = MongoWrapper.getClient(MONGO_DB_NAME);
        if (!client) {
            return res.status(503).json({ error: 'Database not available' });
        }

        const project = req.project || 'default';
        const { id, title, messages, systemPrompt, settings } = req.body;

        const conversationId = id || crypto.randomUUID();
        const now = new Date().toISOString();

        const updateDoc = {
            $set: {
                id: conversationId,
                project,
                title: title || 'New Conversation',
                messages: messages || [],
                systemPrompt: systemPrompt || '',
                ...(settings ? { settings } : {}),
                updatedAt: now,
            },
            $setOnInsert: {
                createdAt: now,
            },
        };

        await client
            .db(MONGO_DB_NAME)
            .collection(COLLECTION)
            .updateOne({ id: conversationId, project }, updateDoc, { upsert: true });

        // Fetch the updated/created doc
        const conversation = await client
            .db(MONGO_DB_NAME)
            .collection(COLLECTION)
            .findOne({ id: conversationId, project });

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
router.delete('/:id', async (req, res, next) => {
    try {
        const client = MongoWrapper.getClient(MONGO_DB_NAME);
        if (!client) {
            return res.status(503).json({ error: 'Database not available' });
        }

        const project = req.project || 'default';
        const result = await client
            .db(MONGO_DB_NAME)
            .collection(COLLECTION)
            .deleteOne({ id: req.params.id, project });

        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        res.json({ success: true, id: req.params.id });
    } catch (error) {
        logger.error(`Error deleting conversation: ${error.message}`);
        next(error);
    }
});

export default router;

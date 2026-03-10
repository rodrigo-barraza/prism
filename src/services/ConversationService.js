import crypto from "crypto";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import FileService from "./FileService.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";

const COLLECTION = "conversations";

/**
 * Upload any base64 data URLs in message images/audio to external storage.
 * Replaces inline data with minio:// refs when MinIO is available.
 * @param {Array} messages
 * @param {string} project
 * @param {string} username
 * @returns {Promise<Array>} messages with refs replacing inline data
 */
export async function extractFiles(messages, project = null, username = null) {
    if (!messages || !FileService.isExternalStorage()) return messages;

    const processed = [];
    for (const msg of messages) {
        let updated = msg;

        // Handle images
        if (msg.images && msg.images.length > 0) {
            const category = msg.role === "assistant" ? "generations" : "uploads";
            const newImages = [];
            for (const img of msg.images) {
                if (FileService.isMinioRef(img) || img.startsWith("http")) {
                    newImages.push(img);
                    continue;
                }
                if (img.startsWith("data:")) {
                    try {
                        const { ref } = await FileService.uploadFile(
                            img,
                            category,
                            project,
                            username,
                        );
                        newImages.push(ref);
                    } catch (err) {
                        logger.error(`Failed to upload file: ${err.message}`);
                        newImages.push(img);
                    }
                } else {
                    newImages.push(img);
                }
            }
            updated = { ...updated, images: newImages };
        }

        // Handle audio data URLs
        if (
            updated.audio &&
            typeof updated.audio === "string" &&
            updated.audio.startsWith("data:")
        ) {
            const category = updated.role === "assistant" ? "generations" : "uploads";
            try {
                const { ref } = await FileService.uploadFile(
                    updated.audio,
                    category,
                    project,
                    username,
                );
                updated = { ...updated, audio: ref };
            } catch (err) {
                logger.error(`Failed to upload audio: ${err.message}`);
            }
        }

        processed.push(updated);
    }
    return processed;
}

/**
 * Compute input/output modalities from messages for lightweight querying.
 * @param {Array} messages
 * @returns {Object} modalities flags
 */
export function computeModalities(messages) {
    const mod = {
        textIn: false,
        textOut: false,
        imageIn: false,
        imageOut: false,
        audioIn: false,
        audioOut: false,
        docIn: false,
    };
    for (const m of messages || []) {
        const isUser = m.role === "user";
        const isAssistant = m.role === "assistant";
        if (m.content && (isUser || isAssistant)) {
            if (isUser) mod.textIn = true;
            if (isAssistant) mod.textOut = true;
        }
        if (m.images?.length > 0 || m.image) {
            if (isUser) mod.imageIn = true;
            if (isAssistant) mod.imageOut = true;
        }
        if (m.audio) {
            if (isUser) mod.audioIn = true;
            if (isAssistant) mod.audioOut = true;
        }
        if (
            m.documents?.length > 0 ||
            m.images?.some(
                (ref) =>
                    typeof ref === "string" &&
                    (ref.endsWith(".pdf") || ref.endsWith(".txt")),
            )
        ) {
            mod.docIn = true;
        }
    }
    return mod;
}

/**
 * Extract unique providers from messages and settings.
 * @param {Array} messages
 * @param {Object} settings
 * @returns {string[]}
 */
export function extractProviders(messages, settings) {
    const providers = new Set();
    for (const m of messages || []) {
        if (m.provider) providers.add(m.provider.toLowerCase());
    }
    if (settings?.provider) providers.add(settings.provider.toLowerCase());
    return [...providers];
}

/**
 * Compute total estimated cost across all messages.
 * @param {Array} messages
 * @returns {number}
 */
export function computeTotalCost(messages) {
    let total = 0;
    for (const m of messages || []) {
        if (m.estimatedCost) total += m.estimatedCost;
    }
    return total;
}

/**
 * ConversationService — shared logic for managing conversations in MongoDB.
 * Used by both the conversations REST API and generation routes.
 */
const ConversationService = {
    /**
     * Start (create) a conversation shell.
     * If a conversation with this ID already exists, returns it unchanged.
     *
     * @param {object} params
     * @param {string} [params.id] - Optional conversation ID (auto-generated if omitted)
     * @param {string} params.project
     * @param {string} params.username
     * @param {string} [params.title]
     * @param {string} [params.systemPrompt]
     * @param {object} [params.settings]
     * @returns {Promise<object>} The conversation document
     */
    async startConversation({
        id,
        project,
        username,
        title,
        systemPrompt,
        settings,
    }) {
        const client = MongoWrapper.getClient(MONGO_DB_NAME);
        if (!client) throw new Error("Database not available");

        const conversationId = id || crypto.randomUUID();
        const now = new Date().toISOString();

        await client
            .db(MONGO_DB_NAME)
            .collection(COLLECTION)
            .updateOne(
                { id: conversationId, project, username },
                {
                    $setOnInsert: {
                        id: conversationId,
                        project,
                        username,
                        title: title || "New Conversation",
                        messages: [],
                        systemPrompt: systemPrompt || "",
                        settings: {
                            ...(settings || {}),
                            systemPrompt: systemPrompt || "",
                        },
                        modalities: computeModalities([]),
                        providers: extractProviders([], settings),
                        totalCost: 0,
                        createdAt: now,
                        updatedAt: now,
                    },
                },
                { upsert: true },
            );

        return client
            .db(MONGO_DB_NAME)
            .collection(COLLECTION)
            .findOne({ id: conversationId, project, username });
    },

    /**
     * Append messages to an existing conversation.
     * Handles file extraction (MinIO upload) and recomputes derived fields.
     *
     * @param {string} conversationId
     * @param {string} project
     * @param {string} username
     * @param {Array} newMessages - Messages to append
     * @returns {Promise<object>} The updated conversation document
     */
    async appendMessages(conversationId, project, username, newMessages) {
        const client = MongoWrapper.getClient(MONGO_DB_NAME);
        if (!client) throw new Error("Database not available");

        // Extract files (upload base64 data to MinIO)
        const processedMessages = await extractFiles(
            newMessages,
            project,
            username,
        );

        const now = new Date().toISOString();

        // Push new messages and update timestamp
        await client
            .db(MONGO_DB_NAME)
            .collection(COLLECTION)
            .updateOne(
                { id: conversationId, project, username },
                {
                    $push: { messages: { $each: processedMessages } },
                    $set: { updatedAt: now },
                },
            );

        // Fetch the updated doc to recompute derived fields
        const conversation = await client
            .db(MONGO_DB_NAME)
            .collection(COLLECTION)
            .findOne({ id: conversationId, project, username });

        if (!conversation) {
            throw new Error(`Conversation not found: ${conversationId}`);
        }

        // Recompute derived fields from full message list
        await client
            .db(MONGO_DB_NAME)
            .collection(COLLECTION)
            .updateOne(
                { id: conversationId, project, username },
                {
                    $set: {
                        modalities: computeModalities(conversation.messages),
                        providers: extractProviders(
                            conversation.messages,
                            conversation.settings,
                        ),
                        totalCost: computeTotalCost(conversation.messages),
                    },
                },
            );

        return client
            .db(MONGO_DB_NAME)
            .collection(COLLECTION)
            .findOne({ id: conversationId, project, username });
    },

    /**
     * Finalize a conversation — update metadata without re-sending messages.
     *
     * @param {string} conversationId
     * @param {string} project
     * @param {string} username
     * @param {object} updates - { title?, systemPrompt?, settings?, isGenerating? }
     * @returns {Promise<object>} The updated conversation document
     */
    async finalizeConversation(conversationId, project, username, updates) {
        const client = MongoWrapper.getClient(MONGO_DB_NAME);
        if (!client) throw new Error("Database not available");

        const setFields = { updatedAt: new Date().toISOString() };
        if (updates.title !== undefined) setFields.title = updates.title;
        if (updates.systemPrompt !== undefined)
            setFields.systemPrompt = updates.systemPrompt;
        if (updates.settings !== undefined) {
            setFields.settings = {
                ...updates.settings,
                systemPrompt: updates.systemPrompt || "",
            };
        }
        if (updates.isGenerating !== undefined)
            setFields.isGenerating = updates.isGenerating;

        await client
            .db(MONGO_DB_NAME)
            .collection(COLLECTION)
            .updateOne(
                { id: conversationId, project, username },
                { $set: setFields },
            );

        return client
            .db(MONGO_DB_NAME)
            .collection(COLLECTION)
            .findOne({ id: conversationId, project, username });
    },
};

export default ConversationService;

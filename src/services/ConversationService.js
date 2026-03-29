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
    webSearch: false,
    codeExecution: false,
    functionCalling: false,
    thinking: false,
  };

  const WEB_SEARCH_NAMES = new Set(["web_search", "web_search_preview"]);
  const CODE_EXEC_NAMES = new Set(["code_execution"]);

  for (const m of messages || []) {
    if (m.deleted) continue;
    const isUser = m.role === "user";
    const isAssistant = m.role === "assistant";
    if (m.content && (isUser || isAssistant)) {
      // liveTranscription = the content is a speech-to-text transcript
      // from the Live API, not typed text — don't count as textIn.
      if (isUser && !m.liveTranscription) mod.textIn = true;
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

    // Classify tool calls by type
    if (m.toolCalls?.length > 0) {
      for (const tc of m.toolCalls) {
        const name = (tc.name || "").toLowerCase();
        if (WEB_SEARCH_NAMES.has(name)) {
          mod.webSearch = true;
        } else if (CODE_EXEC_NAMES.has(name)) {
          mod.codeExecution = true;
        } else {
          mod.functionCalling = true;
        }
      }
    }

    // Detect inline web search results (from streaming)
    if (
      isAssistant &&
      typeof m.content === "string" &&
      m.content.includes("> **Sources:**")
    ) {
      mod.webSearch = true;
    }

    // Detect inline code execution blocks (from streaming)
    if (
      isAssistant &&
      typeof m.content === "string" &&
      m.content.includes("```exec-")
    ) {
      mod.codeExecution = true;
    }

    // Tool result messages — mark as function calling
    // (web_search and code_execution results are inlined, not stored as role:"tool")
    if (m.role === "tool") {
      mod.functionCalling = true;
    }

    // Detect thinking / reasoning
    if (isAssistant && m.thinking) {
      mod.thinking = true;
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
    if (m.deleted) continue;
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
    if (m.deleted) continue;
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
     * Append messages to a conversation, auto-creating it if it doesn't exist.
     * Handles file extraction (MinIO upload) and recomputes derived fields.
     * Optionally applies conversation metadata (title, systemPrompt, settings).
     *
     * @param {string} conversationId
     * @param {string} project
     * @param {string} username
     * @param {Array} newMessages - Messages to append
     * @param {object} [conversationMeta] - Optional metadata to set on the conversation
     * @param {string} [conversationMeta.title]
     * @param {string} [conversationMeta.systemPrompt]
     * @param {object} [conversationMeta.settings]

     * @returns {Promise<object>} The updated conversation document
     */
  async appendMessages(
    conversationId,
    project,
    username,
    newMessages,
    conversationMeta = null,
  ) {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) throw new Error("Database not available");

    const db = client.db(MONGO_DB_NAME);
    const col = db.collection(COLLECTION);

    // Auto-create conversation if it doesn't exist
    const existing = await col.findOne({
      id: conversationId,
      project,
      username,
    });
    if (!existing) {
      const now = new Date().toISOString();
      const metaSettings = conversationMeta?.settings || {};
      const metaSysPrompt = conversationMeta?.systemPrompt || "";
      await col.insertOne({
        id: conversationId,
        project,
        username,
        title: conversationMeta?.title || "New Conversation",
        messages: [],
        systemPrompt: metaSysPrompt,
        settings: { ...metaSettings, systemPrompt: metaSysPrompt },
        modalities: computeModalities([]),
        providers: extractProviders([], metaSettings),
        totalCost: 0,
        isGenerating: true,

        createdAt: now,
        updatedAt: now,
      });
    }

    // Extract files (upload base64 data to MinIO)
    const processedMessages = await extractFiles(
      newMessages,
      project,
      username,
    );

    const now = new Date().toISOString();

    // Build $set — always update timestamp
    const setFields = { updatedAt: now };

    // Apply conversationMeta if provided (title, settings, systemPrompt)
    if (conversationMeta) {
      if (conversationMeta.title !== undefined) {
        setFields.title = conversationMeta.title;
      }
      if (conversationMeta.systemPrompt !== undefined) {
        setFields.systemPrompt = conversationMeta.systemPrompt;
      }
      if (conversationMeta.settings !== undefined) {
        setFields.settings = {
          ...conversationMeta.settings,
          systemPrompt: conversationMeta.systemPrompt || "",
        };
      }
    }

    // Push new messages and apply updates
    await col.updateOne(
      { id: conversationId, project, username },
      {
        $push: { messages: { $each: processedMessages } },
        $set: setFields,
      },
    );

    // Fetch the updated doc to recompute derived fields
    const conversation = await col.findOne({
      id: conversationId,
      project,
      username,
    });

    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    // Recompute derived fields from full message list
    await col.updateOne(
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

    return col.findOne({ id: conversationId, project, username });
  },

  /**
   * Set or clear the isGenerating flag on a conversation.
   * Lightweight update — only touches isGenerating + updatedAt.
   *
   * @param {string} conversationId
   * @param {string} project
   * @param {string} username
   * @param {boolean} generating
   */
  async setGenerating(conversationId, project, username, generating) {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) return;

    const db = client.db(MONGO_DB_NAME);
    const now = new Date().toISOString();

    if (generating) {
      // Upsert — create a conversation stub if it doesn't exist yet
      // (e.g. Lupos sends a brand-new conversationId that hasn't been persisted)
      await db.collection(COLLECTION).updateOne(
        { id: conversationId, project, username },
        {
          $set: { isGenerating: true, updatedAt: now },
          $setOnInsert: {
            title: "New Conversation",
            messages: [],
            systemPrompt: "",
            settings: {},
            modalities: computeModalities([]),
            providers: [],
            totalCost: 0,
            createdAt: now,
          },
        },
        { upsert: true },
      );
    } else {
      await db
        .collection(COLLECTION)
        .updateOne(
          { id: conversationId, project, username },
          { $set: { isGenerating: false, updatedAt: now } },
        );
    }
  },
};

export default ConversationService;

import crypto from "crypto";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { getProvider } from "../providers/index.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import EmbeddingService from "./EmbeddingService.js";
import RequestLogger from "./RequestLogger.js";
import logger from "../utils/logger.js";
import { cosineSimilarity, calculateTokensPerSec } from "../utils/math.js";
import { estimateTokens } from "../utils/CostCalculator.js";
import { TYPES, getPricing } from "../config.js";
import { COLLECTIONS } from "../constants.js";
import SettingsService from "./SettingsService.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Single unified collection for all agent memories. */
const COLLECTION = COLLECTIONS.MEMORIES;

const EXTRACTION_PROVIDER_DEFAULT = "anthropic";
const EXTRACTION_MODEL_DEFAULT = "claude-haiku-4-5-20251001";

/** Resolve the current extraction provider + model from settings. */
async function getExtractionConfig() {
  try {
    const mem = await SettingsService.getSection("memory");
    return {
      provider: mem.extractionProvider || EXTRACTION_PROVIDER_DEFAULT,
      model: mem.extractionModel || EXTRACTION_MODEL_DEFAULT,
    };
  } catch {
    return { provider: EXTRACTION_PROVIDER_DEFAULT, model: EXTRACTION_MODEL_DEFAULT };
  }
}

/**
 * Duplicate detection threshold — two memories with cosine similarity above
 * this are considered duplicates and the newer one is skipped.
 */
const DUPLICATE_THRESHOLD = 0.92;

/**
 * Minimum cosine similarity for a memory to be considered relevant during search.
 */
const RELEVANCE_THRESHOLD = 0.3;

/**
 * Valid memory types — inspired by Claude Code's memdir taxonomy.
 *
 * Memories are constrained to these types. LUPOS additionally uses its own
 * category values (personal, preference, gaming, etc.) stored in the `type`
 * field — the schema is flexible per agent.
 */
const CODING_MEMORY_TYPES = ["user", "feedback", "project", "reference"];


// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate an embedding for text via EmbeddingService.
 * @param {string} text
 * @param {object} [options] - Extra options forwarded to EmbeddingService
 * @returns {Promise<number[]>}
 */
async function generateEmbedding(text, options = {}) {
  return EmbeddingService.embed(text, { source: "memory", ...options });
}

/**
 * Calculate days elapsed since a timestamp.
 */
function memoryAgeDays(createdAt) {
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/**
 * Human-readable age string. Models are poor at date arithmetic —
 * "47 days ago" triggers staleness reasoning better than a raw ISO timestamp.
 */
function memoryAge(createdAt) {
  const d = memoryAgeDays(createdAt);
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  return `${d} days ago`;
}

/**
 * Staleness caveat for memories >1 day old.
 * Returns empty string for fresh memories.
 */
function freshnessCaveat(createdAt) {
  const d = memoryAgeDays(createdAt);
  if (d <= 1) return "";
  return ` ⚠️ ${d} days old — verify against current code before acting on this.`;
}


// ─── LUPOS Fact Extraction ────────────────────────────────────────────────────

/**
 * Call an AI provider to extract facts from a conversation.
 * Returns an array of { fact, aboutUserId, aboutUsername, category, confidence }.
 * @param {Array} messages - Recent conversation messages
 * @param {Array} participants - Array of { id, username, displayName }
 * @returns {Promise<Array>}
 */
async function extractFactsFromConversation(messages, participants, meta = {}) {
  const endpoint = meta.endpoint || null;
  const agent = meta.agent || null;
  const { provider: extractionProvider, model: extractionModel } = await getExtractionConfig();
  const provider = getProvider(extractionProvider);
  const requestId = crypto.randomUUID();
  const requestStart = performance.now();

  const participantList = participants
    .map(
      (p) =>
        `- ID: ${p.id}, Username: ${p.username}, Display: ${p.displayName || p.username}`,
    )
    .join("\n");

  const conversationText = messages
    .map((m) => `${m.name || m.role}: ${m.content}`)
    .join("\n");

  const systemPrompt = `You are a memory extraction system. Analyze the conversation and extract notable personal facts about the participants. Focus on:
- Personal information (location, occupation, hobbies, pets, family)
- Preferences (favorite things, likes, dislikes)
- Life events (moving, new job, relationships, achievements)
- Notable opinions or beliefs they express about themselves
- Information one user reveals about another user

Do NOT extract:
- Transient conversation topics (what they're currently discussing)
- Greetings, jokes, or casual banter
- Bot commands or technical requests
- Things the AI assistant says about itself
- Opinions about external topics (politics, movies, etc) unless they reveal something personal

For each fact, identify which user it's about. If a user mentions something about another user, the fact is ABOUT the other user but SOURCED from the speaker.

Respond ONLY with a JSON array. Each object must have:
- "fact": string — the personal fact in a concise sentence
- "aboutUserId": string — the Discord user ID this fact is about
- "aboutUsername": string — the username of the person this fact is about
- "sourceUserId": string — who said/revealed this (can be same as aboutUserId)
- "sourceUsername": string — username of the source
- "category": string — one of: "personal", "preference", "gaming", "work", "family", "hobby", "location", "relationship", "achievement", "other"
- "confidence": number — 0.0 to 1.0, how confident this is a real personal fact

If no facts are found, return an empty array: []

Here are the participants:
${participantList}`;

  const aiMessages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Extract personal facts from this conversation:\n\n${conversationText}`,
    },
  ];

  let result;
  let success = true;
  let errorMessage = null;

  try {
    result = await provider.generateText(aiMessages, extractionModel, {
      maxTokens: 1000,
      temperature: 0.1,
    });
  } catch (err) {
    success = false;
    errorMessage = err.message;
    throw err;
  } finally {
    const totalSec = (performance.now() - requestStart) / 1000;
    const inputText = aiMessages.map((m) => m.content).join("\n");
    const approxInputTokens = estimateTokens(inputText);
    const approxOutputTokens = result ? estimateTokens(result.text || "") : 0;
    const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[extractionModel];
    let estimatedCost = null;
    if (pricing) {
      const inputCost = (approxInputTokens / 1_000_000) * (pricing.inputPerMillion || 0);
      const outputCost = (approxOutputTokens / 1_000_000) * (pricing.outputPerMillion || 0);
      estimatedCost = parseFloat((inputCost + outputCost).toFixed(8));
    }

    RequestLogger.log({
      requestId,
      endpoint,
      operation: "memory:extract",
      project: meta.project || null,
      username: meta.username || "system",
      clientIp: null,
      provider: extractionProvider,
      model: extractionModel,
      sessionId: meta.sessionId || null,
      agent,
      success,
      errorMessage,
      estimatedCost,
      inputTokens: approxInputTokens,
      outputTokens: approxOutputTokens,
      tokensPerSec: calculateTokensPerSec(approxOutputTokens, totalSec),
      inputCharacters: inputText.length,
      totalTime: parseFloat(totalSec.toFixed(3)),
      modalities: { textIn: true, textOut: true },
      requestPayload: {
        operation: "memory:extract",
        participantCount: participants.length,
        messageCount: messages.length,
      },
      responsePayload: success
        ? { textPreview: (result?.text || "").slice(0, 200) }
        : { error: errorMessage },
    });
  }

  const text = result.text || "";

  // Parse JSON from the response (handle markdown code blocks)
  let jsonText = text.trim();
  const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonText = jsonMatch[1].trim();
  }

  try {
    const facts = JSON.parse(jsonText);
    if (!Array.isArray(facts)) return [];
    // Validate each fact has the required fields
    return facts.filter(
      (f) =>
        f.fact &&
        f.aboutUserId &&
        f.aboutUsername &&
        typeof f.confidence === "number" &&
        f.confidence >= 0.5,
    );
  } catch {
    logger.warn(
      "[MemoryService] Failed to parse extraction result:",
      jsonText.substring(0, 200),
    );
    return [];
  }
}


// ─── Unified Memory Service ──────────────────────────────────────────────────

/**
 * MemoryService — unified, agent-scoped memory system.
 *
 * All memories live in a single `memories` collection. Every document carries
 * an `agent` field ("LUPOS", "CODING", etc.) and all queries filter by it,
 * ensuring complete isolation between agents.
 *
 * LUPOS memories: personal facts about Discord users (guild-scoped)
 * CODING memories: project knowledge from coding sessions (project-scoped)
 */
const MemoryService = {

  // ── Store ──────────────────────────────────────────────────────────────────

  /**
   * Store a single memory with embedding generation and duplicate detection.
   *
   * @param {object} params
   * @param {string} params.agent - Agent identifier ("LUPOS", "CODING", etc.)
   * @param {string} [params.project] - Project identifier
   * @param {string} [params.username] - Who created this memory
   * @param {string} [params.type] - Memory type (e.g. "user", "feedback", "project", "reference", "personal")
   * @param {string} [params.title] - Short name (used for relevance scanning)
   * @param {string} params.content - Full memory text
   * @param {number[]} [params.embedding] - Pre-computed embedding (if omitted, generated from title+content)
   * @param {object} [params.metadata] - Agent-specific metadata (guildId, aboutUserId, etc.)
   * @param {string} [params.conversationId] - Source conversation
   * @returns {Promise<object|null>} Stored memory document, or null if duplicate
   */
  async store({ agent, project, username, type, title, content, embedding, metadata = {}, conversationId, sessionId, endpoint }) {
    if (!agent) throw new Error("MemoryService.store requires an agent identifier");
    if (!content) throw new Error("MemoryService.store requires content");

    // Validate type for CODING agent
    if (agent === "CODING") {
      type = CODING_MEMORY_TYPES.includes(type) ? type : "project";
    }

    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const embedText = title ? `${title}: ${content}` : content;

    // Generate embedding if not provided
    if (!embedding) {
      const embedOpts = { project };
      if (sessionId) embedOpts.sessionId = sessionId;
      if (endpoint) embedOpts.endpoint = endpoint;
      if (agent) embedOpts.agent = agent;
      embedding = await generateEmbedding(embedText, embedOpts);
    }

    // Duplicate detection — compare against existing memories for the same agent
    const dedupFilter = { agent };
    if (project) dedupFilter.project = project;
    if (metadata.guildId) dedupFilter.guildId = metadata.guildId;
    if (metadata.aboutUserId) dedupFilter.aboutUserId = metadata.aboutUserId;

    const existing = await collection
      .find(dedupFilter)
      .project({ embedding: 1 })
      .toArray();

    const isDuplicate = existing.some((doc) => {
      if (!doc.embedding) return false;
      return cosineSimilarity(embedding, doc.embedding) > DUPLICATE_THRESHOLD;
    });

    if (isDuplicate) {
      logger.info(
        `[MemoryService] Skipping duplicate for ${agent}: "${(title || content).substring(0, 60)}"`,
      );
      return null;
    }

    const now = new Date().toISOString();
    const memory = {
      id: crypto.randomUUID(),
      agent,
      project: project || null,
      username: username || null,
      type: type || "other",
      title: title || null,
      content,
      embedding,
      conversationId: conversationId || null,
      createdAt: now,
      updatedAt: now,
      // Spread agent-specific metadata at top level for efficient querying
      ...metadata,
    };

    await collection.insertOne(memory);
    logger.info(
      `[MemoryService] Stored [${agent}/${memory.type}] "${(title || content).substring(0, 60)}"`,
    );
    return memory;
  },

  // ── LUPOS: Extract & Store ─────────────────────────────────────────────────

  /**
   * Extract and store LUPOS memories from a Discord conversation chunk.
   *
   * @param {object} params
   * @param {string} params.guildId
   * @param {string} params.channelId
   * @param {Array} params.messages - Recent conversation messages
   * @param {Array} params.participants - Array of { id, username, displayName }
   * @param {string} [params.sourceMessageId]
   * @returns {Promise<Array>} The stored memory documents
   */
  async extractAndStore({
    guildId,
    channelId,
    messages,
    participants,
    sourceMessageId,
    sessionId,
    project,
    endpoint,
  }) {
    // Extract facts from the conversation via AI
    const facts = await extractFactsFromConversation(messages, participants, { project, sessionId, endpoint, agent: "LUPOS" });
    if (facts.length === 0) {
      logger.info(
        "[MemoryService] No personal facts extracted from conversation.",
      );
      return [];
    }

    logger.info(
      `[MemoryService] Extracted ${facts.length} fact(s), generating embeddings...`,
    );

    const storedMemories = [];

    for (const fact of facts) {
      try {
        const embedding = await generateEmbedding(fact.fact, { project, sessionId, endpoint, agent: "LUPOS" });

        const memory = await this.store({
          agent: "LUPOS",
          project: project || null,
          username: fact.sourceUsername || null,
          type: fact.category || "other",
          title: null,
          content: fact.fact,
          embedding,
          metadata: {
            guildId,
            channelId,
            aboutUserId: fact.aboutUserId,
            aboutUsername: fact.aboutUsername,
            sourceUserId: fact.sourceUserId,
            sourceUsername: fact.sourceUsername,
            confidence: fact.confidence,
            sourceMessageId: sourceMessageId || null,
          },
        });

        if (memory) {
          storedMemories.push(memory);
          logger.info(
            `[MemoryService] Stored: "${fact.fact.substring(0, 60)}..." (about: ${fact.aboutUsername})`,
          );
        }
      } catch (err) {
        logger.error(`[MemoryService] Failed to store fact: ${err.message}`);
      }
    }

    return storedMemories;
  },

  // ── Search ─────────────────────────────────────────────────────────────────

  /**
   * Search for relevant memories using cosine similarity.
   * Always scoped by `agent`.
   *
   * @param {object} params
   * @param {string} params.agent - Agent identifier
   * @param {string} [params.project] - Project identifier
   * @param {string} [params.guildId] - Guild filter (LUPOS)
   * @param {string[]} [params.userIds] - Filter to memories about these users (LUPOS)
   * @param {string} params.queryText - Text to search for
   * @param {number} [params.limit=10]
   * @returns {Promise<Array>} Relevant memories sorted by relevance
   */
  async search({ agent, project, guildId, userIds, queryText, limit = 10, sessionId, endpoint }) {
    if (!agent) throw new Error("MemoryService.search requires an agent identifier");

    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);

    // Generate embedding for the search query
    const embeddingOpts = {};
    if (sessionId) embeddingOpts.sessionId = sessionId;
    if (project) embeddingOpts.project = project;
    if (endpoint) embeddingOpts.endpoint = endpoint;
    if (agent) embeddingOpts.agent = agent;
    const queryEmbedding = await generateEmbedding(queryText, embeddingOpts);

    // Build the filter — always scoped by agent
    const filter = { agent };
    if (project) filter.project = project;
    if (guildId) filter.guildId = guildId;
    if (userIds && userIds.length > 0) {
      filter.aboutUserId = { $in: userIds };
    }

    // Fetch all memories matching the filter
    const memories = await collection
      .find(filter, {
        projection: {
          embedding: 1,
          type: 1,
          title: 1,
          content: 1,
          aboutUserId: 1,
          aboutUsername: 1,
          confidence: 1,
          createdAt: 1,
        },
      })
      .toArray();

    if (memories.length === 0) return [];

    // Compute cosine similarity and sort
    const scored = memories
      .filter((m) => m.embedding && m.embedding.length > 0)
      .map((m) => ({
        id: m._id,
        type: m.type || "other",
        title: m.title || (m.content ? m.content.substring(0, 60) : "untitled"),
        content: m.content || "",
        aboutUserId: m.aboutUserId,
        aboutUsername: m.aboutUsername,
        confidence: m.confidence,
        createdAt: m.createdAt,
        age: memoryAge(m.createdAt),
        ageDays: memoryAgeDays(m.createdAt),
        score: cosineSimilarity(queryEmbedding, m.embedding),
      }))
      .filter((m) => m.score > RELEVANCE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    logger.info(
      `[MemoryService] Search found ${scored.length} relevant memories for ${agent} (from ${memories.length} total)`,
    );

    return scored;
  },

  // ── List ────────────────────────────────────────────────────────────────────

  /**
   * List memories for a specific agent, optionally filtered by project/guild/user.
   *
   * @param {object} params
   * @param {string} params.agent - Agent identifier
   * @param {string} [params.project] - Project filter
   * @param {string} [params.guildId] - Guild filter (LUPOS)
   * @param {string} [params.userId] - User filter (LUPOS — aboutUserId)
   * @param {number} [params.limit=50]
   * @param {number} [params.skip=0]
   * @returns {Promise<{ memories: Array, total: number }>}
   */
  async list({ agent, project, guildId, userId, limit = 50, skip = 0 }) {
    if (!agent) throw new Error("MemoryService.list requires an agent identifier");

    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);

    const filter = { agent };
    if (project) filter.project = project;
    if (guildId) filter.guildId = guildId;
    if (userId) filter.aboutUserId = userId;

    const [memories, total] = await Promise.all([
      collection
        .find(filter, { projection: { embedding: 0 } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      collection.countDocuments(filter),
    ]);

    return { memories, total };
  },

  // ── Delete / Remove ────────────────────────────────────────────────────────

  /**
   * Delete a specific memory by its id field.
   *
   * @param {string} memoryId
   * @returns {Promise<boolean>} Whether a document was deleted
   */
  async delete(memoryId) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const result = await collection.deleteOne({ id: memoryId });
    return result.deletedCount > 0;
  },

  /**
   * Alias for delete — used by callers that preferred the AgentMemoryService naming.
   */
  async remove(memoryId) {
    return this.delete(memoryId);
  },

  // ── Update ─────────────────────────────────────────────────────────────────

  /**
   * Update an existing memory.
   *
   * @param {string} memoryId
   * @param {object} updates - Fields to update (title, content, type)
   * @returns {Promise<boolean>}
   */
  async update(memoryId, { title, content, type }) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);

    const $set = { updatedAt: new Date().toISOString() };
    if (title !== undefined) $set.title = title;
    if (content !== undefined) $set.content = content;
    if (type !== undefined) $set.type = type;

    // Re-generate embedding if content changed
    if (content !== undefined) {
      const doc = await collection.findOne({ id: memoryId }, { projection: { project: 1, title: 1 } });
      const embedText = (title || doc?.title) ? `${title || doc?.title}: ${content}` : content;
      $set.embedding = await generateEmbedding(embedText, { project: doc?.project });
    }

    const result = await collection.updateOne({ id: memoryId }, { $set });
    return result.modifiedCount > 0;
  },

  // ── Format ─────────────────────────────────────────────────────────────────

  /**
   * Format memories for injection into the system prompt.
   * Adds type badges and staleness caveats.
   *
   * @param {Array} memories - Array from search()
   * @returns {string} Formatted text block
   */
  formatForPrompt(memories) {
    if (!memories || memories.length === 0) return "";

    return memories
      .map((m) => {
        const badge = `[${m.type}]`;
        const age = m.age !== "today" ? ` (${m.age})` : "";
        const caveat = freshnessCaveat(m.createdAt);
        return `- ${badge} **${m.title}**${age}: ${m.content}${caveat}`;
      })
      .join("\n");
  },

  // ── Indexes ────────────────────────────────────────────────────────────────

  /**
   * Ensure indexes exist on the unified memories collection.
   */
  async ensureIndexes() {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return;

    const collection = db.collection(COLLECTION);

    // Primary lookup: by agent + project (covers CODING queries)
    await collection.createIndex({ agent: 1, project: 1 });
    // LUPOS queries: agent + guild + user
    await collection.createIndex({ agent: 1, guildId: 1, aboutUserId: 1 });
    // Type-filtered queries
    await collection.createIndex({ agent: 1, project: 1, type: 1 });
    // Unique ID
    await collection.createIndex({ id: 1 }, { unique: true });
    // Chronological listing
    await collection.createIndex({ createdAt: -1 });

    logger.info("[MemoryService] Indexes ensured on unified memories collection.");
  },
};

export default MemoryService;

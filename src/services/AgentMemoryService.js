import crypto from "crypto";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import EmbeddingService from "./EmbeddingService.js";
import logger from "../utils/logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const COLLECTION = "agent_memories";

/**
 * Valid memory types — inspired by Claude Code's memdir taxonomy.
 *
 * Memories are constrained to four types capturing context NOT derivable
 * from the current project state. Code patterns, architecture, git history,
 * and file structure are derivable (via grep/git/file reads) and should NOT
 * be saved as memories.
 */
const MEMORY_TYPES = ["user", "feedback", "project", "reference"];

/**
 * Duplicate detection threshold — two memories with cosine similarity above
 * this are considered duplicates and the newer one is skipped.
 */
const DUPLICATE_THRESHOLD = 0.92;

/**
 * Minimum cosine similarity for a memory to be considered relevant during search.
 */
const RELEVANCE_THRESHOLD = 0.3;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Generate an embedding vector for the given text.
 */
async function generateEmbedding(text) {
  return EmbeddingService.embed(text, { source: "agent-memory" });
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
 * Returns empty string for fresh memories — warning there is noise.
 */
function freshnessCaveat(createdAt) {
  const d = memoryAgeDays(createdAt);
  if (d <= 1) return "";
  return ` ⚠️ ${d} days old — verify against current code before acting on this.`;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * AgentMemoryService — project-scoped memory system for the coding agent.
 *
 * Implements a 4-type taxonomy inspired by Claude Code's memdir:
 *   - user:      User's role, goals, preferences, expertise
 *   - feedback:  Corrections AND confirmations of approach
 *   - project:   Ongoing work context not derivable from code/git
 *   - reference: Pointers to external systems (dashboards, trackers)
 *
 * Backed by MongoDB `agent_memories` collection with embedding-based
 * duplicate detection and vector similarity search.
 */
const AgentMemoryService = {
  /**
   * Store a single memory with embedding generation and duplicate detection.
   *
   * @param {object} params
   * @param {string} params.project - Project identifier
   * @param {string} params.username - Who created this memory
   * @param {"user"|"feedback"|"project"|"reference"} params.type - Memory type
   * @param {string} params.title - Short name (used for relevance scanning)
   * @param {string} params.content - Full memory text
   * @param {string} [params.conversationId] - Source conversation
   * @returns {Promise<object|null>} Stored memory document, or null if duplicate
   */
  async store({ project, username, type, title, content, conversationId }) {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) throw new Error("Database not available");

    // Validate type
    const validType = MEMORY_TYPES.includes(type) ? type : "project";

    const db = client.db(MONGO_DB_NAME);
    const collection = db.collection(COLLECTION);

    const embedding = await generateEmbedding(`${title}: ${content}`);

    // Duplicate detection — compare against existing memories in same project
    const existing = await collection
      .find({ project })
      .project({ embedding: 1 })
      .toArray();

    const isDuplicate = existing.some((doc) => {
      if (!doc.embedding) return false;
      return cosineSimilarity(embedding, doc.embedding) > DUPLICATE_THRESHOLD;
    });

    if (isDuplicate) {
      logger.info(
        `[AgentMemoryService] Skipping duplicate: "${title}"`,
      );
      return null;
    }

    const now = new Date().toISOString();
    const memory = {
      id: crypto.randomUUID(),
      project,
      username,
      type: validType,
      title,
      content,
      embedding,
      conversationId: conversationId || null,
      createdAt: now,
      updatedAt: now,
    };

    await collection.insertOne(memory);
    logger.info(
      `[AgentMemoryService] Stored [${validType}] "${title}"`,
    );
    return memory;
  },

  /**
   * Search for relevant memories using vector similarity.
   *
   * @param {object} params
   * @param {string} params.project - Project identifier
   * @param {string} params.queryText - Text to search for
   * @param {number} [params.limit=5] - Max results
   * @returns {Promise<Array>} Relevant memories sorted by score, with age metadata
   */
  async search({ project, queryText, limit = 5 }) {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) return [];

    const db = client.db(MONGO_DB_NAME);
    const collection = db.collection(COLLECTION);

    let queryEmbedding;
    try {
      queryEmbedding = await generateEmbedding(queryText);
    } catch (err) {
      logger.warn(`[AgentMemoryService] Embedding failed: ${err.message}`);
      return [];
    }

    const memories = await collection
      .find(
        { project },
        {
          projection: {
            embedding: 1,
            type: 1,
            title: 1,
            content: 1,
            createdAt: 1,
            username: 1,
            // Backward compat: read old-schema fields too
            fact: 1,
            category: 1,
          },
        },
      )
      .toArray();

    if (memories.length === 0) return [];

    const scored = memories
      .filter((m) => m.embedding && m.embedding.length > 0)
      .map((m) => ({
        id: m._id,
        type: m.type || m.category || "project",
        title: m.title || (m.fact ? m.fact.substring(0, 60) : "untitled"),
        content: m.content || m.fact || "",
        createdAt: m.createdAt,
        age: memoryAge(m.createdAt),
        ageDays: memoryAgeDays(m.createdAt),
        score: cosineSimilarity(queryEmbedding, m.embedding),
      }))
      .filter((m) => m.score > RELEVANCE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    logger.info(
      `[AgentMemoryService] Search found ${scored.length} relevant memories (from ${memories.length} total)`,
    );

    return scored;
  },

  /**
   * Format memories for injection into the system prompt.
   * Adds type badges and staleness caveats (inspired by Claude Code's memoryAge).
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

  /**
   * List all memories for a project.
   *
   * @param {object} params
   * @param {string} params.project
   * @param {number} [params.limit=50]
   * @param {number} [params.skip=0]
   * @returns {Promise<{ memories: Array, total: number }>}
   */
  async list({ project, limit = 50, skip = 0 }) {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) throw new Error("Database not available");

    const db = client.db(MONGO_DB_NAME);
    const collection = db.collection(COLLECTION);

    const filter = { project };
    const [memories, total] = await Promise.all([
      collection
        .find(filter)
        .project({ embedding: 0 })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      collection.countDocuments(filter),
    ]);

    return { memories, total };
  },

  /**
   * Update an existing memory.
   *
   * @param {string} memoryId
   * @param {object} updates - Fields to update (title, content, type)
   * @returns {Promise<boolean>}
   */
  async update(memoryId, { title, content, type }) {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) throw new Error("Database not available");

    const db = client.db(MONGO_DB_NAME);
    const collection = db.collection(COLLECTION);

    const $set = { updatedAt: new Date().toISOString() };
    if (title !== undefined) $set.title = title;
    if (content !== undefined) $set.content = content;
    if (type !== undefined && MEMORY_TYPES.includes(type)) $set.type = type;

    // Re-generate embedding if content changed
    if (content !== undefined) {
      const embedText = title ? `${title}: ${content}` : content;
      $set.embedding = await generateEmbedding(embedText);
    }

    const result = await collection.updateOne({ id: memoryId }, { $set });
    return result.modifiedCount > 0;
  },

  /**
   * Delete a memory by ID.
   *
   * @param {string} memoryId
   * @returns {Promise<boolean>}
   */
  async remove(memoryId) {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) throw new Error("Database not available");

    const db = client.db(MONGO_DB_NAME);
    const collection = db.collection(COLLECTION);

    const result = await collection.deleteOne({ id: memoryId });
    return result.deletedCount > 0;
  },

  /**
   * Ensure MongoDB indexes on the agent_memories collection.
   */
  async ensureIndexes() {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) return;

    const db = client.db(MONGO_DB_NAME);
    const collection = db.collection(COLLECTION);

    await collection.createIndex({ project: 1 });
    await collection.createIndex({ project: 1, type: 1 });
    await collection.createIndex({ id: 1 }, { unique: true });
    await collection.createIndex({ createdAt: -1 });

    logger.info("[AgentMemoryService] Indexes ensured on agent_memories collection.");
  },
};

export default AgentMemoryService;

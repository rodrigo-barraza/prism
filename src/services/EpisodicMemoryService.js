import crypto from "crypto";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import EmbeddingService from "./EmbeddingService.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";
import { cosineSimilarity } from "../utils/math.js";
import { COLLECTIONS } from "../constants.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const COLLECTION = COLLECTIONS.MEMORY_EPISODIC;

/** Minimum cosine similarity for an episode to be considered relevant. */
const RELEVANCE_THRESHOLD = 0.25;

/** Maximum episodes returned by default. */
const DEFAULT_LIMIT = 5;


// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate an embedding for text via EmbeddingService.
 * @param {string} text
 * @param {object} [options]
 * @returns {Promise<number[]>}
 */
async function generateEmbedding(text, options = {}) {
  return EmbeddingService.embed(text, { source: "episodic-memory", ...options });
}

/**
 * Human-readable age string.
 */
function episodeAge(dateStr) {
  const ms = Date.now() - new Date(dateStr).getTime();
  const days = Math.max(0, Math.floor(ms / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} week(s) ago`;
  return `${Math.floor(days / 30)} month(s) ago`;
}


// ─── Episodic Memory Service ─────────────────────────────────────────────────

/**
 * EpisodicMemoryService — narrative memory of what happened.
 *
 * Each document represents a session episode — a coherent interaction with
 * temporal context, participants, outcomes, and cross-references to extracted
 * semantic and procedural memories.
 *
 * Analog: Human episodic memory — personal experiences tied to time and place.
 */
const EpisodicMemoryService = {

  /**
   * Store a new episode from a completed session.
   *
   * @param {object} params
   * @param {string} params.agent - Agent identifier
   * @param {string} params.project - Project identifier
   * @param {string} params.traceId
   * @param {string} [params.conversationId]
   * @param {string} params.username
   * @param {string} params.summary - Brief episode summary
   * @param {string} params.narrative - Detailed narrative of what happened
   * @param {string} [params.outcome] - resolved | partial | abandoned | deferred
   * @param {string} [params.satisfaction] - positive | neutral | negative
   * @param {string[]} [params.filesModified]
   * @param {string[]} [params.toolsUsed]
   * @param {string[]} [params.keyDecisions]
   * @param {string[]} [params.tags]
   * @param {object} [params.meta] - Extra metadata (guildId, etc.)
   * @returns {Promise<object>} The stored episode document
   */
  async store({
    agent,
    project,
    traceId,
    conversationId,
    username,
    summary,
    narrative,
    outcome = "resolved",
    satisfaction = "neutral",
    filesModified = [],
    toolsUsed = [],
    keyDecisions = [],
    tags = [],
    meta = {},
  }) {
    if (!agent) throw new Error("EpisodicMemoryService.store requires an agent");
    if (!summary) throw new Error("EpisodicMemoryService.store requires a summary");

    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);

    // Embed the summary + narrative for retrieval
    const embedText = narrative ? `${summary}\n${narrative}` : summary;
    const embedding = await generateEmbedding(embedText, {
      project,
      agent,
      traceId,
    });

    const now = new Date().toISOString();
    const episode = {
      id: crypto.randomUUID(),
      agent,
      project: project || null,
      traceId: traceId || null,
      conversationId: conversationId || null,
      username: username || null,

      // Narrative
      summary,
      narrative: narrative || null,

      // Outcome
      outcome,
      satisfaction,

      // What was touched
      filesModified,
      toolsUsed: [...new Set(toolsUsed)], // dedupe
      keyDecisions,

      // Cross-references (populated by MemoryExtractor)
      extractedSemanticIds: [],
      extractedProceduralIds: [],
      relatedEpisodeIds: [],

      // Retrieval
      embedding,
      tags,

      // Timestamps
      startedAt: now,
      endedAt: now,
      createdAt: now,
      updatedAt: now,

      // Agent-specific metadata
      ...meta,
    };

    await collection.insertOne(episode);
    logger.info(
      `[EpisodicMemory] Stored episode [${agent}] "${summary.substring(0, 60)}" (${outcome})`,
    );
    return episode;
  },

  /**
   * Search for relevant episodes using cosine similarity.
   *
   * @param {object} params
   * @param {string} params.agent
   * @param {string} [params.project]
   * @param {string} params.queryText
   * @param {number} [params.limit]
   * @param {string} [params.username]
   * @returns {Promise<Array>} Relevant episodes sorted by composite score
   */
  async search({ agent, project, queryText, limit = DEFAULT_LIMIT, username }) {
    if (!agent) throw new Error("EpisodicMemoryService.search requires an agent");

    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);

    const queryEmbedding = await generateEmbedding(queryText, { project, agent });

    const filter = { agent };
    if (project) filter.project = project;
    if (username) filter.username = username;

    const episodes = await collection
      .find(filter, {
        projection: {
          embedding: 1,
          summary: 1,
          narrative: 1,
          outcome: 1,
          satisfaction: 1,
          toolsUsed: 1,
          keyDecisions: 1,
          tags: 1,
          username: 1,
          startedAt: 1,
          createdAt: 1,
        },
      })
      .toArray();

    if (episodes.length === 0) return [];

    // Composite scoring: similarity × recency boost
    const now = Date.now();
    const scored = episodes
      .filter((e) => e.embedding?.length > 0)
      .map((e) => {
        const similarity = cosineSimilarity(queryEmbedding, e.embedding);
        const ageDays = Math.max(1, (now - new Date(e.createdAt).getTime()) / 86_400_000);
        const recencyBoost = 1 / Math.log2(ageDays + 1); // logarithmic decay
        const score = similarity * 0.8 + recencyBoost * 0.2;

        return {
          id: e._id,
          summary: e.summary,
          narrative: e.narrative,
          outcome: e.outcome,
          satisfaction: e.satisfaction,
          toolsUsed: e.toolsUsed,
          keyDecisions: e.keyDecisions,
          tags: e.tags,
          username: e.username,
          age: episodeAge(e.createdAt),
          createdAt: e.createdAt,
          similarity,
          score,
        };
      })
      .filter((e) => e.similarity > RELEVANCE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    logger.info(
      `[EpisodicMemory] Search found ${scored.length} relevant episodes for ${agent}`,
    );
    return scored;
  },

  /**
   * Get recent episodes for an agent/project (chronological).
   *
   * @param {object} params
   * @param {string} params.agent
   * @param {string} [params.project]
   * @param {number} [params.limit]
   * @returns {Promise<Array>}
   */
  async getRecent({ agent, project, limit = 5 }) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const filter = { agent };
    if (project) filter.project = project;

    return collection
      .find(filter, { projection: { embedding: 0 } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  },

  /**
   * Link extracted memory IDs to an episode (cross-referencing).
   *
   * @param {string} episodeId
   * @param {object} refs
   * @param {string[]} [refs.semanticIds]
   * @param {string[]} [refs.proceduralIds]
   */
  async linkExtracted(episodeId, { semanticIds = [], proceduralIds = [] }) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const $push = {};
    if (semanticIds.length > 0) {
      $push.extractedSemanticIds = { $each: semanticIds };
    }
    if (proceduralIds.length > 0) {
      $push.extractedProceduralIds = { $each: proceduralIds };
    }
    if (Object.keys($push).length > 0) {
      await collection.updateOne({ id: episodeId }, { $push });
    }
  },

  /**
   * Format episodes for injection into the system prompt.
   *
   * @param {Array} episodes - Array from search()
   * @returns {string}
   */
  formatForPrompt(episodes) {
    if (!episodes || episodes.length === 0) return "";
    return episodes
      .map((e) => {
        const outcome = e.outcome !== "resolved" ? ` [${e.outcome}]` : "";
        const decisions = e.keyDecisions?.length > 0
          ? `\n  Decisions: ${e.keyDecisions.join("; ")}`
          : "";
        return `- [${e.age}]${outcome} ${e.summary}${decisions}`;
      })
      .join("\n");
  },

  /**
   * Ensure indexes exist.
   */
  async ensureIndexes() {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return;
    const collection = db.collection(COLLECTION);
    await Promise.all([
      collection.createIndex({ agent: 1, project: 1, createdAt: -1 }),
      collection.createIndex({ agent: 1, traceId: 1 }),
      collection.createIndex({ id: 1 }, { unique: true }),
    ]);
    logger.info("[EpisodicMemory] Indexes ensured.");
  },
};

export default EpisodicMemoryService;

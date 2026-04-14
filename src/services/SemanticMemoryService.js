import crypto from "crypto";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import EmbeddingService from "./EmbeddingService.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";
import { cosineSimilarity } from "../utils/math.js";
import { COLLECTIONS } from "../constants.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const COLLECTION = COLLECTIONS.MEMORY_SEMANTIC;

/** Two semantic memories above this similarity are considered duplicates. */
const DUPLICATE_THRESHOLD = 0.92;

/** Minimum cosine similarity for a memory to be considered relevant. */
const RELEVANCE_THRESHOLD = 0.3;

/** Valid semantic memory types. */
const VALID_TYPES = ["preference", "fact", "rule", "reference"];

/** Valid scope levels. */
const VALID_SCOPES = ["user", "project", "global"];


// ─── Helpers ──────────────────────────────────────────────────────────────────

async function generateEmbedding(text, options = {}) {
  return EmbeddingService.embed(text, { source: "semantic-memory", ...options });
}

/**
 * Calculate a confidence score based on reinforcement history and age.
 * Confidence increases with reinforcement and decreases slowly with time
 * if not accessed (spaced repetition decay).
 */
function computeConfidence({ reinforcementCount, contradictionCount, lastReinforcedAt, lastAccessedAt }) {
  const baseConfidence = Math.min(1, 0.5 + (reinforcementCount || 0) * 0.1);
  const contradictionPenalty = (contradictionCount || 0) * 0.15;

  // Decay based on time since last access (spaced repetition)
  const lastTouch = lastAccessedAt || lastReinforcedAt;
  let decayFactor = 1;
  if (lastTouch) {
    const daysSinceAccess = (Date.now() - new Date(lastTouch).getTime()) / 86_400_000;
    // Ebbinghaus-inspired: retention = e^(-t/S) where S is stability
    const stability = 10 + (reinforcementCount || 0) * 5; // more reinforcement = slower decay
    decayFactor = Math.exp(-daysSinceAccess / stability);
  }

  return Math.max(0.1, Math.min(1, (baseConfidence - contradictionPenalty) * decayFactor));
}


// ─── Semantic Memory Service ─────────────────────────────────────────────────

/**
 * SemanticMemoryService — stable, decontextualized knowledge.
 *
 * Facts, preferences, rules, and references that have been validated over time.
 * Each fact has provenance tracking (which episodes established it),
 * reinforcement counting, and a confidence score that evolves.
 *
 * Analog: Human semantic memory — general knowledge detached from personal context.
 */
const SemanticMemoryService = {

  /**
   * Store a semantic memory with duplicate detection and provenance tracking.
   *
   * @param {object} params
   * @param {string} params.agent
   * @param {string} [params.project] - null for cross-project knowledge
   * @param {string} [params.scope] - user | project | global
   * @param {string} [params.type] - preference | fact | rule | reference
   * @param {string} params.title
   * @param {string} params.content
   * @param {string} [params.sourceEpisodeId] - Episode that established this fact
   * @param {string} [params.username]
   * @param {object} [params.metadata]
   * @returns {Promise<object|null>} Stored memory or null if duplicate
   */
  async store({
    agent,
    project,
    scope = "project",
    type = "fact",
    title,
    content,
    sourceEpisodeId,
    username,
    agentSessionId,
    metadata = {},
  }) {
    if (!agent) throw new Error("SemanticMemoryService.store requires an agent");
    if (!content) throw new Error("SemanticMemoryService.store requires content");

    // Validate
    if (!VALID_TYPES.includes(type)) type = "fact";
    if (!VALID_SCOPES.includes(scope)) scope = "project";

    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const embedText = title ? `${title}: ${content}` : content;
    const embedding = await generateEmbedding(embedText, { project, agent, agentSessionId });

    // Duplicate detection — check same agent/project
    const dedupFilter = { agent };
    if (project) dedupFilter.project = project;

    const existing = await collection
      .find(dedupFilter)
      .project({ embedding: 1, id: 1 })
      .toArray();

    for (const doc of existing) {
      if (!doc.embedding) continue;
      const sim = cosineSimilarity(embedding, doc.embedding);
      if (sim > DUPLICATE_THRESHOLD) {
        // Reinforce existing memory instead of creating duplicate
        await this.reinforce(doc.id, { sourceEpisodeId });
        logger.info(
          `[SemanticMemory] Reinforced existing: "${(title || content).substring(0, 60)}" (sim: ${sim.toFixed(3)})`,
        );
        return null;
      }
    }

    const now = new Date().toISOString();
    const memory = {
      id: crypto.randomUUID(),
      agent,
      project: project || null,
      scope,
      type,
      title: title || null,
      content,
      username: username || null,

      // Provenance
      sourceEpisodeIds: sourceEpisodeId ? [sourceEpisodeId] : [],
      reinforcementCount: 0,
      lastReinforcedAt: null,
      contradictionCount: 0,

      // Confidence (starts at base level)
      confidence: 0.5,

      // Access tracking
      lastAccessedAt: null,
      accessCount: 0,

      // Retrieval
      embedding,

      // Timestamps
      createdAt: now,
      updatedAt: now,

      // Extra metadata
      ...metadata,
    };

    await collection.insertOne(memory);
    logger.info(
      `[SemanticMemory] Stored [${agent}/${type}] "${(title || content).substring(0, 60)}"`,
    );
    return memory;
  },

  /**
   * Reinforce an existing semantic memory (increase confidence).
   * Called when a duplicate or confirming fact is encountered.
   *
   * @param {string} memoryId
   * @param {object} [options]
   * @param {string} [options.sourceEpisodeId] - Episode that confirmed this
   */
  async reinforce(memoryId, { sourceEpisodeId } = {}) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const now = new Date().toISOString();

    const update = {
      $inc: { reinforcementCount: 1 },
      $set: { lastReinforcedAt: now, updatedAt: now },
    };

    if (sourceEpisodeId) {
      update.$addToSet = { sourceEpisodeIds: sourceEpisodeId };
    }

    await collection.updateOne({ id: memoryId }, update);

    // Recompute confidence
    const doc = await collection.findOne({ id: memoryId });
    if (doc) {
      const newConfidence = computeConfidence(doc);
      await collection.updateOne({ id: memoryId }, { $set: { confidence: newConfidence } });
    }
  },

  /**
   * Record a contradiction against a semantic memory.
   *
   * @param {string} memoryId
   */
  async contradict(memoryId) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const now = new Date().toISOString();
    await collection.updateOne(
      { id: memoryId },
      { $inc: { contradictionCount: 1 }, $set: { updatedAt: now } },
    );

    // Recompute confidence
    const doc = await collection.findOne({ id: memoryId });
    if (doc) {
      const newConfidence = computeConfidence(doc);
      await collection.updateOne({ id: memoryId }, { $set: { confidence: newConfidence } });
    }
  },

  /**
   * Search for relevant semantic memories using cosine similarity.
   * Scores by: similarity × confidence × recency.
   *
   * @param {object} params
   * @param {string} params.agent
   * @param {string} [params.project]
   * @param {string} params.queryText
   * @param {number} [params.limit=10]
   * @param {string[]} [params.types] - Filter by memory type
   * @param {string} [params.scope] - Filter by scope
   * @returns {Promise<Array>}
   */
  async search({ agent, project, queryText, limit = 10, types, scope, agentSessionId }) {
    if (!agent) throw new Error("SemanticMemoryService.search requires an agent");

    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const queryEmbedding = await generateEmbedding(queryText, { project, agent, agentSessionId });

    const filter = { agent };
    if (project) filter.project = project;
    if (types?.length > 0) filter.type = { $in: types };
    if (scope) filter.scope = scope;

    const memories = await collection
      .find(filter, {
        projection: {
          embedding: 1,
          type: 1,
          scope: 1,
          title: 1,
          content: 1,
          confidence: 1,
          reinforcementCount: 1,
          createdAt: 1,
          lastAccessedAt: 1,
        },
      })
      .toArray();

    if (memories.length === 0) return [];

    const scored = memories
      .filter((m) => m.embedding?.length > 0)
      .map((m) => {
        const similarity = cosineSimilarity(queryEmbedding, m.embedding);
        const confidence = m.confidence || 0.5;
        // Composite: 70% similarity, 20% confidence, 10% reinforcement bonus
        const reinforcementBonus = Math.min(1, (m.reinforcementCount || 0) / 10);
        const score = similarity * 0.7 + confidence * 0.2 + reinforcementBonus * 0.1;

        return {
          id: m._id,
          type: m.type,
          scope: m.scope,
          title: m.title,
          content: m.content,
          confidence,
          reinforcementCount: m.reinforcementCount || 0,
          createdAt: m.createdAt,
          similarity,
          score,
        };
      })
      .filter((m) => m.similarity > RELEVANCE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Track access (fire-and-forget)
    if (scored.length > 0) {
      const ids = scored.map((m) => m.id);
      const now = new Date().toISOString();
      collection
        .updateMany(
          { _id: { $in: ids } },
          { $set: { lastAccessedAt: now }, $inc: { accessCount: 1 } },
        )
        .catch(() => {});
    }

    logger.info(
      `[SemanticMemory] Search found ${scored.length} relevant memories for ${agent}`,
    );
    return scored;
  },

  /**
   * List semantic memories (paginated).
   */
  async list({ agent, project, type, limit = 50, skip = 0 }) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const filter = { agent };
    if (project) filter.project = project;
    if (type) filter.type = type;

    const [memories, total] = await Promise.all([
      collection
        .find(filter, { projection: { embedding: 0 } })
        .sort({ confidence: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      collection.countDocuments(filter),
    ]);

    return { memories, total };
  },

  /**
   * Delete a semantic memory.
   */
  async delete(memoryId) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const result = await collection.deleteOne({ id: memoryId });
    return result.deletedCount > 0;
  },

  /**
   * Format semantic memories for prompt injection.
   */
  formatForPrompt(memories) {
    if (!memories || memories.length === 0) return "";
    return memories
      .map((m) => {
        const badge = `[${m.type}]`;
        const conf = m.reinforcementCount > 0
          ? ` (confirmed ${m.reinforcementCount}x)`
          : "";
        return `- ${badge} **${m.title || "—"}**${conf}: ${m.content}`;
      })
      .join("\n");
  },

  /**
   * Ensure indexes.
   */
  async ensureIndexes() {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return;
    const collection = db.collection(COLLECTION);
    await Promise.all([
      collection.createIndex({ agent: 1, project: 1, type: 1 }),
      collection.createIndex({ agent: 1, project: 1, scope: 1 }),
      collection.createIndex({ id: 1 }, { unique: true }),
      collection.createIndex({ confidence: -1 }),
      collection.createIndex({ lastAccessedAt: 1 }),
    ]);
    logger.info("[SemanticMemory] Indexes ensured.");
  },
};

export default SemanticMemoryService;

import crypto from "crypto";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import EmbeddingService from "./EmbeddingService.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";
import { cosineSimilarity } from "../utils/math.js";
import { COLLECTIONS } from "../constants.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const COLLECTION = COLLECTIONS.MEMORY_PROCEDURAL;

/** Minimum cosine similarity for a procedure to be considered relevant. */
const RELEVANCE_THRESHOLD = 0.35;

/** Duplicate threshold — above this, reinforce instead of creating new. */
const DUPLICATE_THRESHOLD = 0.88;


// ─── Helpers ──────────────────────────────────────────────────────────────────

async function generateEmbedding(text, options = {}) {
  return EmbeddingService.embed(text, { source: "procedural-memory", ...options });
}


// ─── Procedural Memory Service ───────────────────────────────────────────────

/**
 * ProceduralMemoryService — learned "how-to" patterns.
 *
 * The agent learns from successful interactions — which tool sequences work,
 * which approaches fail, which error recovery strategies succeed. Procedures
 * are reinforced over time and decay only through disuse.
 *
 * Analog: Human procedural memory — riding a bike, typing, playing piano.
 * Once learned through repetition, it becomes automatic.
 */
const ProceduralMemoryService = {

  /**
   * Store a learned procedure.
   *
   * @param {object} params
   * @param {string} params.agent
   * @param {string} [params.project] - null for cross-project procedures
   * @param {string} params.trigger - What situation triggers this procedure
   * @param {string[]} params.procedure - Step-by-step instructions
   * @param {string[]} [params.toolSequence] - Tool names used in order
   * @param {string[]} [params.tags]
   * @param {string} [params.sourceEpisodeId]
   * @returns {Promise<object|null>} Stored procedure or null if reinforced existing
   */
  async store({
    agent,
    project,
    trigger,
    procedure,
    toolSequence = [],
    tags = [],
    sourceEpisodeId,
    agentSessionId,
  }) {
    if (!agent) throw new Error("ProceduralMemoryService.store requires an agent");
    if (!trigger) throw new Error("ProceduralMemoryService.store requires a trigger");
    if (!procedure || procedure.length === 0) {
      throw new Error("ProceduralMemoryService.store requires procedure steps");
    }

    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);

    // Embed the trigger + procedure for retrieval
    const embedText = `${trigger}\n${procedure.join("\n")}`;
    const embedding = await generateEmbedding(embedText, { project, agent, agentSessionId });

    // Check for existing similar procedure — reinforce instead of duplicate
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
        await this.reinforce(doc.id, { sourceEpisodeId });
        logger.info(
          `[ProceduralMemory] Reinforced existing: "${trigger.substring(0, 60)}" (sim: ${sim.toFixed(3)})`,
        );
        return null;
      }
    }

    const now = new Date().toISOString();
    const proc = {
      id: crypto.randomUUID(),
      agent,
      project: project || null,

      trigger,
      procedure,
      toolSequence: [...new Set(toolSequence)],

      // Reinforcement
      successCount: 1,
      failureCount: 0,
      lastUsedAt: now,
      sourceEpisodeIds: sourceEpisodeId ? [sourceEpisodeId] : [],

      // Retrieval
      embedding,
      tags,

      createdAt: now,
      updatedAt: now,
    };

    await collection.insertOne(proc);
    logger.info(
      `[ProceduralMemory] Stored [${agent}] "${trigger.substring(0, 60)}" (${procedure.length} steps)`,
    );
    return proc;
  },

  /**
   * Reinforce an existing procedure (increase success count).
   *
   * @param {string} procedureId
   * @param {object} [options]
   * @param {string} [options.sourceEpisodeId]
   * @param {boolean} [options.failure] - Record a failure instead
   */
  async reinforce(procedureId, { sourceEpisodeId, failure = false } = {}) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const now = new Date().toISOString();

    const update = {
      $set: { lastUsedAt: now, updatedAt: now },
      $inc: failure ? { failureCount: 1 } : { successCount: 1 },
    };

    if (sourceEpisodeId) {
      update.$addToSet = { sourceEpisodeIds: sourceEpisodeId };
    }

    await collection.updateOne({ id: procedureId }, update);
  },

  /**
   * Search for relevant procedures by trigger similarity.
   *
   * @param {object} params
   * @param {string} params.agent
   * @param {string} [params.project]
   * @param {string} params.queryText - Current situation/trigger
   * @param {number} [params.limit=5]
   * @returns {Promise<Array>}
   */
  async search({ agent, project, queryText, limit = 5, agentSessionId }) {
    if (!agent) throw new Error("ProceduralMemoryService.search requires an agent");

    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const queryEmbedding = await generateEmbedding(queryText, { project, agent, agentSessionId });

    const filter = { agent };
    if (project) {
      // Include both project-specific and cross-project procedures
      filter.$or = [{ project }, { project: null }];
      delete filter.agent; // Move agent into $or
      filter.$or = [
        { agent, project },
        { agent, project: null },
      ];
    }

    const procedures = await collection
      .find(filter, {
        projection: {
          embedding: 1,
          trigger: 1,
          procedure: 1,
          toolSequence: 1,
          successCount: 1,
          failureCount: 1,
          lastUsedAt: 1,
          tags: 1,
        },
      })
      .toArray();

    if (procedures.length === 0) return [];

    const scored = procedures
      .filter((p) => p.embedding?.length > 0)
      .map((p) => {
        const similarity = cosineSimilarity(queryEmbedding, p.embedding);
        // Weight by success rate
        const total = (p.successCount || 0) + (p.failureCount || 0);
        const successRate = total > 0 ? (p.successCount || 0) / total : 0.5;
        const score = similarity * 0.7 + successRate * 0.3;

        return {
          id: p._id,
          trigger: p.trigger,
          procedure: p.procedure,
          toolSequence: p.toolSequence,
          successCount: p.successCount || 0,
          failureCount: p.failureCount || 0,
          successRate,
          lastUsedAt: p.lastUsedAt,
          tags: p.tags,
          similarity,
          score,
        };
      })
      .filter((p) => p.similarity > RELEVANCE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    logger.info(
      `[ProceduralMemory] Search found ${scored.length} relevant procedures for ${agent}`,
    );
    return scored;
  },

  /**
   * Format procedures for prompt injection.
   */
  formatForPrompt(procedures) {
    if (!procedures || procedures.length === 0) return "";
    return procedures
      .map((p) => {
        const rate = `${Math.round(p.successRate * 100)}% success`;
        const steps = p.procedure.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
        return `- **${p.trigger}** (${rate})\n${steps}`;
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
      collection.createIndex({ agent: 1, project: 1 }),
      collection.createIndex({ id: 1 }, { unique: true }),
      collection.createIndex({ successCount: -1 }),
    ]);
    logger.info("[ProceduralMemory] Indexes ensured.");
  },
};

export default ProceduralMemoryService;

import crypto from "crypto";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import EmbeddingService from "./EmbeddingService.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";
import { cosineSimilarity } from "../utils/math.js";
import { COLLECTIONS } from "../constants.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const COLLECTION = COLLECTIONS.MEMORY_PROSPECTIVE;

/** Default expiration for prospective memories: 7 days. */
const DEFAULT_TTL_DAYS = 7;

/** Similarity threshold for cue-based triggering. */
const CUE_TRIGGER_THRESHOLD = 0.5;


// ─── Helpers ──────────────────────────────────────────────────────────────────

async function generateEmbedding(text, options = {}) {
  return EmbeddingService.embed(text, { source: "prospective-memory", ...options });
}


// ─── Prospective Memory Service ──────────────────────────────────────────────

/**
 * ProspectiveMemoryService — future intentions.
 *
 * "Remember to perform a planned action in the future."
 * Supports both time-based triggers ("at 8 PM") and event/cue-based triggers
 * ("when the user mentions staging").
 *
 * Analog: Human prospective memory — "remembering to remember."
 */
const ProspectiveMemoryService = {

  /**
   * Store a future intention.
   *
   * @param {object} params
   * @param {string} params.agent
   * @param {string} params.project
   * @param {string} params.username
   * @param {string} params.intention - What to remember to do
   * @param {string} params.triggerType - "time" | "event" | "cue"
   * @param {string} [params.triggerAt] - ISO date for time-based triggers
   * @param {string} [params.triggerCue] - Text cue for event-based triggers
   * @param {string} [params.priority] - low | medium | high | critical
   * @param {string} [params.context] - Additional context
   * @param {string[]} [params.relatedEpisodeIds]
   * @param {number} [params.ttlDays] - Days until auto-expiration
   * @returns {Promise<object>}
   */
  async store({
    agent,
    project,
    username,
    intention,
    triggerType = "cue",
    triggerAt,
    triggerCue,
    priority = "medium",
    context,
    relatedEpisodeIds = [],
    ttlDays = DEFAULT_TTL_DAYS,
  }) {
    if (!agent) throw new Error("ProspectiveMemoryService.store requires an agent");
    if (!intention) throw new Error("ProspectiveMemoryService.store requires an intention");

    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);

    // Generate embedding for cue-based matching
    const embedText = triggerCue
      ? `${intention} — trigger: ${triggerCue}`
      : intention;
    const embedding = await generateEmbedding(embedText, { project, agent });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000).toISOString();

    const memory = {
      id: crypto.randomUUID(),
      agent,
      project: project || null,
      username: username || null,

      intention,
      triggerType,
      triggerAt: triggerAt || null,
      triggerCue: triggerCue || null,

      priority,
      status: "pending", // pending | triggered | completed | expired | dismissed
      context: context || null,
      relatedEpisodeIds,

      embedding,

      createdAt: now.toISOString(),
      expiresAt,
      completedAt: null,
      triggeredAt: null,
    };

    await collection.insertOne(memory);
    logger.info(
      `[ProspectiveMemory] Stored [${triggerType}] "${intention.substring(0, 60)}" (expires: ${expiresAt})`,
    );
    return memory;
  },

  /**
   * Check for triggered prospective memories.
   * Called on each session start by SystemPromptAssembler.
   *
   * @param {object} params
   * @param {string} params.agent
   * @param {string} [params.project]
   * @param {string} [params.queryText] - User's first message (for cue matching)
   * @returns {Promise<Array>} Triggered memories
   */
  async checkTriggers({ agent, project, queryText }) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const now = new Date().toISOString();
    const triggered = [];

    // 1. Time-based triggers: triggerAt <= now AND status = pending
    const timeFilter = {
      agent,
      status: "pending",
      triggerType: "time",
      triggerAt: { $lte: now },
      expiresAt: { $gt: now },
    };
    if (project) timeFilter.project = project;

    const timeTriggered = await collection
      .find(timeFilter, { projection: { embedding: 0 } })
      .toArray();

    for (const mem of timeTriggered) {
      triggered.push({ ...mem, triggerReason: "time" });
      // Mark as triggered
      await collection.updateOne(
        { id: mem.id },
        { $set: { status: "triggered", triggeredAt: now } },
      );
    }

    // 2. Cue-based triggers: similarity between queryText and triggerCue embedding
    if (queryText) {
      const cueFilter = {
        agent,
        status: "pending",
        triggerType: { $in: ["cue", "event"] },
        expiresAt: { $gt: now },
      };
      if (project) cueFilter.project = project;

      const cueCandidates = await collection
        .find(cueFilter, {
          projection: {
            embedding: 1,
            id: 1,
            intention: 1,
            triggerCue: 1,
            priority: 1,
            context: 1,
            relatedEpisodeIds: 1,
            createdAt: 1,
          },
        })
        .toArray();

      if (cueCandidates.length > 0) {
        const queryEmbedding = await generateEmbedding(queryText, { project, agent });

        for (const mem of cueCandidates) {
          if (!mem.embedding) continue;
          const sim = cosineSimilarity(queryEmbedding, mem.embedding);
          if (sim > CUE_TRIGGER_THRESHOLD) {
            const { embedding: _, ...rest } = mem;
            triggered.push({ ...rest, triggerReason: "cue", cueSimilarity: sim });
            await collection.updateOne(
              { id: mem.id },
              { $set: { status: "triggered", triggeredAt: now } },
            );
          }
        }
      }
    }

    // 3. Expire old memories
    await collection.updateMany(
      { status: "pending", expiresAt: { $lte: now } },
      { $set: { status: "expired" } },
    );

    if (triggered.length > 0) {
      logger.info(
        `[ProspectiveMemory] ${triggered.length} reminder(s) triggered for ${agent}`,
      );
    }

    return triggered;
  },

  /**
   * Mark a prospective memory as completed.
   *
   * @param {string} memoryId
   */
  async complete(memoryId) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    await collection.updateOne(
      { id: memoryId },
      { $set: { status: "completed", completedAt: new Date().toISOString() } },
    );
  },

  /**
   * Dismiss a prospective memory.
   *
   * @param {string} memoryId
   */
  async dismiss(memoryId) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    await collection.updateOne(
      { id: memoryId },
      { $set: { status: "dismissed" } },
    );
  },

  /**
   * List pending prospective memories.
   */
  async listPending({ agent, project, limit = 20 }) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const filter = { agent, status: "pending" };
    if (project) filter.project = project;

    return collection
      .find(filter, { projection: { embedding: 0 } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  },

  /**
   * Format triggered reminders for prompt injection.
   */
  formatForPrompt(reminders) {
    if (!reminders || reminders.length === 0) return "";

    const priorityIcons = {
      critical: "🔴",
      high: "🟠",
      medium: "⏰",
      low: "🔵",
    };

    return reminders
      .map((r) => {
        const icon = priorityIcons[r.priority] || "⏰";
        const ctx = r.context ? ` — ${r.context}` : "";
        return `- ${icon} ${r.intention}${ctx}`;
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
      collection.createIndex({ agent: 1, project: 1, status: 1 }),
      collection.createIndex({ status: 1, triggerType: 1, triggerAt: 1 }),
      collection.createIndex({ id: 1 }, { unique: true }),
      collection.createIndex({ expiresAt: 1 }),
    ]);
    logger.info("[ProspectiveMemory] Indexes ensured.");
  },
};

export default ProspectiveMemoryService;

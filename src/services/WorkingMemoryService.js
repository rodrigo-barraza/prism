import crypto from "crypto";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import EpisodicMemoryService from "./EpisodicMemoryService.js";
import SemanticMemoryService from "./SemanticMemoryService.js";
import ProceduralMemoryService from "./ProceduralMemoryService.js";
import ProspectiveMemoryService from "./ProspectiveMemoryService.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";
import { COLLECTIONS } from "../constants.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const COLLECTION = COLLECTIONS.MEMORY_WORKING;

/** Maximum number of slots in working memory. */
const MAX_SLOTS = 18;

/** How many items to pull from each long-term memory system. */
const FETCH_LIMITS = {
  semantic: 6,
  episodic: 4,
  procedural: 3,
  prospective: 5, // check all pending
};

/** Session TTL: auto-expire working memory after 4 hours of inactivity. */
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;


// ─── Working Memory Service ──────────────────────────────────────────────────

/**
 * WorkingMemoryService — the active workspace.
 *
 * Session-scoped, capacity-limited, and actively managed. Orchestrates retrieval
 * from all long-term memory systems (episodic, semantic, procedural, prospective)
 * and curates what enters the system prompt.
 *
 * Analog: Baddeley's working memory model — central executive + episodic buffer.
 * Not just passive storage, but active manipulation and coordination.
 */
const WorkingMemoryService = {

  /**
   * Load or create a working memory workspace for a session.
   * Pulls relevant memories from all long-term stores based on the query context.
   *
   * @param {object} params
   * @param {string} params.agent
   * @param {string} params.project
   * @param {string} params.traceId
   * @param {string} params.queryText - User's message (drives retrieval)
   * @param {string} [params.username]
   * @returns {Promise<object>} The assembled working memory state
   */
  async load({ agent, project, traceId, agentSessionId, queryText, username }) {
    if (!agent) throw new Error("WorkingMemoryService.load requires an agent");
    if (!traceId) throw new Error("WorkingMemoryService.load requires a traceId");

    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);

    // Check for existing session workspace
    let workspace = await collection.findOne({ agent, traceId });

    if (!workspace) {
      workspace = {
        id: crypto.randomUUID(),
        agent,
        traceId,
        project: project || null,
        username: username || null,
        slots: [],
        scratchpad: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      };
      await collection.insertOne(workspace);
    }

    // If no query, return existing workspace as-is
    if (!queryText) return this._formatWorkspace(workspace);

    // ── Parallel retrieval from all long-term systems ──────────────
    const [semanticResults, episodicResults, proceduralResults, prospectiveResults] =
      await Promise.all([
        SemanticMemoryService.search({
          agent,
          project,
          queryText,
          limit: FETCH_LIMITS.semantic,
          agentSessionId,
        }).catch((err) => {
          logger.warn(`[WorkingMemory] Semantic search failed: ${err.message}`);
          return [];
        }),

        EpisodicMemoryService.search({
          agent,
          project,
          queryText,
          limit: FETCH_LIMITS.episodic,
          agentSessionId,
        }).catch((err) => {
          logger.warn(`[WorkingMemory] Episodic search failed: ${err.message}`);
          return [];
        }),

        ProceduralMemoryService.search({
          agent,
          project,
          queryText,
          limit: FETCH_LIMITS.procedural,
          agentSessionId,
        }).catch((err) => {
          logger.warn(`[WorkingMemory] Procedural search failed: ${err.message}`);
          return [];
        }),

        ProspectiveMemoryService.checkTriggers({
          agent,
          project,
          queryText,
          agentSessionId,
        }).catch((err) => {
          logger.warn(`[WorkingMemory] Prospective check failed: ${err.message}`);
          return [];
        }),
      ]);

    // ── Build slots from retrieval results ──────────────────────────
    const newSlots = [];

    // Semantic → context slots
    for (const mem of semanticResults) {
      newSlots.push({
        type: "context",
        subtype: mem.type, // preference, fact, rule, reference
        content: mem.title ? `${mem.title}: ${mem.content}` : mem.content,
        source: `semantic:${mem.id}`,
        score: mem.score,
        loadedAt: new Date().toISOString(),
      });
    }

    // Episodic → experience slots
    for (const ep of episodicResults) {
      const decisions = ep.keyDecisions?.length > 0
        ? ` — Decisions: ${ep.keyDecisions.join("; ")}`
        : "";
      newSlots.push({
        type: "experience",
        content: `[${ep.age}] ${ep.summary}${decisions}`,
        source: `episodic:${ep.id}`,
        score: ep.score,
        loadedAt: new Date().toISOString(),
      });
    }

    // Procedural → procedure slots
    for (const proc of proceduralResults) {
      newSlots.push({
        type: "procedure",
        content: `When: ${proc.trigger}\n${proc.procedure.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
        source: `procedural:${proc.id}`,
        score: proc.score,
        successRate: proc.successRate,
        loadedAt: new Date().toISOString(),
      });
    }

    // Prospective → reminder slots (always include, no score comparison)
    for (const rem of prospectiveResults) {
      newSlots.push({
        type: "reminder",
        content: rem.intention,
        context: rem.context,
        priority: rem.priority,
        source: `prospective:${rem.id}`,
        score: 1, // reminders always get max priority
        loadedAt: new Date().toISOString(),
      });
    }

    // ── Capacity management: keep top K slots by score ──────────────
    // Reminders always get priority (score = 1), then sort by score
    newSlots.sort((a, b) => b.score - a.score);
    const finalSlots = newSlots.slice(0, MAX_SLOTS);

    // Update workspace
    const now = new Date().toISOString();
    await collection.updateOne(
      { agent, traceId },
      {
        $set: {
          slots: finalSlots,
          updatedAt: now,
          expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        },
      },
    );

    workspace.slots = finalSlots;

    const counts = {
      semantic: semanticResults.length,
      episodic: episodicResults.length,
      procedural: proceduralResults.length,
      prospective: prospectiveResults.length,
      total: finalSlots.length,
    };

    logger.info(
      `[WorkingMemory] Loaded ${counts.total} slots for ${agent}/${project || "global"} ` +
      `(sem:${counts.semantic} ep:${counts.episodic} proc:${counts.procedural} prosp:${counts.prospective})`,
    );

    return this._formatWorkspace(workspace, counts);
  },

  /**
   * Add a note to the scratchpad (intermediate reasoning).
   *
   * @param {string} traceId
   * @param {string} agent
   * @param {string} note
   */
  async addScratchpadNote(traceId, agent, note) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    await collection.updateOne(
      { agent, traceId },
      {
        $push: { scratchpad: { content: note, addedAt: new Date().toISOString() } },
        $set: { updatedAt: new Date().toISOString() },
      },
    );
  },

  /**
   * Format the working memory workspace for system prompt injection.
   * Returns structured sections for each memory type.
   *
   * @param {object} workspace
   * @param {object} [counts]
   * @returns {object} { prompt, reminders, counts }
   */
  _formatWorkspace(workspace, counts = null) {
    const sections = [];
    const slots = workspace.slots || [];

    // Group slots by type
    const reminders = slots.filter((s) => s.type === "reminder");
    const context = slots.filter((s) => s.type === "context");
    const experiences = slots.filter((s) => s.type === "experience");
    const procedures = slots.filter((s) => s.type === "procedure");

    // Reminders (prospective memory) — highest priority
    if (reminders.length > 0) {
      const priorityIcons = { critical: "🔴", high: "🟠", medium: "⏰", low: "🔵" };
      const reminderLines = reminders.map((r) => {
        const icon = priorityIcons[r.priority] || "⏰";
        const ctx = r.context ? ` — ${r.context}` : "";
        return `- ${icon} ${r.content}${ctx}`;
      });
      sections.push(`## Pending Reminders\n${reminderLines.join("\n")}`);
    }

    // Context (semantic memory) — stable knowledge
    if (context.length > 0) {
      const contextLines = context.map((c) => `- [${c.subtype || "fact"}] ${c.content}`);
      sections.push(`## Known Facts\n${contextLines.join("\n")}`);
    }

    // Experiences (episodic memory) — relevant past sessions
    if (experiences.length > 0) {
      const expLines = experiences.map((e) => `- ${e.content}`);
      sections.push(`## Relevant Past Sessions\n${expLines.join("\n")}`);
    }

    // Procedures (procedural memory) — learned approaches
    if (procedures.length > 0) {
      const procLines = procedures.map((p) => {
        const rate = p.successRate != null ? ` (${Math.round(p.successRate * 100)}% success)` : "";
        return `- ${p.content}${rate}`;
      });
      sections.push(`## Learned Procedures\n${procLines.join("\n")}`);
    }

    return {
      prompt: sections.join("\n\n"),
      reminders,
      counts,
      slotCount: slots.length,
      maxSlots: MAX_SLOTS,
    };
  },

  /**
   * Clean up expired working memory sessions.
   */
  async cleanupExpired() {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const now = new Date().toISOString();
    const result = await collection.deleteMany({
      expiresAt: { $lte: now },
    });
    if (result.deletedCount > 0) {
      logger.info(`[WorkingMemory] Cleaned up ${result.deletedCount} expired session(s)`);
    }
  },

  /**
   * Ensure indexes.
   */
  async ensureIndexes() {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return;
    const collection = db.collection(COLLECTION);
    await Promise.all([
      collection.createIndex({ agent: 1, traceId: 1 }, { unique: true }),
      collection.createIndex({ expiresAt: 1 }),
      collection.createIndex({ id: 1 }, { unique: true }),
    ]);
    logger.info("[WorkingMemory] Indexes ensured.");
  },
};

export default WorkingMemoryService;

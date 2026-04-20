import express from "express";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import {
  computeModalities,
  extractProviders,
  computeTotalCost,
} from "../services/ConversationService.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import { COLLECTIONS } from "../constants.js";
import logger from "../utils/logger.js";

const router = express.Router();
const COLLECTION = COLLECTIONS.AGENT_SESSIONS;

/**
 * GET /agent-sessions
 * List all agent sessions for the given project.
 * Enriches each session with toolCounts from request logs (single aggregation).
 */
router.get("/", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;
    const db = client.db(MONGO_DB_NAME);

    // Fetch sessions and aggregate tool counts from requests in parallel
    const [sessions, toolCountDocs] = await Promise.all([
      db.collection(COLLECTION)
        .find({ project, username })
        .sort({ updatedAt: -1 })
        .toArray(),
      db.collection(COLLECTIONS.REQUESTS)
        .aggregate([
          { $match: { project, username, toolApiNames: { $exists: true, $ne: [] } } },
          { $unwind: "$toolApiNames" },
          { $group: {
            _id: { sessionId: "$agentSessionId", tool: "$toolApiNames" },
            count: { $sum: 1 },
          }},
          { $group: {
            _id: "$_id.sessionId",
            tools: { $push: { name: "$_id.tool", count: "$count" } },
          }},
        ])
        .toArray(),
    ]);

    // Build sessionId → toolCounts map
    const toolCountsMap = new Map();
    for (const doc of toolCountDocs) {
      const counts = {};
      for (const t of doc.tools) counts[t.name] = t.count;
      toolCountsMap.set(doc._id, counts);
    }

    // Merge toolCounts into each session
    for (const session of sessions) {
      session.toolCounts = toolCountsMap.get(session.id) || null;
    }

    res.json(sessions);
  } catch (error) {
    logger.error(`Error fetching agent sessions: ${error.message}`);
    next(error);
  }
});

/**
 * GET /agent-sessions/:id
 * Get a specific agent session, including aggregated stats from request logs.
 */
router.get("/:id", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;
    const db = client.db(MONGO_DB_NAME);
    const session = await db
      .collection(COLLECTION)
      .findOne({ id: req.params.id, project, username });

    if (!session) {
      return res.status(404).json({ error: "Agent session not found" });
    }

    // ── Aggregate stats from request logs (single source of truth) ──
    // Recursively discover all descendant session IDs (multi-level workers)
    const sessionId = req.params.id;
    const allSessionIds = new Set([sessionId]);
    let frontier = [sessionId];
    for (let depth = 0; depth < 10 && frontier.length > 0; depth++) {
      const childIds = await db
        .collection(COLLECTIONS.REQUESTS)
        .distinct("agentSessionId", {
          parentAgentSessionId: { $in: frontier },
          agentSessionId: { $nin: [...allSessionIds] },
        });
      if (childIds.length === 0) break;
      const newIds = childIds.filter(Boolean);
      for (const id of newIds) allSessionIds.add(id);
      frontier = newIds;
    }

    const requests = await db
      .collection(COLLECTIONS.REQUESTS)
      .find({ agentSessionId: { $in: [...allSessionIds] } })
      .project({
        estimatedCost: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 1,
        reasoningOutputTokens: 1,
        provider: 1,
        model: 1,
        operation: 1,
        timestamp: 1,
        modalities: 1,
        toolApiNames: 1,
        success: 1,
        agentSessionId: 1,
        parentAgentSessionId: 1,
        tokensPerSec: 1,
        generationTime: 1,
        timeToGeneration: 1,
      })
      .toArray();

    // ── Shared aggregation helper ───────────────────────────────
    const aggregateRequests = (reqs) => {
      if (reqs.length === 0) return null;
      const providers = new Set();
      const models = new Set();
      const operations = new Set();
      let totalCost = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheReadInputTokens = 0;
      let totalCacheCreationInputTokens = 0;
      let totalReasoningOutputTokens = 0;
      const mergedModalities = {};
      const toolCounts = {};
      // Collect per-request tok/s for generation-only average
      const tpsValues = [];
      const ttftValues = [];

      for (const r of reqs) {
        totalCost += r.estimatedCost || 0;
        totalInputTokens += r.inputTokens || 0;
        totalOutputTokens += r.outputTokens || 0;
        totalCacheReadInputTokens += r.cacheReadInputTokens || 0;
        totalCacheCreationInputTokens += r.cacheCreationInputTokens || 0;
        totalReasoningOutputTokens += r.reasoningOutputTokens || 0;
        if (r.provider) providers.add(r.provider);
        if (r.model) models.add(r.model);
        if (r.operation) operations.add(r.operation);
        if (r.modalities) {
          for (const [k, v] of Object.entries(r.modalities)) {
            if (v) mergedModalities[k] = true;
          }
        }
        if (r.toolApiNames?.length > 0) {
          for (const name of r.toolApiNames) {
            toolCounts[name] = (toolCounts[name] || 0) + 1;
          }
        }
        // Per-request generation metrics (null-safe)
        if (r.tokensPerSec != null && r.tokensPerSec > 0) {
          tpsValues.push(r.tokensPerSec);
        }
        if (r.timeToGeneration != null && r.timeToGeneration > 0) {
          ttftValues.push(r.timeToGeneration);
        }
      }

      const earliest = reqs.reduce((min, r) => (!min || r.timestamp < min ? r.timestamp : min), null);
      const latest = reqs.reduce((max, r) => (!max || r.timestamp > max ? r.timestamp : max), null);
      const totalElapsedTime = earliest && latest
        ? Math.max(0, (new Date(latest).getTime() - new Date(earliest).getTime()) / 1000)
        : 0;

      // Average tok/s across all requests — naturally handles concurrency
      // (each request measures its own generation speed) and excludes idle
      // time (only generation phases contribute measurements).
      const avgTokensPerSec = tpsValues.length > 0
        ? tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length
        : null;
      const avgTimeToGeneration = ttftValues.length > 0
        ? ttftValues.reduce((a, b) => a + b, 0) / ttftValues.length
        : null;

      return {
        requestCount: reqs.length,
        totalCost,
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        totalCacheReadInputTokens,
        totalCacheCreationInputTokens,
        totalReasoningOutputTokens,
        providers: [...providers],
        models: [...models],
        operations: [...operations],
        modalities: mergedModalities,
        toolCounts,
        totalElapsedTime,
        avgTokensPerSec,
        avgTimeToGeneration,
        createdAt: earliest,
        updatedAt: latest,
      };
    };

    // ── Split requests into orchestrator vs worker buckets ────
    const orchestratorRequests = requests.filter((r) => r.agentSessionId === sessionId);
    const workerRequests = requests.filter((r) => r.agentSessionId !== sessionId);

    let stats = null;
    if (requests.length > 0) {
      const allStats = aggregateRequests(requests);
      allStats.workerRequestCount = workerRequests.length;
      stats = {
        ...allStats,
        orchestrator: aggregateRequests(orchestratorRequests),
        workers: aggregateRequests(workerRequests),
      };
    }

    res.json({ ...session, stats });
  } catch (error) {
    logger.error(`Error fetching agent session: ${error.message}`);
    next(error);
  }
});

/**
 * PATCH /agent-sessions/:id
 * Update specific fields of an agent session.
 */
router.patch("/:id", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;
    const { title, messages, systemPrompt, settings } = req.body;

    const setFields = { updatedAt: new Date().toISOString() };
    if (title !== undefined) setFields.title = title;
    if (messages !== undefined) {
      setFields.messages = messages;
      setFields.modalities = computeModalities(messages);
      setFields.providers = extractProviders(messages, settings);
      setFields.totalCost = computeTotalCost(messages);
    }
    if (systemPrompt !== undefined) setFields.systemPrompt = systemPrompt;
    if (settings !== undefined) {
      setFields.settings = { ...settings, systemPrompt: systemPrompt || "" };
    }

    const result = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .updateOne({ id: req.params.id, project, username }, { $set: setFields });

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Agent session not found" });
    }

    const session = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .findOne({ id: req.params.id, project, username });

    res.json(session);
  } catch (error) {
    logger.error(`Error patching agent session: ${error.message}`);
    next(error);
  }
});

/**
 * DELETE /agent-sessions/:id
 * Delete a specific agent session.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;
    const result = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .deleteOne({ id: req.params.id, project, username });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Agent session not found" });
    }

    res.json({ success: true, id: req.params.id });
  } catch (error) {
    logger.error(`Error deleting agent session: ${error.message}`);
    next(error);
  }
});

export default router;

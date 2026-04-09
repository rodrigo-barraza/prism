import crypto from "crypto";
import { getProvider } from "../providers/index.js";
import MemoryService from "./MemoryService.js";
import RequestLogger from "./RequestLogger.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";
import { cosineSimilarity, calculateTokensPerSec } from "../utils/math.js";
import { estimateTokens } from "../utils/CostCalculator.js";
import { TYPES, getPricing } from "../config.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const CONSOLIDATION_PROVIDER = "anthropic";
const CONSOLIDATION_MODEL = "claude-haiku-4-5-20251001";

/** Cosine similarity above which two memories are clustered together */
const CLUSTER_THRESHOLD = 0.75;

/** Max memories per cluster sent to the LLM (avoid token blowup) */
const MAX_CLUSTER_SIZE = 8;

/** Memories older than this (days) with ephemeral types get flagged for staleness review */
const STALENESS_DAYS = 30;

/** Min sessions between consolidation runs */
const SESSIONS_BETWEEN_RUNS = 5;

/** Max consolidation runs per project per day (cost guard) */
const DAILY_MAX_CONSOLIDATIONS = 3;

const RUNS_COLLECTION = "memory_consolidation_runs";
const HISTORY_COLLECTION = "memory_consolidation_history";


function daysSince(isoDate) {
  return Math.max(0, Math.floor((Date.now() - new Date(isoDate).getTime()) / 86_400_000));
}

// ─── Cluster Detection ───────────────────────────────────────────────────────

/**
 * Find clusters of semantically similar memories using Union-Find.
 * Returns arrays of memory groups (each group has 2+ memories).
 */
function findClusters(memories) {
  const n = memories.length;
  if (n < 2) return [];

  // Union-Find
  const parent = Array.from({ length: n }, (_, i) => i);
  const rank = new Array(n).fill(0);

  function find(x) {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(x, y) {
    const px = find(x), py = find(y);
    if (px === py) return;
    if (rank[px] < rank[py]) parent[px] = py;
    else if (rank[px] > rank[py]) parent[py] = px;
    else { parent[py] = px; rank[px]++; }
  }

  // Pairwise comparison — O(n²) but fine for <500 memories
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!memories[i].embedding || !memories[j].embedding) continue;
      const sim = cosineSimilarity(memories[i].embedding, memories[j].embedding);
      if (sim > CLUSTER_THRESHOLD) {
        union(i, j);
      }
    }
  }

  // Group by root
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(memories[i]);
  }

  // Only return clusters with 2+ members, capped at MAX_CLUSTER_SIZE
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => g.slice(0, MAX_CLUSTER_SIZE));
}

// ─── LLM Prompt ──────────────────────────────────────────────────────────────

const CONSOLIDATION_PROMPT = `You are a memory consolidation agent. You review a set of stored memories and determine how to optimize them.

## Your Goals
1. **Merge** redundant or overlapping memories into a single, more comprehensive memory
2. **Resolve contradictions** — if two memories disagree, the NEWER one is more authoritative
3. **Promote patterns** — if multiple memories point to the same insight, synthesize into one clear rule
4. **Flag stale** — memories about ephemeral state (bugs, deadlines, in-progress work) that are >30 days old should be deleted

## Rules
- Preserve the original TYPE (user, feedback, project, reference) when merging
- If merging memories of different types, pick the most appropriate type
- Each merged memory should be self-contained — don't reference "the original memories"
- Be conservative: only merge when there's clear overlap. Leave distinct memories alone
- Never invent new information — only combine what exists

## Output Format
Respond with ONLY a JSON object:
\`\`\`json
{
  "actions": [
    {
      "type": "merge",
      "sourceIds": ["id1", "id2"],
      "merged": {
        "type": "feedback",
        "title": "Short title",
        "content": "Consolidated content"
      },
      "reason": "Brief explanation"
    },
    {
      "type": "delete",
      "id": "id3",
      "reason": "Stale: referenced deadline that passed"
    }
  ],
  "summary": "Brief description of what was consolidated"
}
\`\`\`

If no consolidation is needed, return: { "actions": [], "summary": "No consolidation needed" }`;

function buildConsolidationInput(clusters, allMemories) {
  const sections = [];

  // Clusters for merge consideration
  if (clusters.length > 0) {
    sections.push("## Clusters of Similar Memories\n");
    clusters.forEach((cluster, i) => {
      sections.push(`### Cluster ${i + 1} (${cluster.length} memories, likely overlap):`);
      cluster.forEach((m) => {
        const age = daysSince(m.createdAt);
        sections.push(`- **ID**: ${m.id}\n  **Type**: ${m.type}\n  **Title**: ${m.title}\n  **Content**: ${m.content}\n  **Age**: ${age} days`);
      });
      sections.push("");
    });
  }

  // Stale memories for deletion consideration
  const staleMemories = allMemories.filter((m) => {
    const age = daysSince(m.createdAt);
    return age > STALENESS_DAYS && (m.type === "project" || m.type === "reference");
  });

  if (staleMemories.length > 0) {
    sections.push("## Potentially Stale Memories (>30 days old, ephemeral types)\n");
    staleMemories.forEach((m) => {
      const age = daysSince(m.createdAt);
      sections.push(`- **ID**: ${m.id}\n  **Type**: ${m.type}\n  **Title**: ${m.title}\n  **Content**: ${m.content}\n  **Age**: ${age} days`);
    });
  }

  if (sections.length === 0) {
    return null; // Nothing to consolidate
  }

  return sections.join("\n");
}

// ─── Action Execution ────────────────────────────────────────────────────────

async function applyActions(actions, agent, project, username, { sessionId, endpoint } = {}) {
  const results = { merged: 0, deleted: 0, errors: 0 };

  for (const action of actions) {
    try {
      if (action.type === "merge" && action.sourceIds?.length >= 2 && action.merged) {
        // Delete source memories
        for (const id of action.sourceIds) {
          await MemoryService.remove(id);
        }

        // Store consolidated memory
        await MemoryService.store({
          agent,
          project,
          username: username || "system",
          type: action.merged.type || "project",
          title: action.merged.title,
          content: action.merged.content,
          conversationId: null,
          sessionId: sessionId || null,
          endpoint: endpoint || null,
        });

        results.merged += action.sourceIds.length;
        logger.info(
          `[MemoryConsolidation] Merged ${action.sourceIds.length} → "${action.merged.title}" (${action.reason || ""})`,
        );
      } else if (action.type === "delete" && action.id) {
        await MemoryService.remove(action.id);
        results.deleted++;
        logger.info(
          `[MemoryConsolidation] Deleted "${action.id}" (${action.reason || ""})`,
        );
      }
    } catch (err) {
      results.errors++;
      logger.error(`[MemoryConsolidation] Failed to apply action: ${err.message}`);
    }
  }

  return results;
}

// ─── Run Tracking ────────────────────────────────────────────────────────────

async function getRunCount(project) {
  const client = MongoWrapper.getClient(MONGO_DB_NAME);
  if (!client) return 0;
  const db = client.db(MONGO_DB_NAME);
  const doc = await db.collection(RUNS_COLLECTION).findOne({ project });
  return doc?.sessionsSinceLastRun || 0;
}

async function incrementRunCount(project) {
  const client = MongoWrapper.getClient(MONGO_DB_NAME);
  if (!client) return;
  const db = client.db(MONGO_DB_NAME);
  await db.collection(RUNS_COLLECTION).updateOne(
    { project },
    { $inc: { sessionsSinceLastRun: 1 } },
    { upsert: true },
  );
}

async function resetRunCount(project) {
  const client = MongoWrapper.getClient(MONGO_DB_NAME);
  if (!client) return;
  const db = client.db(MONGO_DB_NAME);
  await db.collection(RUNS_COLLECTION).updateOne(
    { project },
    {
      $set: {
        sessionsSinceLastRun: 0,
        lastConsolidatedAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  );
}

// ─── History & Cost Guard ────────────────────────────────────────────────────

/**
 * Record a consolidation run for audit trail.
 */
async function recordHistory(project, trigger, memoriesBefore, actions, summary, durationMs) {
  const client = MongoWrapper.getClient(MONGO_DB_NAME);
  if (!client) return;

  const db = client.db(MONGO_DB_NAME);
  const mergeCount = actions.filter((a) => a.type === "merge").reduce(
    (sum, a) => sum + (a.sourceIds?.length || 0), 0,
  );
  const deleteCount = actions.filter((a) => a.type === "delete").length;

  await db.collection(HISTORY_COLLECTION).insertOne({
    project,
    runAt: new Date().toISOString(),
    trigger,
    memoriesBefore,
    memoriesAfter: memoriesBefore - mergeCount - deleteCount + actions.filter((a) => a.type === "merge").length,
    actionsApplied: actions.length,
    actions: actions.map((a) => ({
      type: a.type,
      ...(a.sourceIds && { sourceIds: a.sourceIds }),
      ...(a.merged && { mergedTitle: a.merged.title }),
      ...(a.id && { deletedId: a.id }),
      reason: a.reason || "",
    })),
    summary,
    durationMs,
  });
}

/**
 * Check if the daily consolidation budget is exhausted.
 * Returns true if more runs are allowed.
 */
async function canRunToday(project) {
  const client = MongoWrapper.getClient(MONGO_DB_NAME);
  if (!client) return true;

  const db = client.db(MONGO_DB_NAME);
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const todayCount = await db.collection(HISTORY_COLLECTION).countDocuments({
    project,
    runAt: { $gte: startOfDay.toISOString() },
  });

  if (todayCount >= DAILY_MAX_CONSOLIDATIONS) {
    logger.warn(
      `[MemoryConsolidation] Daily limit reached for "${project}" (${todayCount}/${DAILY_MAX_CONSOLIDATIONS})`,
    );
    return false;
  }
  return true;
}

// ─── Public API ──────────────────────────────────────────────────────────────

const MemoryConsolidationService = {
  /**
   * Run memory consolidation for a specific agent within a project.
   *
   * @param {object} params
   * @param {string} params.agent - Agent identifier
   * @param {string} params.project - Project identifier
   * @param {string} [params.username] - For attribution on merged memories
   * @param {string} [params.trigger="manual"] - What triggered the run ("manual", "scheduled", "session_threshold")
   * @param {function} [params.broadcast] - Optional callback for real-time WebSocket notifications
   * @returns {Promise<object>} Consolidation results
   */
  async consolidate({ agent = "CODING", project, username, trigger = "manual", broadcast, endpoint, sessionId }) {
    const startTime = performance.now();
    logger.info(`[MemoryConsolidation] Starting consolidation for project "${project}" (trigger: ${trigger})`);

    // Cost guard — check daily budget
    if (!(await canRunToday(project))) {
      return { skipped: true, reason: "daily_limit_reached", total: 0 };
    }

    // Load all memories with embeddings
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) throw new Error("Database not available");

    const db = client.db(MONGO_DB_NAME);
    const agentId = agent || "CODING";
    const allMemories = await db
      .collection("memories")
      .find({ agent: agentId, project })
      .project({ embedding: 1, id: 1, type: 1, title: 1, content: 1, createdAt: 1 })
      .toArray();

    if (allMemories.length < 2) {
      logger.info(`[MemoryConsolidation] Only ${allMemories.length} memories — skipping`);
      await resetRunCount(project);
      return { skipped: true, reason: "insufficient memories", total: allMemories.length };
    }

    // Phase 1: Cluster detection
    const clusters = findClusters(allMemories);
    logger.info(
      `[MemoryConsolidation] Found ${clusters.length} clusters from ${allMemories.length} memories`,
    );

    // Phase 2: Build LLM input
    const input = buildConsolidationInput(clusters, allMemories);
    if (!input) {
      logger.info("[MemoryConsolidation] No clusters or stale memories — nothing to consolidate");
      await resetRunCount(project);
      return { skipped: true, reason: "no candidates", total: allMemories.length };
    }

    // Phase 3: LLM analysis
    const provider = getProvider(CONSOLIDATION_PROVIDER);
    const aiMessages = [
      { role: "system", content: CONSOLIDATION_PROMPT },
      { role: "user", content: input },
    ];

    const llmRequestId = crypto.randomUUID();
    const llmStart = performance.now();
    let llmSuccess = true;
    let llmError = null;

    const result = await provider.generateText(aiMessages, CONSOLIDATION_MODEL, {
      maxTokens: 2000,
      temperature: 0.1,
    }).catch((err) => {
      llmSuccess = false;
      llmError = err.message;
      throw err;
    }).finally(() => {
      // intentionally empty — logging happens below after we have the result
    });

    // Log the consolidation LLM call
    {
      const llmTotalSec = (performance.now() - llmStart) / 1000;
      const inputText = aiMessages.map((m) => m.content).join("\n");
      const approxInputTokens = estimateTokens(inputText);
      const approxOutputTokens = result ? estimateTokens(result.text || "") : 0;
      const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[CONSOLIDATION_MODEL];
      let estimatedCost = null;
      if (pricing) {
        const inputCost = (approxInputTokens / 1_000_000) * (pricing.inputPerMillion || 0);
        const outputCost = (approxOutputTokens / 1_000_000) * (pricing.outputPerMillion || 0);
        estimatedCost = parseFloat((inputCost + outputCost).toFixed(8));
      }

      RequestLogger.log({
        requestId: llmRequestId,
        endpoint: endpoint || null,
        operation: "memory:consolidate",
        project,
        username: username || "system",
        clientIp: null,
        agent: agent || null,
        sessionId: sessionId || null,
        provider: CONSOLIDATION_PROVIDER,
        model: CONSOLIDATION_MODEL,
        success: llmSuccess,
        errorMessage: llmError,
        estimatedCost,
        inputTokens: approxInputTokens,
        outputTokens: approxOutputTokens,
        tokensPerSec: calculateTokensPerSec(approxOutputTokens, llmTotalSec),
        inputCharacters: inputText.length,
        totalTime: parseFloat(llmTotalSec.toFixed(3)),
        modalities: { textIn: true, textOut: true },
        requestPayload: {
          operation: "memory:consolidate",
          trigger,
          clusterCount: clusters.length,
          memoryCount: allMemories.length,
        },
        responsePayload: llmSuccess
          ? { textPreview: (result?.text || "").slice(0, 200) }
          : { error: llmError },
      });
    }

    // Parse response
    let parsed;
    try {
      let jsonText = (result.text || "").trim();
      const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonText = jsonMatch[1].trim();
      parsed = JSON.parse(jsonText);
    } catch {
      logger.warn("[MemoryConsolidation] Failed to parse LLM response");
      await resetRunCount(project);
      return { error: "parse_failed", total: allMemories.length };
    }

    const actions = parsed.actions || [];
    if (actions.length === 0) {
      logger.info(`[MemoryConsolidation] LLM found no actions needed: ${parsed.summary || ""}`);
      await resetRunCount(project);
      return { actions: 0, summary: parsed.summary, total: allMemories.length };
    }

    // Phase 4: Apply changes
    const results = await applyActions(actions, agentId, project, username, { sessionId, endpoint });
    await resetRunCount(project);

    const summary = parsed.summary || `Merged ${results.merged}, deleted ${results.deleted}`;
    const durationMs = Math.round(performance.now() - startTime);
    logger.info(`[MemoryConsolidation] Complete: ${summary} (${durationMs}ms)`);

    // Phase 5: Record history for audit trail
    await recordHistory(project, trigger, allMemories.length, actions, summary, durationMs);

    const consolidationResult = {
      ...results,
      actionsApplied: actions.length,
      summary,
      total: allMemories.length,
      trigger,
      durationMs,
    };

    // Broadcast to connected clients if callback provided
    if (typeof broadcast === "function") {
      try {
        broadcast({
          type: "memory_consolidation_complete",
          project,
          ...consolidationResult,
        });
      } catch (err) {
        logger.warn(`[MemoryConsolidation] Broadcast failed: ${err.message}`);
      }
    }

    return consolidationResult;
  },

  /**
   * Check if consolidation should run and trigger if needed.
   * Called by SessionSummarizer after storing new memories.
   *
   * @param {object} params
   * @param {string} params.project - Project identifier
   * @param {string} [params.username] - Username for attribution
   * @param {function} [params.broadcast] - Optional broadcast callback for WebSocket notifications
   */
  async checkAndRun({ project, username, broadcast, endpoint, agent, sessionId }) {
    try {
      await incrementRunCount(project);
      const count = await getRunCount(project);

      if (count >= SESSIONS_BETWEEN_RUNS) {
        logger.info(
          `[MemoryConsolidation] Threshold reached (${count}/${SESSIONS_BETWEEN_RUNS}) — triggering`,
        );
        // Fire-and-forget
        MemoryConsolidationService.consolidate({
          agent: agent || "CODING",
          project,
          username,
          trigger: "session_threshold",
          broadcast,
          endpoint: endpoint || "/agent",
          sessionId: sessionId || null,
        }).catch((err) =>
          logger.error(`[MemoryConsolidation] Background consolidation failed: ${err.message}`),
        );
      }
    } catch (err) {
      logger.error(`[MemoryConsolidation] checkAndRun failed: ${err.message}`);
    }
  },

  /**
   * Get consolidation run history for a project.
   *
   * @param {string} project - Project identifier
   * @param {number} [limit=10] - Max history entries to return
   * @returns {Promise<Array>} Consolidation history entries, newest first
   */
  async getHistory(project, limit = 10) {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) return [];

    const db = client.db(MONGO_DB_NAME);
    return db
      .collection(HISTORY_COLLECTION)
      .find({ project })
      .sort({ runAt: -1 })
      .limit(limit)
      .project({ _id: 0 })
      .toArray();
  },
};

export default MemoryConsolidationService;

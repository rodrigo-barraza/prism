import { getProvider } from "../providers/index.js";
import AgentMemoryService from "./AgentMemoryService.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";

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

const RUNS_COLLECTION = "memory_consolidation_runs";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

async function applyActions(actions, project, username) {
  const results = { merged: 0, deleted: 0, errors: 0 };

  for (const action of actions) {
    try {
      if (action.type === "merge" && action.sourceIds?.length >= 2 && action.merged) {
        // Delete source memories
        for (const id of action.sourceIds) {
          await AgentMemoryService.remove(id);
        }

        // Store consolidated memory
        await AgentMemoryService.store({
          project,
          username: username || "system",
          type: action.merged.type || "project",
          title: action.merged.title,
          content: action.merged.content,
          conversationId: null,
        });

        results.merged += action.sourceIds.length;
        logger.info(
          `[MemoryConsolidation] Merged ${action.sourceIds.length} → "${action.merged.title}" (${action.reason || ""})`,
        );
      } else if (action.type === "delete" && action.id) {
        await AgentMemoryService.remove(action.id);
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

// ─── Public API ──────────────────────────────────────────────────────────────

const MemoryConsolidationService = {
  /**
   * Run memory consolidation for a project.
   *
   * @param {object} params
   * @param {string} params.project - Project identifier
   * @param {string} [params.username] - For attribution on merged memories
   * @returns {Promise<object>} Consolidation results
   */
  async consolidate({ project, username }) {
    logger.info(`[MemoryConsolidation] Starting consolidation for project "${project}"`);

    // Load all memories with embeddings
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) throw new Error("Database not available");

    const db = client.db(MONGO_DB_NAME);
    const allMemories = await db
      .collection("agent_memories")
      .find({ project })
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

    const result = await provider.generateText(aiMessages, CONSOLIDATION_MODEL, {
      maxTokens: 2000,
      temperature: 0.1,
    });

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
    const results = await applyActions(actions, project, username);
    await resetRunCount(project);

    const summary = parsed.summary || `Merged ${results.merged}, deleted ${results.deleted}`;
    logger.info(`[MemoryConsolidation] Complete: ${summary}`);

    return {
      ...results,
      actionsApplied: actions.length,
      summary,
      total: allMemories.length,
    };
  },

  /**
   * Check if consolidation should run and trigger if needed.
   * Called by SessionSummarizer after storing new memories.
   */
  async checkAndRun({ project, username }) {
    try {
      await incrementRunCount(project);
      const count = await getRunCount(project);

      if (count >= SESSIONS_BETWEEN_RUNS) {
        logger.info(
          `[MemoryConsolidation] Threshold reached (${count}/${SESSIONS_BETWEEN_RUNS}) — triggering`,
        );
        // Fire-and-forget
        MemoryConsolidationService.consolidate({ project, username }).catch((err) =>
          logger.error(`[MemoryConsolidation] Background consolidation failed: ${err.message}`),
        );
      }
    } catch (err) {
      logger.error(`[MemoryConsolidation] checkAndRun failed: ${err.message}`);
    }
  },
};

export default MemoryConsolidationService;

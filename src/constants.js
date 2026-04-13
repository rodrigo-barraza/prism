// ─────────────────────────────────────────────────────────────
// Prism — Application Constants
// ─────────────────────────────────────────────────────────────

/**
 * MongoDB collection names — single source of truth.
 * Import from here instead of defining local `const COLLECTION = "..."`.
 */
export const COLLECTIONS = {
  REQUESTS: "requests",
  CONVERSATIONS: "conversations",
  AGENT_SESSIONS: "agent_sessions",
  WORKFLOWS: "workflows",
  BENCHMARKS: "benchmarks",
  BENCHMARK_RUNS: "benchmark_runs",
  SYNTHESIS: "synthesis",
  FAVORITES: "favorites",
  CUSTOM_TOOLS: "custom_tools",
  AGENT_SKILLS: "agent_skills",
  MCP_SERVERS: "mcp_servers",
  MEMORIES: "memories",
  MEMORY_EPISODIC: "memory_episodic",
  MEMORY_SEMANTIC: "memory_semantic",
  MEMORY_PROCEDURAL: "memory_procedural",
  MEMORY_PROSPECTIVE: "memory_prospective",
  MEMORY_WORKING: "memory_working",
  MEMORY_BUFFER: "memory_buffer",
  MEMORY_CONSOLIDATION_RUNS: "memory_consolidation_runs",
  MEMORY_CONSOLIDATION_HISTORY: "memory_consolidation_history",
  VRAM_BENCHMARKS: "vram_benchmarks",
  SETTINGS: "settings",
};

/**
 * Reusable MongoDB $group aggregation expression for summing estimated costs.
 * Sums the per-request `estimatedCost` field (USD, nullable).
 * Convention: aggregation outputs use `totalCost` as the destination field name.
 * Usage: `totalCost: COST_SUM_EXPR` inside `$group` stages.
 */
export const COST_SUM_EXPR = { $sum: { $ifNull: ["$estimatedCost", 0] } };

/**
 * Reusable MongoDB $group aggregation expression for summing total tokens.
 * Adds inputTokens + outputTokens (both nullable).
 * Usage: `totalTokens: TOTAL_TOKENS_EXPR` inside `$group` stages.
 */
export const TOTAL_TOKENS_EXPR = {
  $sum: {
    $add: [
      { $ifNull: ["$inputTokens", 0] },
      { $ifNull: ["$outputTokens", 0] },
    ],
  },
};

/**
 * Reusable MongoDB $group aggregation expression for averaging tok/s.
 * Filters out null and outlier (>10k) values before averaging.
 * Usage: `avgTokensPerSec: AVG_TOKENS_PER_SEC_EXPR` inside `$group` stages.
 */
export const AVG_TOKENS_PER_SEC_EXPR = {
  $avg: {
    $cond: [
      {
        $and: [
          { $ne: ["$tokensPerSec", null] },
          { $lte: ["$tokensPerSec", 10000] },
        ],
      },
      "$tokensPerSec",
      null,
    ],
  },
};

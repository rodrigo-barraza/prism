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
  AGENT_MEMORIES: "agent_memories",
};

/**
 * Reusable MongoDB $group aggregation expression for summing estimated costs.
 * Use as: `totalCost: COST_SUM_EXPR` inside `$group` stages.
 */
export const COST_SUM_EXPR = { $sum: { $ifNull: ["$estimatedCost", 0] } };

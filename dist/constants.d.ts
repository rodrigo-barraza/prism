/** SSE keep-alive ping interval for admin streaming endpoints. */
export declare const SSE_KEEPALIVE_INTERVAL_MS = 30000;
/** Reconnect interval for MongoDB change stream watchers. */
export declare const CHANGE_STREAM_RECONNECT_MS = 60000;
/** CORS preflight cache duration — 24 hours. */
export declare const CORS_MAX_AGE_SECONDS = 86400;
/**
 * MongoDB collection names — single source of truth.
 * Import from here instead of defining local `const COLLECTION = "..."`.
 */
export declare const COLLECTIONS: {
    REQUESTS: string;
    CONVERSATIONS: string;
    AGENT_SESSIONS: string;
    WORKFLOWS: string;
    BENCHMARKS: string;
    BENCHMARK_RUNS: string;
    SYNTHESIS: string;
    FAVORITES: string;
    CUSTOM_TOOLS: string;
    AGENT_SKILLS: string;
    MCP_SERVERS: string;
    MEMORIES: string;
    MEMORY_CONSOLIDATION_RUNS: string;
    MEMORY_CONSOLIDATION_HISTORY: string;
    VRAM_BENCHMARKS: string;
    SETTINGS: string;
    CUSTOM_AGENTS: string;
    WORKSPACES: string;
};
/**
 * Reusable MongoDB $group aggregation expression for summing estimated costs.
 * Sums the per-request `estimatedCost` field (USD, nullable).
 * Convention: aggregation outputs use `totalCost` as the destination field name.
 * Usage: `totalCost: COST_SUM_EXPR` inside `$group` stages.
 */
export declare const COST_SUM_EXPR: {
    $sum: {
        $ifNull: (string | number)[];
    };
};
/**
 * Reusable MongoDB $group aggregation expression for summing total tokens.
 * Adds inputTokens + outputTokens (both nullable).
 * Usage: `totalTokens: TOTAL_TOKENS_EXPR` inside `$group` stages.
 */
export declare const TOTAL_TOKENS_EXPR: {
    $sum: {
        $add: {
            $ifNull: (string | number)[];
        }[];
    };
};
/**
 * Reusable MongoDB $group aggregation expression for averaging tok/s.
 * Filters out null and outlier (>10k) values before averaging.
 * Usage: `avgTokensPerSec: AVG_TOKENS_PER_SEC_EXPR` inside `$group` stages.
 */
export declare const AVG_TOKENS_PER_SEC_EXPR: {
    $avg: {
        $cond: (string | {
            $and: ({
                $ne: (string | null)[];
                $lte?: undefined;
            } | {
                $lte: (string | number)[];
                $ne?: undefined;
            })[];
        } | null)[];
    };
};
//# sourceMappingURL=constants.d.ts.map
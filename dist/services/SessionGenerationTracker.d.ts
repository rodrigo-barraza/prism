declare const SessionGenerationTracker: {
    /**
     * Register a new LLM request for tracking.
     *
     * @param {string} agentSessionId - Parent session this request belongs to
     * @param {string} requestId      - Unique request identifier
     * @param {object} meta
     * @param {string} meta.provider
     * @param {string} meta.model
     * @param {string} [meta.source="orchestrator"] - "orchestrator" | "worker" | "tool-sub-request"
     * @param {string} [meta.workerId]              - Worker agent ID (for worker requests)
     */
    register(agentSessionId: any, requestId: any, { provider, model, source, workerId }?: {
        source?: string | undefined;
        workerId?: null | undefined;
    }): void;
    /**
     * Update a tracked request with new token data.
     * Called on each chunk/thinking event or on usage completion.
     *
     * @param {string} requestId
     * @param {object} data
     * @param {number} [data.outputTokens] - Running output token count
     * @param {number} [data.inputTokens]  - Input token count (from provider usage)
     * @param {number} [data.ttft]         - Time to first token in seconds
     */
    update(requestId: any, { outputTokens, inputTokens, ttft }?: {}): void;
    /**
     * Record chunk timing, increment the chunk counter, and accumulate
     * output characters for token estimation.
     *
     * The character count provides a much more accurate token estimate
     * than raw chunk count: Anthropic sends large thinking deltas
     * (50-200+ chars) as a single chunk, so chunkCount severely
     * undercounts tokens. Using `outputCharacters / 4` (~4 chars/token
     * for English) gives a reliable cross-provider heuristic.
     *
     * @param {string} requestId
     * @param {number} [charCount=0] - Number of characters in this chunk
     */
    recordChunkTiming(requestId: any, charCount?: number): void;
    /**
     * Mark a request as complete and remove it from active tracking.
     * Rolls the request's final token counts and computed tok/s into
     * the session accumulator so cumulative totals remain monotonically
     * non-decreasing.
     *
     * @param {string} requestId
     */
    complete(requestId: any): void;
    /**
     * Compute aggregate stats for all active requests in a session.
     *
     * Rate computation uses a warm-up guard: tok/s is only reported once
     * a request has accumulated at least MIN_TOKENS_FOR_RATE tokens over
     * at least MIN_ELAPSED_SEC seconds. This prevents anomalous spikes
     * from single large chunks arriving in near-zero elapsed time.
     *
     * @param {string} agentSessionId
     * @returns {{
     *   tokPerSec: number|null,
     *   activeRequests: number,
     *   totalOutputTokens: number,
     *   totalInputTokens: number,
     *   totalTokens: number,
     *   avgTtft: number|null,
     * }}
     */
    getSessionStats(agentSessionId: any): {
        tokPerSec: number | null;
        activeRequests: any;
        totalOutputTokens: any;
        totalInputTokens: any;
        totalTokens: any;
        avgTtft: number | null;
    };
    /**
     * Clean up all tracking data for a session.
     *
     * @param {string} agentSessionId
     */
    cleanup(agentSessionId: any): void;
    /**
     * Check if a session has any active requests.
     *
     * @param {string} agentSessionId
     * @returns {boolean}
     */
    hasActiveRequests(agentSessionId: any): boolean;
    /** Total active requests across all sessions (for diagnostics). */
    readonly totalActiveRequests: number;
};
export default SessionGenerationTracker;
//# sourceMappingURL=SessionGenerationTracker.d.ts.map
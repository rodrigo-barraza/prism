declare const MemoryConsolidationService: {
    /**
     * Run memory consolidation for a specific agent within a project.
     * Processes memories in batches to avoid context window overflow.
     *
     * @param {object} params
     * @param {string} params.agent - Agent identifier
     * @param {string} params.project - Project identifier
     * @param {string} [params.username] - For attribution on merged memories
     * @param {string} [params.trigger="manual"] - What triggered the run ("manual", "scheduled", "session_threshold")
     * @param {function} [params.broadcast] - Optional callback for real-time WebSocket notifications
     * @returns {Promise<object>} Consolidation results
     */
    consolidate({ agent, project, username, trigger, broadcast, endpoint, traceId, agentSessionId, guildId, }: any): Promise<{
        actionsApplied: any;
        batchCount: any;
        summary: string;
        total: any;
        trigger: any;
        durationMs: number;
        merged: number;
        deleted: number;
        errors: number;
    } | {
        skipped: boolean;
        reason: string;
        total: any;
        actions?: undefined;
        summary?: undefined;
    } | {
        actions: number;
        summary: string;
        total: any;
        skipped?: undefined;
        reason?: undefined;
    }>;
    /**
     * Check if consolidation should run and trigger if needed.
     * Called by MemoryExtractor after storing new memories.
     *
     * @param {object} params
     * @param {string} params.project - Project identifier
     * @param {string} [params.username] - Username for attribution
     * @param {function} [params.broadcast] - Optional broadcast callback for WebSocket notifications
     */
    checkAndRun({ project, username, broadcast, endpoint, agent, traceId, agentSessionId, }: any): Promise<void>;
    /**
     * Get consolidation run history for a project.
     *
     * @param {string} project - Project identifier
     * @param {number} [limit=10] - Max history entries to return
     * @returns {Promise<Array>} Consolidation history entries, newest first
     */
    getHistory(project: any, limit?: number): Promise<any>;
};
export default MemoryConsolidationService;
//# sourceMappingURL=MemoryConsolidationService.d.ts.map
/**
 * MemoryExtractor — extracts and stores memories from agentic conversations.
 *
 * Architecture: Single-store, CC-style.
 * - 4-type taxonomy: user, feedback, project, reference
 * - All memories stored in the unified `memories` collection via MemoryService
 * - Mutual exclusion: skips extraction when the main agent used upsert_memory
 * - Configurable extraction model via Settings → Memory Models
 *
 * Registered as an `afterResponse` hook in AgentHooks.
 * Runs in the background (fire-and-forget) after the final response.
 */
export default class MemoryExtractor {
    /**
     * Extract memories from a conversation and store in the unified memories collection.
     *
     * @param {object} params
     * @param {string} params.project - Project identifier
     * @param {string} params.username - Username
     * @param {Array} params.messages - Full conversation messages
     * @param {string} [params.traceId] - Session ID for attribution
     * @param {string} [params.conversationId] - Conversation ID for tracking
     * @param {Array} [params.toolCalls] - Tool calls from the current turn (for mutual exclusion)
     * @returns {Promise<Array>} Stored memory documents
     */
    static extractAndStore({ project, username, messages, traceId, agentSessionId, conversationId, endpoint, agent, toolCalls, emit, }: any): Promise<{
        type: any;
        id: any;
        title: any;
    }[]>;
    /**
     * Create an afterResponse hook handler for AgentHooks.
     * Runs as fire-and-forget (non-blocking).
     *
     * @returns {Function}
     */
    static createHook(): (ctx: any, { _text, messages, toolCalls }: any) => Promise<void>;
}
//# sourceMappingURL=MemoryExtractor.d.ts.map
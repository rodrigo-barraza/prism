/**
 * SystemPromptAssembler — sole owner of the agent's system prompt.
 *
 * Assembles identity, coding guidelines, tool descriptions, project
 * structure, environment info, and session memory into a single coherent
 * system message. Registered as a `beforePrompt` hook in AgentHooks.
 *
 * When an `agent` identifier is present in the request context, the
 * assembler loads the matching persona from AgentPersonaRegistry and
 * uses its identity, guidelines, tool policy, and capabilities instead
 * of the default coding agent sections.
 */
export default class SystemPromptAssembler {
    /**
     * @param {object} [options]
     * @param {string} [options.workspaceRoot] - Workspace root path
     */
    constructor(options?: {});
    /**
     * Fetch project directory tree from tools-api.
     * Cached for 1 minute to avoid hammering the API.
     *
     * @returns {Promise<string>} Formatted directory tree
     */
    fetchDirectoryTree(): Promise<any>;
    /**
     * Format directory listing into a readable tree string.
     * @param {object} data - Response from tools-api list endpoint
     * @returns {string}
     */
    _formatDirectoryTree(data: any): string;
    /**
     * Build domain-grouped tool descriptions from current schemas.
     *
     * Groups tools by their `domain` field, then for each tool shows:
     *   - Name + first sentence of description (capability summary)
     *   - Full parameter listing with required markers
     *
     * @param {Array} [enabledTools] - If provided, only include these tool names
     * @returns {string}
     */
    buildToolDescriptions(enabledTools: any): string;
    /**
     * Fetch relevant memories via embedding similarity search.
     * Queries the unified `memories` collection using cosine similarity,
     * scoped by agent and project.
     *
     * @param {string} agent - Agent identifier
     * @param {string} project - Project identifier
     * @param {string} queryText - Query for semantic search
     * @param {string} [traceId] - Session identifier
     * @param {string} [endpoint] - Request endpoint
     * @param {string} [username] - Username
     * @returns {Promise<string>} Formatted memory sections for the system prompt
     */
    fetchMemories(agent: any, project: any, queryText: any, { traceId, agentSessionId, endpoint, _username }?: {}): Promise<any>;
    /**
     * Fetch enabled skills relevant to the user's query via embedding similarity.
     *
     * @param {string} project - Project identifier
     * @param {string} username - Username
     * @param {string} queryText - The user's latest message (used for relevance matching)
     * @returns {Promise<Array<{ name: string, content: string, score: number }>>}
     */
    fetchSkills(project: any, username: any, queryText: any, { traceId, agentSessionId, endpoint, agent }?: {}): Promise<any>;
    /**
     * Assemble the complete agent system prompt.
     *
     * When `ctx.agent` is set, loads the matching persona from
     * AgentPersonaRegistry. Otherwise falls back to the CODING agent.
     *
     * Persona-aware sections:
     *   1. Agent identity (from persona or default)
     *   2. Agent context (runtime data from caller, e.g. Discord info)
     *   3. Tool policy (persona-specific tool use rules)
     *   4. Available tools (always injected — domain-grouped with parameters)
     *   5. Coding guidelines (CODING only)
     *   6. Environment info (date/time, OS, workspace)
     *   7. Project directory tree (CODING only)
     *   8. Project skills (relevance-filtered)
     *   9. Session memory from past conversations
     *
     * @param {object} ctx - Request context
     * @param {string} ctx.project - Project identifier
     * @param {string} ctx.username - Username
     * @param {string} [ctx.agent] - Agent identifier (e.g. "LUPOS", "CODING")
     * @param {object} [ctx.agentContext] - Runtime context from caller
     * @param {Array} ctx.messages - Current messages array
     * @param {Array} [ctx.enabledTools] - Enabled tool names
     * @returns {Promise<{ prompt: string, skillNames: string[] }>} Complete system prompt + skill names for UI emission
     */
    assemble(ctx: any): Promise<{
        prompt: string;
        skillNames: any[];
    }>;
    /**
     * Create a beforePrompt hook handler for AgentHooks.
     *
     * Replaces or creates the system message with the fully assembled prompt.
     * Any existing system message content from the client is ignored — the
     * backend is the single source of truth for the agent system prompt.
     *
     * @returns {Function}
     */
    createHook(): (ctx: any) => Promise<void>;
}
//# sourceMappingURL=SystemPromptAssembler.d.ts.map
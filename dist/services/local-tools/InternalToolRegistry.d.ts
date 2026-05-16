export default class InternalToolRegistry {
    /**
     * Check if a tool name is handled by the internal registry.
     * @param {string} name
     * @returns {boolean}
     */
    static has(name: any): boolean;
    /**
     * Execute an internal tool by name.
     * @param {string} name - Tool name
     * @param {object} args - Tool arguments (from LLM)
     * @param {object} ctx - Orchestrator context (emit, session, project, etc.)
     * @returns {Promise<object>}
     */
    static execute(name: any, args: any, ctx?: {}): Promise<any>;
    /**
     * Get all internal tool schemas (for LLM consumption — no endpoint metadata).
     * @returns {Array<object>}
     */
    static getSchemas(): any[];
    /**
     * Get all internal tool schemas with domain/labels (for client UI).
     * @returns {Array<object>}
     */
    static getClientSchemas(): any[];
    /**
     * Get the Set of all registered internal tool names.
     * Used by AgenticLoopService for bypass-filter logic.
     * @returns {Set<string>}
     */
    static getNames(): Set<any>;
}
//# sourceMappingURL=InternalToolRegistry.d.ts.map
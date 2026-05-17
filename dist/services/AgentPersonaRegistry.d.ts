declare const AgentPersonaRegistry: {
    /**
     * Get a persona by agent identifier.
     * @param {string} agentId - e.g. "LUPOS", "CODING"
     * @returns {AgentPersona|null}
     */
    get(agentId: any): any;
    /**
     * List all registered personas.
     * @returns {Array<{ id: string, name: string, custom?: boolean }>}
     */
    list(): {
        custom?: boolean;
        id: any;
        name: any;
        type: any;
    }[];
    /**
     * Check if a persona exists.
     * @param {string} agentId
     * @returns {boolean}
     */
    has(agentId: any): boolean;
    /**
     * Check if a project belongs to a registered agent.
     * @param {string} project
     * @returns {boolean}
     */
    isAgentProject(project: any): boolean;
    /**
     * Register a custom (user-defined) agent persona at runtime.
     * Converts a MongoDB document into a persona object compatible
     * with the built-in format, then inserts into the PERSONAS map.
     *
     * @param {object} doc - Custom agent document from CustomAgentService
     */
    registerCustom(doc: any): void;
    /**
     * Unregister a persona by agent ID (only custom agents should be removed).
     * @param {string} agentId
     */
    unregister(agentId: any): void;
    /**
     * Load all custom agents from the database and register them.
     * Called at startup and can be called to refresh after mutations.
     */
    loadCustomAgents(): Promise<void>;
};
export default AgentPersonaRegistry;
//# sourceMappingURL=AgentPersonaRegistry.d.ts.map
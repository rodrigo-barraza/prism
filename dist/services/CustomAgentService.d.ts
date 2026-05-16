declare const CustomAgentService: {
    /**
     * List all custom agents.
     * @returns {Promise<Array>}
     */
    list(): Promise<any>;
    /**
     * Get a single custom agent by MongoDB _id.
     * @param {string} id
     * @returns {Promise<object|null>}
     */
    get(id: any): Promise<any>;
    /**
     * Get a custom agent by its derived agentId.
     * @param {string} agentId - e.g. "CUSTOM_MY_AGENT"
     * @returns {Promise<object|null>}
     */
    getByAgentId(agentId: any): Promise<any>;
    /**
     * Create a new custom agent.
     * @param {object} data - { name, description?, project?, identity, guidelines?, toolPolicy?, enabledTools?, usesDirectoryTree?, usesCodingGuidelines? }
     * @returns {Promise<object>} The created document
     */
    create(data: any): Promise<{
        _id: any;
        name: any;
        agentId: string;
        type: any;
        description: any;
        project: any;
        icon: any;
        color: any;
        backgroundImage: any;
        identity: any;
        guidelines: any;
        toolPolicy: any;
        enabledTools: any;
        usesDirectoryTree: any;
        usesCodingGuidelines: any;
        createdAt: string;
        updatedAt: string;
    }>;
    /**
     * Update an existing custom agent.
     * @param {string} id - MongoDB _id
     * @param {object} updates - Partial fields to update
     * @returns {Promise<object>} The updated document
     */
    update(id: any, updates: any): Promise<any>;
    /**
     * Delete a custom agent.
     * @param {string} id - MongoDB _id
     * @returns {Promise<boolean>}
     */
    delete(id: any): Promise<boolean>;
};
export default CustomAgentService;
//# sourceMappingURL=CustomAgentService.d.ts.map
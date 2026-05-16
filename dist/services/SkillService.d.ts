declare const SkillService: {
    /**
     * Create a new skill.
     *
     * @param {object} data
     * @param {string} data.name - Unique skill name (e.g. "refactor_and_test")
     * @param {string} data.description - What the skill does
     * @param {string} data.prompt - Prompt template. Use {{variable}} for interpolation.
     * @param {string[]} [data.steps] - Ordered step descriptions (for documentation)
     * @param {string[]} [data.tools] - Tools to enable for the skill run (default: all)
     * @param {number} [data.maxIterations] - Max loop iterations (default: 25)
     * @param {string} [data.model] - Model override for the skill run
     * @param {string} [data.project] - Project scope
     * @param {string} [data.agent] - Agent persona override
     * @returns {Promise<object>}
     */
    create(data: any): Promise<{
        error: string;
        skill?: undefined;
        message?: undefined;
    } | {
        skill: any;
        message: string;
        error?: undefined;
    }>;
    /**
     * List all skills.
     * @param {object} [options]
     * @param {string} [options.project] - Filter by project
     * @param {number} [options.limit] - Max results
     * @returns {Promise<object>}
     */
    list({ project, limit }?: {
        limit?: number | undefined;
    }): Promise<{
        skills: any;
        total: any;
    }>;
    /**
     * Get a single skill by skillId.
     * @param {string} skillId
     * @returns {Promise<object|null>}
     */
    get(skillId: any): Promise<any>;
    /**
     * Delete a skill by skillId.
     * @param {string} skillId
     * @returns {Promise<object>}
     */
    delete(skillId: any): Promise<{
        error: string;
        deleted?: undefined;
        skillId?: undefined;
        name?: undefined;
    } | {
        deleted: boolean;
        skillId: any;
        name: any;
        error?: undefined;
    }>;
    /**
     * Execute a skill — interpolates variables, increments usage, and
     * returns the assembled prompt + config for the agentic loop.
     *
     * The caller (ToolOrchestratorService) is responsible for actually
     * running the agentic loop with the returned config.
     *
     * @param {string} skillId
     * @param {object} [variables] - Key-value pairs for {{variable}} interpolation
     * @returns {Promise<object>} { prompt, config } or { error }
     */
    prepare(skillId: any, variables?: {}): Promise<{
        error: string;
        skillId?: undefined;
        name?: undefined;
        prompt?: undefined;
        config?: undefined;
        unresolved?: undefined;
        steps?: undefined;
    } | {
        skillId: any;
        name: any;
        prompt: any;
        config: {
            maxIterations: any;
            model: any;
            tools: any;
            agent: any;
            project: any;
        };
        unresolved: unknown[] | undefined;
        steps: any;
        error?: undefined;
    }>;
};
export default SkillService;
//# sourceMappingURL=SkillService.d.ts.map
/**
 * Evaluate whether a model response matches the expected value.
 * @param {string} response   The raw model output
 * @param {string} expected   The expected value
 * @param {string} matchMode  One of: "contains", "exact", "startsWith", "regex"
 * @returns {boolean}
 */
declare function evaluate(response: any, expected: any, matchMode?: string): any;
/**
 * Get all listed conversation-type models grouped by provider.
 * Returns flat array of { provider, model, label }.
 */
declare function getConversationModels(): {
    provider: string;
    model: string;
    label: string;
}[];
declare const BenchmarkService: {
    MATCH_MODES: {
        CONTAINS: string;
        EXACT: string;
        STARTS_WITH: string;
        REGEX: string;
    };
    evaluate: typeof evaluate;
    getConversationModels: typeof getConversationModels;
    /** Number of benchmark model calls currently in-flight. */
    readonly activeGenerationCount: number;
    /**
     * Run a benchmark test against the specified models (or all available).
     * @param {Object}   benchmark   The benchmark definition document
     * @param {Array}    [modelTargets]  Optional array of { provider, model } to test
     * @param {string}   project
     * @param {string}   username
     * @returns {Object} The completed run document
     */
    runBenchmark(benchmark: any, modelTargets: any, project: any, username: any, { onRunStart, onModelStart, onModelComplete, onEvent, signal }?: {}): Promise<{
        id: `${string}-${string}-${string}-${string}-${string}`;
        benchmarkId: any;
        project: any;
        models: any[];
        aborted: any;
        summary: {
            total: number;
            passed: number;
            failed: number;
            errored: number;
            totalCost: any;
        };
        startedAt: string;
        completedAt: string;
    }>;
    create(data: any, project: any, username: any): Promise<{
        id: `${string}-${string}-${string}-${string}-${string}`;
        project: any;
        username: any;
        name: any;
        prompt: any;
        systemPrompt: any;
        expectedValue: any;
        matchMode: any;
        benchmarkMode: any;
        assertions: any;
        assertionOperator: any;
        agentAssertions: any;
        agentAssertionOperator: any;
        temperature: any;
        maxTokens: any;
        tags: any;
        createdAt: string;
        updatedAt: string;
    }>;
    list(project: any): Promise<any>;
    getById(id: any, project: any): Promise<any>;
    remove(id: any, project: any): Promise<void>;
    getRuns(benchmarkId: any, project: any): Promise<any>;
    getRunById(runId: any, project: any): Promise<any>;
    getLatestRun(benchmarkId: any, project: any): Promise<any>;
};
export default BenchmarkService;
//# sourceMappingURL=BenchmarkService.d.ts.map
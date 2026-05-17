/**
 * Build the coordinator system prompt addendum.
 *
 * @param {object} [options]
 * @param {string[]} [options.workerTools] - Tool names available to workers
 * @returns {string} System prompt section to append
 */
export declare function getCoordinatorPromptAddendum({ workerTools }?: {
    workerTools?: any[];
}): string;
/**
 * Get the list of tool names that workers should NOT have access to.
 * Workers cannot spawn sub-workers (prevents recursion).
 */
export declare const COORDINATOR_ONLY_TOOLS: string[];
//# sourceMappingURL=CoordinatorPrompt.d.ts.map
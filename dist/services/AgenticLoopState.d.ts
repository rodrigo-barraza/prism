/**
 * AgenticLoopState — encapsulates all mutable accumulated state
 * for an agentic loop execution.
 *
 * Harness implementations populate this during `run()` and the
 * finalization logic reads from it to persist and emit results.
 *
 * Separating state from logic makes it possible for different
 * harnesses to share finalization, progress emission, and DB
 * persistence code without inheritance coupling.
 */
export default class AgenticLoopState {
    constructor({ originalMessageCount, planModeActive }?: {
        originalMessageCount?: number;
        planModeActive?: boolean;
    });
    /**
     * Get clean display segments (trimmed, empty-filtered) for DB persistence.
     */
    getCleanDisplayData(): {
        cleanSegments: any[];
        cleanTextFragments: any[];
        cleanThinkingFragments: any[];
    };
}
//# sourceMappingURL=AgenticLoopState.d.ts.map
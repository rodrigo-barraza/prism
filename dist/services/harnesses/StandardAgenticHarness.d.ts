import BaseAgenticHarness from "./BaseAgenticHarness.js";
/**
 * StandardAgenticHarness — the default tool-use loop.
 *
 * Control flow:
 *   1. Stream LLM response
 *   2. If tool calls: execute → append results → loop
 *   3. If text only (and not plan mode): break → finalize
 *   4. Exhaustion recovery pass if iteration limit hit
 *
 * Supports:
 *   - Plan mode (planFirst / enter_plan_mode / exit_plan_mode)
 *   - Auto-approval engine
 *   - Coordinator (multi-agent) worker tracking
 *   - Streaming tool output (shell, python, js)
 */
export default class StandardAgenticHarness extends BaseAgenticHarness {
    static id: string;
    static label: string;
    static description: string;
    run(): Promise<{
        messages: any[];
    } | undefined>;
    _handleExitPlanMode(exitPlanTC: any, pass: any, results: any, currentMessages: any): Promise<boolean>;
    _runExhaustionPass(currentMessages: any): Promise<void>;
    _finalize(context: any, currentMessages: any, hooks: any): Promise<void>;
}
//# sourceMappingURL=StandardAgenticHarness.d.ts.map
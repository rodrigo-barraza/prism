/**
 * AgenticLoopService — public façade for agentic loop execution.
 *
 * Orchestrates:
 *   1. Tool resolution (AgenticToolResolver)
 *   2. State initialization (AgenticLoopState)
 *   3. Harness selection and instantiation (HarnessRegistry)
 *   4. Cleanup (approvals, questions, session tracking)
 *
 * Also exposes approval/question resolution APIs used by AgentRoutes.
 */
export default class AgenticLoopService {
    /**
     * Run an agentic loop using the specified (or default) harness.
     * @param {object} ctx — generation context from ChatRoutes.prepareGenerationContext
     * @returns {Promise<{ messages: object[] }>}
     */
    static runAgenticLoop(ctx: any): Promise<any>;
    /**
     * Resolve a pending approval for an agent session.
     * @param {string} agentSessionId
     * @param {boolean} approved
     * @returns {boolean} true if resolved
     */
    static resolveApproval(agentSessionId: any, approved: any, { approveAll }?: {
        approveAll?: boolean;
    }): boolean;
    /**
     * Check if an agent session has a pending approval.
     * @param {string} agentSessionId
     * @returns {{ pending: boolean, type?: string, tools?: string[] }}
     */
    static getPendingApproval(agentSessionId: any): {
        pending: boolean;
        type?: undefined;
        tools?: undefined;
    } | {
        pending: boolean;
        type: any;
        tools: any;
    };
    /**
     * Store a pending question resolver (called by ToolOrchestratorService).
     */
    static _setPendingQuestion(agentSessionId: any, entry: any): void;
    /**
     * Resolve a pending question for an agent session.
     * @param {string} agentSessionId
     * @param {Array<{ answer: string|string[], annotations?: string }>} answers
     * @returns {boolean} true if resolved
     */
    static resolveUserQuestion(agentSessionId: any, answers: any): boolean;
    /**
     * Check if an agent session has a pending question.
     * @param {string} agentSessionId
     * @returns {{ pending: boolean, question?: string, choices?: string[] }}
     */
    static getPendingQuestion(agentSessionId: any): {
        pending: boolean;
        question?: undefined;
        choices?: undefined;
    } | {
        pending: boolean;
        question: any;
        choices: any;
    };
    /**
     * List available harnesses for the settings UI.
     * @returns {Array<{ id: string, label: string, description: string }>}
     */
    static listHarnesses(): {
        id: any;
        label: any;
        description: any;
    }[];
}
//# sourceMappingURL=AgenticLoopService.d.ts.map
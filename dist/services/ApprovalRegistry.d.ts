/**
 * ApprovalRegistry — shared mutable state for pending tool/plan approvals
 * and user-question prompts during agentic loop execution.
 *
 * Lives in its own module to avoid circular imports between
 * AgenticLoopService (the public façade) and harness implementations.
 */
export declare const pendingApprovals: Map<any, any>;
export declare const pendingQuestions: Map<any, any>;
//# sourceMappingURL=ApprovalRegistry.d.ts.map
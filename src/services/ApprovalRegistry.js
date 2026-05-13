/**
 * ApprovalRegistry — shared mutable state for pending tool/plan approvals
 * and user-question prompts during agentic loop execution.
 *
 * Lives in its own module to avoid circular imports between
 * AgenticLoopService (the public façade) and harness implementations.
 */

// ── Approval Resolver Registry ─────────────────────────────
// Stores pending { resolve, type } objects keyed by agentSessionId.
// The HTTP endpoint resolves these when the client sends approval.
export const pendingApprovals = new Map();

// ── Question Resolver Registry ─────────────────────────────
// Stores pending { resolve, question, choices } objects keyed by agentSessionId.
// The HTTP endpoint resolves these when the user answers an ask_user_question.
export const pendingQuestions = new Map();

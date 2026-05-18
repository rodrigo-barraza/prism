import { pendingApprovals } from "../../ApprovalRegistry.ts";

/**
 * ApprovalGate — extracted approval gating logic.
 *
 * Handles the promise-based approval pattern: emit approval_required events,
 * register a pending approval resolver, wait for the user's response
 * (or timeout after 2 minutes), and return the decision.
 *
 * Reusable by any harness that executes write/danger-tier tools.
 */

const APPROVAL_TIMEOUT_MS = 120_000;

/**
 * Check a batch of tool calls against the approval engine and, if any
 * require approval, pause until the user responds or timeout occurs.
 *
 * @param toolCalls       — Array of pending tool calls
 * @param context         — Generation context (agentSessionId, emit, options)
 * @param approvalEngine  — AutoApprovalEngine instance
 * @returns {{ approved: boolean, approveAll: boolean }}
 */
export async function checkAndWaitForApproval(
  toolCalls: any[],
  context: any,
  approvalEngine: any,
): Promise<{ approved: boolean; approveAll: boolean }> {
  const { agentSessionId, emit, options } = context;

  const { needsApproval } = approvalEngine.checkBatch(toolCalls);

  if (needsApproval.length === 0 || options.autoApprove) {
    return { approved: true, approveAll: false };
  }

  // Emit approval_required events for each tool needing approval
  for (const toolCallRequiringApproval of needsApproval) {
    emit({
      type: "approval_required",
      toolCall: {
        name: toolCallRequiringApproval.name,
        args: toolCallRequiringApproval.args,
        id: toolCallRequiringApproval.id,
      },
      tier: toolCallRequiringApproval._approval.tier,
      tierLabel: toolCallRequiringApproval._approval.tierLabel,
    });
  }

  // Wait for user approval or timeout
  const approvalResult: any = await new Promise((resolve: any) => {
    const timeoutId = setTimeout(() => {
      pendingApprovals.delete(agentSessionId);
      resolve({ approved: false, reason: "timeout" });
    }, APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(agentSessionId, {
      resolve: (value: any) => {
        clearTimeout(timeoutId);
        pendingApprovals.delete(agentSessionId);
        resolve(value);
      },
      type: "tool",
      tools: needsApproval.map((toolCall: any) => toolCall.name),
    });
  });

  if (!approvalResult?.approved) {
    emit({
      type: "status",
      message: `Tool execution rejected: ${needsApproval.map((toolCall: any) => toolCall.name).join(", ")}`,
    });
    return { approved: false, approveAll: false };
  }

  if (approvalResult.approveAll) {
    return { approved: true, approveAll: true };
  }

  return { approved: true, approveAll: false };
}

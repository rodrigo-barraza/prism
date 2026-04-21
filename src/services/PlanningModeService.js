import logger from "../utils/logger.js";

/**
 * Planning instruction injected into the system message when planFirst=true.
 * Mirrors Claude Code's plan mode: the model explores and designs first,
 * then calls exit_plan_mode to present its plan for approval.
 */
const PLANNING_INSTRUCTION = `

## PLANNING MODE ACTIVE

You are currently in planning mode. In this mode:
1. You do NOT have access to any tools except exit_plan_mode and think.
2. Thoroughly explore the problem and design an implementation approach.
3. Consider multiple approaches and their trade-offs.
4. Write out your complete plan as text output.
5. When your plan is ready, call exit_plan_mode to present it for approval.

Your plan should follow this format:

### Plan: [Title]

**Goal**: [One-sentence description of what will be accomplished]

**Steps**:
1. [Step description] → [file(s) affected]
2. [Step description] → [file(s) affected]
3. ...

**Risks/Considerations**:
- [Any important caveats or risks]

**Estimated Scope**: [small/medium/large]

Remember: DO NOT attempt to use any tools yet. Write your plan as text, then call exit_plan_mode when ready.`;

/**
 * PlanningModeService — implements the "Plan First" workflow using
 * Claude Code's tool-based state machine pattern.
 *
 * When planFirst=true:
 * 1. Loop starts with planModeActive=true (tools stripped)
 * 2. Planning instruction injected into system prompt
 * 3. Model outputs plan text, then calls exit_plan_mode
 * 4. exit_plan_mode triggers plan_proposal + approval gate
 * 5. Approved plan echoed as tool result → model continues with full tools
 */
export default class PlanningModeService {
  /**
   * Inject the planning instruction into the system message.
   * Called once before the agentic loop starts when planFirst=true.
   *
   * @param {Array} messages - The message array (mutated in place)
   */
  static injectPlanningInstruction(messages) {
    const systemMsg = messages.find((m) => m.role === "system");
    if (systemMsg) {
      // Idempotency: don't append twice
      if (systemMsg.content.includes("## PLANNING MODE ACTIVE")) return;
      systemMsg.content = systemMsg.content + PLANNING_INSTRUCTION;
    } else {
      messages.unshift({ role: "system", content: PLANNING_INSTRUCTION.trim() });
    }

    logger.info("[PlanningMode] Injected planning instruction into system prompt");
  }

  /**
   * Strip the planning instruction from the system message.
   * Called when exiting plan mode so execution doesn't carry stale constraints.
   *
   * @param {Array} messages - The message array (mutated in place)
   */
  static stripPlanningInstruction(messages) {
    const systemMsg = messages.find((m) => m.role === "system");
    if (systemMsg && systemMsg.content.includes("## PLANNING MODE ACTIVE")) {
      systemMsg.content = systemMsg.content.replace(PLANNING_INSTRUCTION, "");
      logger.info("[PlanningMode] Stripped planning instruction from system prompt");
    }
  }

  /**
   * Extract step descriptions from a plan for progress tracking.
   *
   * @param {string} planText - The plan markdown text
   * @returns {Array<string>} Step descriptions
   */
  static extractSteps(planText) {
    const stepRegex = /^\d+\.\s+(.+)$/gm;
    const steps = [];
    let match;
    while ((match = stepRegex.exec(planText)) !== null) {
      steps.push(match[1].trim());
    }
    return steps;
  }
}

import logger from "../utils/logger.js";

/**
 * Planning-specific system prompt suffix.
 * Forces the model to output a structured plan without executing tools.
 */
const PLANNING_PROMPT = `

## PLANNING MODE ACTIVE

You are in planning mode. You must output ONLY a structured implementation plan.
Do NOT call any tools. Do NOT execute any code. Do NOT make any file modifications.

Your plan must follow this exact format:

### Plan: [Title]

**Goal**: [One-sentence description of what will be accomplished]

**Steps**:
1. [Step description] → [file(s) affected]
2. [Step description] → [file(s) affected]
3. ...

**Risks/Considerations**:
- [Any important caveats or risks]

**Estimated Scope**: [small/medium/large]

Output ONLY the plan. The user will review and approve it before execution begins.`;

/**
 * PlanningModeService — implements the "Plan First" workflow.
 *
 * When planFirst=true:
 * 1. First LLM call uses planning prompt, tools stripped
 * 2. Plan emitted as plan_proposal event
 * 3. Waits for plan_approved/plan_rejected
 * 4. If approved, injects plan as context and runs normal agentic loop
 */
export default class PlanningModeService {
  /**
   * Inject the planning prompt into the system message and strip tools.
   *
   * @param {object} ctx - Agentic loop context
   * @param {object} options - Pass options (will have tools removed)
   * @returns {{ planningMessages: Array, planningOptions: object }}
   */
  static preparePlanningPass(ctx, options) {
    const planningMessages = [...ctx.messages];

    // Append planning instruction to the system prompt
    const systemMsg = planningMessages.find((m) => m.role === "system");
    if (systemMsg) {
      systemMsg.content = systemMsg.content + PLANNING_PROMPT;
    } else {
      planningMessages.unshift({ role: "system", content: PLANNING_PROMPT.trim() });
    }

    // Strip tools entirely — no tool execution during planning
    const planningOptions = { ...options };
    delete planningOptions.tools;
    delete planningOptions.enabledTools;
    delete planningOptions.functionCallingEnabled;

    logger.info("[PlanningMode] Prepared planning pass — tools stripped, planning prompt injected");

    return { planningMessages, planningOptions };
  }

  /**
   * Build the execution context after a plan is approved.
   * Injects the approved plan as context for the execution pass.
   *
   * @param {Array} originalMessages - Original messages before planning
   * @param {string} planText - The approved plan text
   * @returns {Array} Messages with plan context injected
   */
  static buildExecutionMessages(originalMessages, planText) {
    const messages = [...originalMessages];

    // Add the plan as an assistant message followed by a user approval
    messages.push({
      role: "assistant",
      content: planText,
    });
    messages.push({
      role: "user",
      content: "The plan above has been approved. Execute it step by step, using tools as needed. Report progress after each step.",
    });

    logger.info("[PlanningMode] Built execution messages — plan injected as context");

    return messages;
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

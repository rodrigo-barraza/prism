import logger from "../utils/logger.js";

/**
 * Tool approval tiers — deterministic, rule-based permission system.
 *
 * Tier 1 (AUTO):    Read-only tools, always execute without prompting.
 * Tier 2 (WRITE):   Write tools, auto-approve in "Full Auto" mode, otherwise prompt.
 * Tier 3 (DANGER):  Destructive / arbitrary execution, always prompt unless Full Auto.
 */
export const APPROVAL_TIERS = {
  AUTO: 1,
  WRITE: 2,
  DANGER: 3,
};

/** Default tier assignments for built-in tools */
const DEFAULT_TIER_MAP = {
  // Tier 1 — read-only
  read_file: APPROVAL_TIERS.AUTO,
  list_directory: APPROVAL_TIERS.AUTO,
  grep_search: APPROVAL_TIERS.AUTO,
  glob_files: APPROVAL_TIERS.AUTO,
  web_search: APPROVAL_TIERS.AUTO,
  fetch_url: APPROVAL_TIERS.AUTO,
  multi_file_read: APPROVAL_TIERS.AUTO,
  file_info: APPROVAL_TIERS.AUTO,
  file_diff: APPROVAL_TIERS.AUTO,
  git_status: APPROVAL_TIERS.AUTO,
  git_diff: APPROVAL_TIERS.AUTO,
  git_log: APPROVAL_TIERS.AUTO,
  project_summary: APPROVAL_TIERS.AUTO,

  // Tier 1 — task management (agent's own scratchpad, not user files)
  task_create: APPROVAL_TIERS.AUTO,
  task_get: APPROVAL_TIERS.AUTO,
  task_list: APPROVAL_TIERS.AUTO,
  task_update: APPROVAL_TIERS.AUTO,

  // Tier 1 — coordinator orchestration
  spawn_agent: APPROVAL_TIERS.AUTO,
  send_message: APPROVAL_TIERS.AUTO,
  stop_agent: APPROVAL_TIERS.AUTO,

  // Tier 1 — memory management (non-destructive upsert)
  upsert_memory: APPROVAL_TIERS.AUTO,

  // Tier 2 — write operations
  write_file: APPROVAL_TIERS.WRITE,
  str_replace_file: APPROVAL_TIERS.WRITE,
  patch_file: APPROVAL_TIERS.WRITE,
  move_file: APPROVAL_TIERS.WRITE,
  delete_file: APPROVAL_TIERS.WRITE,
  browser_action: APPROVAL_TIERS.WRITE,

  // Tier 3 — destructive / arbitrary execution
  execute_shell: APPROVAL_TIERS.DANGER,
  execute_python: APPROVAL_TIERS.DANGER,
  execute_javascript: APPROVAL_TIERS.DANGER,
  run_command: APPROVAL_TIERS.DANGER,
};

const TIER_LABELS = {
  [APPROVAL_TIERS.AUTO]: "auto",
  [APPROVAL_TIERS.WRITE]: "write",
  [APPROVAL_TIERS.DANGER]: "danger",
};

/**
 * AutoApprovalEngine — determines whether a tool call should auto-execute
 * or require user approval.
 *
 * Registered as a `beforeToolCall` hook in AgentHooks.
 */
export default class AutoApprovalEngine {
  /**
   * @param {object} [options]
   * @param {boolean} [options.fullAuto=false] - When true, all tools auto-execute
   * @param {object} [options.tierOverrides] - Per-tool tier overrides { toolName: tier }
   */
  constructor(options = {}) {
    this.fullAuto = options.fullAuto || false;
    this.tierOverrides = options.tierOverrides || {};
  }

  /**
   * Get the approval tier for a tool.
   * @param {string} toolName
   * @returns {number} Tier constant (1, 2, or 3)
   */
  getTier(toolName) {
    if (this.tierOverrides[toolName] !== undefined) {
      return this.tierOverrides[toolName];
    }
    return DEFAULT_TIER_MAP[toolName] ?? APPROVAL_TIERS.WRITE; // Unknown tools default to Tier 2
  }

  /**
   * Get the tier label for a tool.
   * @param {string} toolName
   * @returns {string}
   */
  getTierLabel(toolName) {
    return TIER_LABELS[this.getTier(toolName)] || "write";
  }

  /**
   * Check whether a tool call should auto-execute.
   *
   * @param {object} toolCall - { name, args, id }
   * @returns {{ approved: boolean, tier: number, tierLabel: string, reason: string }}
   */
  check(toolCall) {
    const tier = this.getTier(toolCall.name);
    const tierLabel = TIER_LABELS[tier] || "write";

    // Full Auto mode: everything runs
    if (this.fullAuto) {
      return { approved: true, tier, tierLabel, reason: "full_auto" };
    }

    // Tier 1: always auto-approve
    if (tier === APPROVAL_TIERS.AUTO) {
      return { approved: true, tier, tierLabel, reason: "read_only" };
    }

    // Tier 2 and 3: require approval
    return { approved: false, tier, tierLabel, reason: "requires_approval" };
  }

  /**
   * Check a batch of tool calls. Returns the ones needing approval.
   *
   * @param {Array<object>} toolCalls - Array of { name, args, id }
   * @returns {{ autoApproved: Array, needsApproval: Array }}
   */
  checkBatch(toolCalls) {
    const autoApproved = [];
    const needsApproval = [];

    for (const tc of toolCalls) {
      const result = this.check(tc);
      if (result.approved) {
        autoApproved.push({ ...tc, _approval: result });
      } else {
        needsApproval.push({ ...tc, _approval: result });
      }
    }

    if (needsApproval.length > 0) {
      logger.info(
        `[AutoApproval] ${autoApproved.length} auto-approved, ${needsApproval.length} need approval: ${needsApproval.map((t) => t.name).join(", ")}`,
      );
    }

    return { autoApproved, needsApproval };
  }

  /**
   * Create a beforeToolCall hook handler for AgentHooks.
   * @returns {Function}
   */
  createHook() {
    return async (toolCall, _ctx) => {
      return this.check(toolCall);
    };
  }
}

import logger from "../../utils/logger.js";

// ────────────────────────────────────────────────────────────
// Internal Tool Registry
// ────────────────────────────────────────────────────────────
// Provides a unified interface for tools that MUST execute within
// Prism's process because they mutate orchestrator state (plan mode,
// worktrees, approval gates, etc.).
//
// Each tool module exports: { name, schema, domain, labels, execute }
// The registry auto-imports everything in this directory on init().
// ────────────────────────────────────────────────────────────

/** @type {Map<string, { schema: object, domain: string, labels: string[], execute: Function }>} */
const registry = new Map();

/**
 * Register a tool with the internal registry.
 * @param {object} tool - Tool module default export
 */
function register(tool) {
  if (!tool.name || !tool.execute) {
    logger.warn(`[InternalToolRegistry] Skipping invalid tool: missing name or execute`);
    return;
  }
  registry.set(tool.name, tool);
}

/**
 * Initialize the registry by importing all tool modules in this directory.
 * Called once at module load — non-blocking.
 */
async function init() {
  const modules = await Promise.all([
    import("./EnterPlanModeTool.js"),
    import("./ExitPlanModeTool.js"),
    import("./SkillTools.js"),
    import("./WorktreeTools.js"),
    import("./TodoWriteTool.js"),
    import("./BriefTool.js"),
    import("./AskUserQuestionTool.js"),
    import("./McpTools.js"),
  ]);

  for (const mod of modules) {
    const tools = mod.default;
    // Modules can export a single tool or an array of tools
    if (Array.isArray(tools)) {
      for (const tool of tools) register(tool);
    } else {
      register(tools);
    }
  }

  logger.info(
    `[InternalToolRegistry] Registered ${registry.size} internal tools: [${[...registry.keys()].join(", ")}]`,
  );
}

// Kick off registration at module load
init().catch((err) =>
  logger.error(`[InternalToolRegistry] Init failed: ${err.message}`),
);

export default class InternalToolRegistry {
  /**
   * Check if a tool name is handled by the internal registry.
   * @param {string} name
   * @returns {boolean}
   */
  static has(name) {
    return registry.has(name);
  }

  /**
   * Execute an internal tool by name.
   * @param {string} name - Tool name
   * @param {object} args - Tool arguments (from LLM)
   * @param {object} ctx - Orchestrator context (emit, session, project, etc.)
   * @returns {Promise<object>}
   */
  static async execute(name, args, ctx = {}) {
    const tool = registry.get(name);
    if (!tool) {
      return { error: `Unknown internal tool: ${name}` };
    }
    return tool.execute(args, ctx);
  }

  /**
   * Get all internal tool schemas (for LLM consumption — no endpoint metadata).
   * @returns {Array<object>}
   */
  static getSchemas() {
    return [...registry.values()].map((t) => t.schema);
  }

  /**
   * Get all internal tool schemas with domain/labels (for client UI).
   * @returns {Array<object>}
   */
  static getClientSchemas() {
    return [...registry.values()].map((t) => ({
      ...t.schema,
      domain: t.domain || "Reasoning",
      labels: t.labels || ["coding"],
    }));
  }

  /**
   * Get the Set of all registered internal tool names.
   * Used by AgenticLoopService for bypass-filter logic.
   * @returns {Set<string>}
   */
  static getNames() {
    return new Set(registry.keys());
  }
}

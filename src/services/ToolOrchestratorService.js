import { TOOLS_SERVICE_URL } from "../../secrets.js";
import MCPClientService from "./MCPClientService.js";
import logger from "../utils/logger.js";
import { COORDINATOR_ONLY_TOOLS } from "./CoordinatorPrompt.js";
import { createAbortController } from "../utils/AbortController.js";
import InternalToolRegistry from "./local-tools/InternalToolRegistry.js";

// ────────────────────────────────────────────────────────────
// Schema Cache — fetched from tools-api at startup
// ────────────────────────────────────────────────────────────

/** @type {Array} Full tool schemas (with endpoint metadata) */
let cachedSchemas = [];

/** @type {Array} Clean schemas for LLM (without endpoint metadata) */
let cachedAISchemas = [];

/** @type {Array} Client-facing schemas (with domain/dataSource/labels, without endpoint) */
let cachedClientSchemas = [];

/** @type {Map<string, object>} Tool name → full schema (for routing) */
const toolMap = new Map();

/** @type {string[]} Allowed workspace root paths (fetched from tools-api) */
let cachedWorkspaceRoots = [];

/** @type {string[]} Static roots from secrets.js (immutable, for "pinned" UI) */
let cachedStaticRoots = [];

/** @type {boolean} Whether initial fetch has completed */
let initialized = false;

/**
 * Active worktree sessions — keyed by agentSessionId.
 * When the main agent calls enter_worktree, its session's workspace root
 * is redirected to the worktree path. All file/git/shell tool calls
 * then operate in the worktree until exit_worktree is called.
 *
 * @type {Map<string, { originalRoot: string, worktreePath: string, branchName: string, repoPath: string }>}
 */
const activeWorktrees = new Map();

/**
 * Fetch tool schemas from tools-api and populate caches.
 * Called eagerly at module load — non-blocking, graceful fallback.
 */
async function fetchSchemas() {
  try {
    const controller = createAbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`${TOOLS_SERVICE_URL}/admin/tool-schemas`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      logger.warn(
        `[ToolOrchestrator] Failed to fetch tool schemas: ${res.status} ${res.statusText}`,
      );
      return;
    }

    const schemas = await res.json();

    if (!Array.isArray(schemas) || schemas.length === 0) {
      logger.warn("[ToolOrchestrator] Tool schemas response was empty or invalid");
      return;
    }

    cachedSchemas = schemas;

    // Client-facing schemas: keep domain/dataSource/labels for UI grouping, strip only endpoint
    cachedClientSchemas = schemas.map(
      ({ endpoint: _e, ...rest }) => rest,
    );

    // Strip endpoint, dataSource, domain, and labels metadata for LLM consumption
    cachedAISchemas = schemas.map(
      ({ endpoint: _e, dataSource: _ds, domain: _d, labels: _l, ...rest }) => rest,
    );

    // Build lookup map for executor
    toolMap.clear();
    for (const schema of schemas) {
      toolMap.set(schema.name, schema);
    }

    initialized = true;

    logger.info(
      `[ToolOrchestrator] Loaded ${schemas.length} tool schemas from tools-api`,
    );

    // Fetch workspace config from tools-api (single source of truth)
    try {
      const configRes = await fetch(`${TOOLS_SERVICE_URL}/admin/config`, {
        signal: AbortSignal.timeout(3000),
      });
      if (configRes.ok) {
        const config = await configRes.json();
        if (Array.isArray(config.workspaceRoots)) {
          cachedWorkspaceRoots = config.workspaceRoots;
          logger.info(
            `[ToolOrchestrator] Workspace roots: ${cachedWorkspaceRoots.join(", ")}`,
          );
        }
        if (Array.isArray(config.staticRoots)) {
          cachedStaticRoots = config.staticRoots;
        }
      }
    } catch (cfgErr) {
      logger.warn(`[ToolOrchestrator] Could not fetch workspace config: ${cfgErr.message}`);
    }
  } catch (err) {
    logger.warn(
      `[ToolOrchestrator] Could not reach tools-api for schemas: ${err.message}`,
    );
  }
}

// Kick off schema fetch immediately at module load
fetchSchemas();

// ────────────────────────────────────────────────────────────
// Generic URL Builder — uses endpoint metadata
// ────────────────────────────────────────────────────────────

function buildUrlFromEndpoint(endpoint, args = {}) {
  let path = endpoint.path;
  if (endpoint.conditionalPath) {
    const { param, template } = endpoint.conditionalPath;
    if (args[param]) {
      path = template;
    }
  }

  const pathParams = new Set(endpoint.pathParams || []);
  for (const param of pathParams) {
    if (args[param] !== undefined && args[param] !== null) {
      path = path.replace(`:${param}`, encodeURIComponent(String(args[param])));
    }
  }

  const params = new URLSearchParams();

  const queryParams = endpoint.queryParams || [];
  for (const key of queryParams) {
    const value = args[key];
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, value);
    }
  }

  if (args.fields) {
    const fieldsStr = Array.isArray(args.fields)
      ? args.fields.join(",")
      : args.fields;
    params.set("fields", fieldsStr);
  }

  const qs = params.toString();
  return `${TOOLS_SERVICE_URL}${path}${qs ? `?${qs}` : ""}`;
}

const ARG_REMAPS = {
  search_events: { query: "q" },
  search_products: { query: "q" },
};




async function executeToolGeneric(name, args = {}, ctx = {}) {
  const schema = toolMap.get(name);
  if (!schema || !schema.endpoint) {
    return { error: `Unknown tool: ${name}` };
  }

  const remaps = ARG_REMAPS[name];
  let resolvedArgs = args;
  if (remaps) {
    resolvedArgs = { ...args };
    for (const [from, to] of Object.entries(remaps)) {
      if (resolvedArgs[from] !== undefined) {
        resolvedArgs[to] = resolvedArgs[from];
        delete resolvedArgs[from];
      }
    }
  }

  // Build caller-context headers for tools-api telemetry
  const contextHeaders = buildContextHeaders(ctx);

  // POST-method tools send args as JSON body
  if (schema.endpoint.method === "POST") {
    const url = `${TOOLS_SERVICE_URL}${schema.endpoint.path}`;
    // Inject trusted session context into body — the model's args never
    // include these fields (they're stripped from schemas), so they can
    // only come from the orchestrator's session context.
    const body = { ...resolvedArgs };
    if (ctx.project) body.project = ctx.project;
    if (ctx.agent) body.agent = ctx.agent;
    if (ctx.username) body.username = ctx.username;

    // Worktree path rewriting — redirect file paths to the worktree directory
    // when the session has an active worktree.
    if (ctx.agentSessionId && activeWorktrees.has(ctx.agentSessionId)) {
      const wt = activeWorktrees.get(ctx.agentSessionId);
      const rewritePath = (p) => {
        if (typeof p !== "string") return p;
        if (p.startsWith(wt.originalRoot)) {
          return wt.worktreePath + p.slice(wt.originalRoot.length);
        }
        return p;
      };

      // Rewrite common path fields used by file/git/shell tools
      if (body.path) body.path = rewritePath(body.path);
      if (body.filePath) body.filePath = rewritePath(body.filePath);
      if (body.oldPath) body.oldPath = rewritePath(body.oldPath);
      if (body.newPath) body.newPath = rewritePath(body.newPath);
      if (body.cwd) body.cwd = rewritePath(body.cwd);
      if (body.directory) body.directory = rewritePath(body.directory);

      // Inject workspace override header so tools-api sandbox validation passes
      contextHeaders["X-Workspace-Override"] = wt.worktreePath;
    }

    return fetchJsonPost(url, body, contextHeaders, ctx.signal);
  }

  const url = buildUrlFromEndpoint(schema.endpoint, resolvedArgs);
  return fetchJson(url, contextHeaders, ctx.signal);
}

/**
 * Build X-context headers from the caller context object.
 * These are consumed by tools-api's ToolCallLoggerMiddleware.
 * @param {object} ctx - Caller context
 * @returns {object} Headers object
 */
function buildContextHeaders(ctx = {}) {
  const headers = {};
  if (ctx.project) headers["X-Project"] = ctx.project;
  if (ctx.username) headers["X-Username"] = ctx.username;
  if (ctx.agent) headers["X-Agent"] = ctx.agent;
  if (ctx.requestId) headers["X-Request-Id"] = ctx.requestId;
  if (ctx.traceId) headers["X-Trace-Id"] = ctx.traceId;
  if (ctx.agentSessionId) headers["X-Agent-Session-Id"] = ctx.agentSessionId;
  if (ctx.iteration !== undefined && ctx.iteration !== null) headers["X-Iteration"] = String(ctx.iteration);
  // Multi-workspace: when the user has selected a non-default workspace root,
  // send it to tools-api so file/git/shell tools resolve within it.
  if (ctx.workspaceRoot) headers["X-Workspace-Root"] = ctx.workspaceRoot;
  return headers;
}

async function fetchJson(url, extraHeaders = {}, signal) {
  try {
    const res = await fetch(url, {
      headers: { ...extraHeaders },
      ...(signal && { signal }),
    });
    if (!res.ok) {
      try {
        const errBody = await res.json();
        return { error: errBody.error || `API returned ${res.status}: ${res.statusText}` };
      } catch {
        return { error: `API returned ${res.status}: ${res.statusText}` };
      }
    }
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") {
      return { error: "Tool execution aborted" };
    }
    return { error: `Failed to reach API: ${err.message}` };
  }
}

async function fetchJsonPost(url, body, extraHeaders = {}, signal) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
      ...(signal && { signal }),
    });
    if (!res.ok) {
      // Forward the actual error body from tools-api for debugging
      try {
        const errBody = await res.json();
        return { error: errBody.error || `API returned ${res.status}: ${res.statusText}` };
      } catch {
        return { error: `API returned ${res.status}: ${res.statusText}` };
      }
    }
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") {
      return { error: "Tool execution aborted" };
    }
    return { error: `Failed to reach API: ${err.message}` };
  }
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────


// ────────────────────────────────────────────────────────────
// Coordinator Tool Schemas — Prism-local, not routed to tools-api
// ────────────────────────────────────────────────────────────

const COORDINATOR_TOOL_SCHEMAS = [
  {
    name: "team_create",
    description:
      "Spawn one or more worker agents that execute in parallel, each in an isolated git worktree. " +
      "Workers have access to the full tool suite (read, write, search, shell). " +
      "Use for parallelizable research, implementation, or verification tasks. " +
      "For a single task, provide one member. For parallel work, provide up to 10 members in a single call. " +
      "Returns results from all members when they all complete.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Team name for identification (e.g. 'auth_refactor', 'research').",
        },
        members: {
          type: "array",
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              description: { type: "string", description: "Short label for this worker (shown in UI)." },
              prompt: { type: "string", description: "Self-contained task prompt. Include file paths, line numbers, and exact instructions. Workers cannot see the coordinator's conversation." },
              files: { type: "array", items: { type: "string" }, description: "Optional: file paths the worker should focus on." },
              model: { type: "string", description: "Optional: model override for this worker (defaults to coordinator's model)." },
            },
            required: ["description", "prompt"],
          },
          description: "Array of worker definitions (max 10). Each member runs autonomously in its own worktree.",
        },
      },
      required: ["name", "members"],
    },
  },
  {
    name: "send_message",
    description: "Send a follow-up message to a running or completed worker agent. Use to continue work, provide corrections, or give new instructions.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Agent ID returned by team_create" },
        message: { type: "string", description: "Follow-up instructions for the worker" },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "stop_agent",
    description: "Stop a running worker agent. The worker's worktree is cleaned up.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID to stop" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "task_output",
    description:
      "Read the output from a previously spawned worker agent by its agent ID. " +
      "Use this to check on a worker's result after it has completed, or to read " +
      "partial output from a still-running worker. Returns the worker's final text, " +
      "tool usage stats, diff summary, and status.",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "The agent ID returned by team_create.",
        },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "team_delete",
    description:
      "Stop and remove all workers in a named team. Cleans up worktrees for all members.",
    parameters: {
      type: "object",
      properties: {
        teamName: {
          type: "string",
          description: "The team name to delete (as provided to team_create).",
        },
      },
      required: ["teamName"],
    },
  },
];

export default class ToolOrchestratorService {
  /** AI-clean schemas (no endpoint/domain/dataSource/labels) — for LLM tool arrays */
  static getToolSchemas() {
    return [...cachedAISchemas, ...InternalToolRegistry.getSchemas(), ...COORDINATOR_TOOL_SCHEMAS];
  }

  /** Client-facing schemas (with domain/dataSource/labels, no endpoint) — for Prism Client UI */
  static getClientToolSchemas() {
    // Coordinator tools are Prism-local — add domain metadata for UI grouping
    const coordinatorClient = COORDINATOR_TOOL_SCHEMAS.map((t) => ({
      ...t,
      domain: "Coordinator",
      labels: ["coding", "orchestration"],
    }));
    return [...cachedClientSchemas, ...InternalToolRegistry.getClientSchemas(), ...coordinatorClient];
  }

  /** Workspace root paths from tools-api (single source of truth) */
  static getWorkspaceRoots() {
    return cachedWorkspaceRoots;
  }

  /** Primary workspace root (first entry) */
  static getWorkspaceRoot() {
    return cachedWorkspaceRoots[0] || null;
  }

  /** Static roots from secrets.js (immutable, for "pinned" UI distinction) */
  static getStaticRoots() {
    return [...cachedStaticRoots];
  }

  /** Re-fetch workspace roots from tools-api config */
  static async refreshWorkspaceRoots() {
    try {
      const configRes = await fetch(`${TOOLS_SERVICE_URL}/admin/config`, {
        signal: AbortSignal.timeout(3000),
      });
      if (configRes.ok) {
        const config = await configRes.json();
        if (Array.isArray(config.workspaceRoots)) {
          cachedWorkspaceRoots = config.workspaceRoots;
        }
        if (Array.isArray(config.staticRoots)) {
          cachedStaticRoots = config.staticRoots;
        }
      }
    } catch (err) {
      logger.warn(`[ToolOrchestrator] refreshWorkspaceRoots failed: ${err.message}`);
    }
  }

  /**
   * Update user-configured workspace roots via tools-api.
   * @param {string[]} roots - New user roots to persist
   * @returns {Promise<object>}
   */
  static async updateWorkspaceRoots(roots) {
    const res = await fetch(`${TOOLS_SERVICE_URL}/admin/config/workspaces`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roots }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Failed to update workspace roots");

    // Refresh local cache
    if (Array.isArray(result.workspaceRoots)) {
      cachedWorkspaceRoots = result.workspaceRoots;
    }
    if (Array.isArray(result.staticRoots)) {
      cachedStaticRoots = result.staticRoots;
    }
    return result;
  }

  /**
   * Validate a single workspace path via tools-api.
   * @param {string} path - Path to validate
   * @returns {Promise<object>}
   */
  static async validateWorkspacePath(path) {
    const res = await fetch(`${TOOLS_SERVICE_URL}/admin/config/workspaces/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
      signal: AbortSignal.timeout(5000),
    });
    return res.json();
  }

  /**
   * Get the effective workspace root for a session.
   * Returns the worktree path if the session is in an isolated worktree,
   * or the normal workspace root otherwise.
   * @param {string} [agentSessionId]
   * @returns {string|null}
   */
  static getEffectiveWorkspaceRoot(agentSessionId) {
    if (agentSessionId && activeWorktrees.has(agentSessionId)) {
      return activeWorktrees.get(agentSessionId).worktreePath;
    }
    return cachedWorkspaceRoots[0] || null;
  }

  /**
   * Get the active worktree state for a session, if any.
   * @param {string} agentSessionId
   * @returns {{ worktreePath: string, branchName: string, originalRoot: string }|null}
   */
  static getWorktreeState(agentSessionId) {
    return activeWorktrees.get(agentSessionId) || null;
  }

  static getToolFields(toolName) {
    const tool = cachedAISchemas.find((t) => t.name === toolName);
    if (!tool) return null;
    return tool.parameters?.properties?.fields?.items?.enum || null;
  }

  static async checkApiHealth() {
    const toolNames = cachedSchemas.map((t) => t.name);

    let online = false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${TOOLS_SERVICE_URL}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      online = res.ok;
    } catch {
      online = false;
    }

    const apiStatus = { [TOOLS_SERVICE_URL]: online };

    const offline = new Set();
    if (!online) {
      for (const name of toolNames) {
        offline.add(name);
      }
    }

    return { offline, apiStatus };
  }

  static async refreshSchemas() {
    await fetchSchemas();
    return cachedSchemas.length;
  }

  static isInitialized() {
    return initialized;
  }

  static async executeTool(name, args = {}, ctx = {}) {
    // ── Internal tools — delegated to InternalToolRegistry ──────
    if (InternalToolRegistry.has(name)) {
      return InternalToolRegistry.execute(name, args, ctx);
    }

    // Route coordinator tools to CoordinatorService (Prism-local)
    if (COORDINATOR_ONLY_TOOLS.includes(name)) {
      return ToolOrchestratorService.executeCoordinatorTool(name, args, ctx);
    }

    // Route MCP tools to MCPClientService
    if (MCPClientService.isMCPTool(name)) {
      return ToolOrchestratorService.executeMCPTool(name, args);
    }

    // Inject reference images from conversation context into generate_image args.
    // The tools-api endpoint needs these as explicit args since it doesn't have
    // access to Prism's conversation messages.
    // IMPORTANT: Only extract from the LAST user message to avoid collecting
    // stale images from conversation history.
    if (name === "generate_image" && ctx.messages) {
      const referenceImages = [];
      // Find the last user message with images
      for (let i = ctx.messages.length - 1; i >= 0; i--) {
        const msg = ctx.messages[i];
        if (msg.role === "user" && msg.images && Array.isArray(msg.images) && msg.images.length > 0) {
          logger.info(`[ToolOrchestrator] generate_image: found ${msg.images.length} image(s) on last user message`);
          for (const img of msg.images) {
            if (typeof img === "string" && (img.startsWith("http://") || img.startsWith("https://"))) {
              referenceImages.push(img);
              logger.info(`[ToolOrchestrator] generate_image: accepted HTTP image ref (${img.substring(0, 80)}...)`);
            } else if (typeof img === "string" && img.startsWith("data:")) {
              // Accept base64 data URLs — the /creative route supports up to 50MB bodies.
              // Discord avatars and user-attached images are typically well under 5MB.
              referenceImages.push(img);
              logger.info(`[ToolOrchestrator] generate_image: accepted base64 data URL (${(img.length / 1024).toFixed(0)} KB)`);
            } else {
              logger.warn(`[ToolOrchestrator] generate_image: REJECTED image ref (type=${typeof img}, prefix=${String(img).substring(0, 30)})`);
            }
          }
          break; // Only check the last user message
        }
      }
      if (referenceImages.length > 0) {
        args = { ...args, referenceImages };
        logger.info(`[ToolOrchestrator] generate_image: injecting ${referenceImages.length} reference image(s) into tool args`);
      } else {
        logger.info(`[ToolOrchestrator] generate_image: no reference images found in conversation`);
      }
    }

    const result = await executeToolGeneric(name, args, ctx);

    // Post-process: upload generated images to MinIO
    if (name === "generate_image" && result.image?.data && !result.error) {
      try {
        const FileService = (await import("./FileService.js")).default;
        const dataUrl = `data:${result.image.mimeType || "image/png"};base64,${result.image.data}`;
        const { ref } = await FileService.uploadFile(dataUrl, "generations", ctx.project, ctx.username);
        result.image.minioRef = ref;
      } catch (err) {
        logger.warn(`[ToolOrchestrator] Image MinIO upload failed: ${err.message}`);
      }
    }

    // Post-process: upload browser screenshots to MinIO
    if (name === "browser_action" && result.screenshot && !result.error) {
      try {
        const FileService = (await import("./FileService.js")).default;
        const dataUrl = `data:${result.mimeType || "image/png"};base64,${result.screenshot}`;
        const { ref } = await FileService.uploadFile(dataUrl, "screenshots", ctx.project, ctx.username);
        result.screenshotRef = ref;
        delete result.screenshot; // Don't send base64 downstream
      } catch (err) {
        logger.warn(`[ToolOrchestrator] Screenshot MinIO upload failed: ${err.message}`);
        // Keep base64 as fallback if MinIO fails
      }
    }

    return result;
  }

  /**
   * Execute a coordinator tool (team_create, send_message, stop_agent).
   * These are Prism-local — they dispatch to CoordinatorService in-process.
   *
   * @param {string} name - Tool name
   * @param {object} args - Tool arguments
   * @param {object} ctx - Caller context (carries coordinatorCtx for message injection)
   * @returns {Promise<object>}
   */
  static async executeCoordinatorTool(name, args = {}, ctx = {}) {
    const { default: CoordinatorService } = await import("./CoordinatorService.js");

    // Build coordinatorCtx from the loop's context
    const coordinatorCtx = {
      project: ctx.project,
      username: ctx.username,
      agent: ctx.agent,
      providerName: ctx._providerName,
      resolvedModel: ctx._resolvedModel,
      agentSessionId: ctx.agentSessionId,
      traceId: ctx.traceId,

      // Pass the parent's emit so workers can forward live events
      emit: ctx._emit || null,

      // User-configured max iterations for worker agents
      maxWorkerIterations: ctx._maxWorkerIterations,

      // Inherit context window size so workers load with the same context
      minContextLength: ctx._minContextLength,
    };

    switch (name) {
      case "team_create":
        return CoordinatorService.createTeam(args, coordinatorCtx);

      case "send_message":
        return CoordinatorService.sendMessage(args.to, args.message, coordinatorCtx);

      case "stop_agent":
        return CoordinatorService.stopAgent(args.agent_id);

      case "task_output":
        return CoordinatorService.getTaskOutput(args.agent_id);

      case "team_delete":
        return CoordinatorService.deleteTeam(args.teamName);

      default:
        return { error: `Unknown coordinator tool: ${name}` };
    }
  }

  /**
   * Execute a tool on an MCP server.
   * Parses the namespaced tool name and delegates to MCPClientService.
   *
   * @param {string} fullName - Namespaced MCP tool name (mcp__{server}__{tool})
   * @param {object} args - Tool arguments
   * @returns {Promise<object>}
   */
  static async executeMCPTool(fullName, args = {}) {
    const parsed = MCPClientService.parseMCPToolName(fullName);
    if (!parsed) {
      return { error: `Invalid MCP tool name: ${fullName}` };
    }
    return MCPClientService.callTool(parsed.serverName, parsed.toolName, args);
  }

  /**
   * Get all tool schemas from connected MCP servers.
   * @returns {Array}
   */
  static getMCPToolSchemas() {
    return MCPClientService.getToolSchemas();
  }

  /**
   * Map of tool names to their streaming SSE endpoint paths.
   * Only process-based tools that spawn subprocesses benefit from streaming.
   */
  static STREAMABLE_TOOLS = {
    execute_shell: "/compute/shell/stream",
    execute_python: "/utility/python/stream",
    execute_javascript: "/compute/js/stream",
    run_command: "/agentic/command/stream",
  };

  static isStreamable(toolName) {
    return toolName in ToolOrchestratorService.STREAMABLE_TOOLS;
  }

  /**
   * Execute a tool using the streaming SSE endpoint.
   * Calls `onChunk(event, data)` for each stdout/stderr chunk.
   * Returns the full result as a JSON object (same shape as executeTool).
   *
   * @param {string} name - tool name (must be in STREAMABLE_TOOLS)
   * @param {object} args - tool arguments (code, command, etc.)
   * @param {function} onChunk - (event: "stdout"|"stderr"|"start"|"exit", data?: string, meta?: object) => void
   * @param {object} [ctx] - Caller context for telemetry headers
   * @returns {Promise<object>} final result
   */
  static async executeToolStreaming(name, args = {}, onChunk, ctx = {}) {
    const streamPath = ToolOrchestratorService.STREAMABLE_TOOLS[name];
    if (!streamPath) {
      return ToolOrchestratorService.executeTool(name, args, ctx);
    }

    const remaps = ARG_REMAPS[name];
    let resolvedArgs = args;
    if (remaps) {
      resolvedArgs = { ...args };
      for (const [from, to] of Object.entries(remaps)) {
        if (resolvedArgs[from] !== undefined) {
          resolvedArgs[to] = resolvedArgs[from];
          delete resolvedArgs[from];
        }
      }
    }

    const url = `${TOOLS_SERVICE_URL}${streamPath}`;
    const contextHeaders = buildContextHeaders(ctx);

    try {
      // Combine session abort signal with a 65s timeout.
      // If the user cancels the session, the fetch aborts immediately.
      // If 65s elapses, the fetch aborts via timeout.
      const controller = createAbortController();
      const timeout = setTimeout(() => controller.abort(), 65_000); // generous timeout

      // If session signal exists, abort the local controller when session aborts
      if (ctx.signal && !ctx.signal.aborted) {
        const onSessionAbort = () => controller.abort();
        ctx.signal.addEventListener("abort", onSessionAbort, { once: true });
        // Clean up listener when controller aborts from timeout (not session)
        controller.signal.addEventListener("abort", () => {
          ctx.signal.removeEventListener("abort", onSessionAbort);
        }, { once: true });
      } else if (ctx.signal?.aborted) {
        controller.abort();
      }

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...contextHeaders },
        body: JSON.stringify(resolvedArgs),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        return { error: `API returned ${res.status}: ${res.statusText}` };
      }

      // Parse the SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));

            if (event.event === "stdout" || event.event === "stderr") {
              onChunk?.(event.event, event.data);
            } else if (event.event === "exit") {
              finalResult = {
                success: event.success,
                exitCode: event.exitCode,
                executionTimeMs: event.executionTimeMs,
                timedOut: event.timedOut || false,
                ...(event.error && { error: event.error }),
              };
              onChunk?.("exit", null, finalResult);
            } else if (event.event === "start") {
              onChunk?.("start", null, event);
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }

      // If we never got an exit event, return a generic result
      return finalResult || { error: "Stream ended without exit event" };
    } catch (err) {
      return { error: `Streaming failed: ${err.message}` };
    }
  }

  static async executeToolCalls(toolCalls) {
    return Promise.all(
      toolCalls.map(async (tc) => ({
        name: tc.name,
        id: tc.id,
        result: await ToolOrchestratorService.executeTool(tc.name, tc.args),
      })),
    );
  }

  static async executeCustomTool(toolDef, args = {}) {
    try {
      const headers = { "Content-Type": "application/json" };
      if (toolDef.bearerToken) {
        headers["Authorization"] = `Bearer ${toolDef.bearerToken}`;
      }

      if (toolDef.method === "POST") {
        const res = await fetch(toolDef.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(args),
        });
        if (!res.ok) {
          return { error: `API returned ${res.status}: ${res.statusText}` };
        }
        return await res.json();
      }

      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(args)) {
        if (value !== undefined && value !== null && value !== "") {
          params.set(key, value);
        }
      }
      const qs = params.toString();
      const url = `${toolDef.endpoint}${qs ? `?${qs}` : ""}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        return { error: `API returned ${res.status}: ${res.statusText}` };
      }
      return await res.json();
    } catch (err) {
      return { error: `Failed to reach API: ${err.message}` };
    }
  }

  // ── Worktree State Helpers — used by WorktreeTools.js ──────
  /** @internal */ static _setWorktree(sessionId, state) { activeWorktrees.set(sessionId, state); }
  /** @internal */ static _clearWorktree(sessionId) { activeWorktrees.delete(sessionId); }
  /** @internal */ static async _proxyPost(path, body, ctx) {
    return fetchJsonPost(`${TOOLS_SERVICE_URL}${path}`, body, buildContextHeaders(ctx), ctx.signal);
  }
}

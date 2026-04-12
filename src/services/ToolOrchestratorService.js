import { TOOLS_API_URL } from "../../secrets.js";
import MCPClientService from "./MCPClientService.js";
import logger from "../utils/logger.js";
import { COORDINATOR_ONLY_TOOLS } from "./CoordinatorPrompt.js";

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

/** @type {boolean} Whether initial fetch has completed */
let initialized = false;

/**
 * Fetch tool schemas from tools-api and populate caches.
 * Called eagerly at module load — non-blocking, graceful fallback.
 */
async function fetchSchemas() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`${TOOLS_API_URL}/admin/tool-schemas`, {
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
      const configRes = await fetch(`${TOOLS_API_URL}/admin/config`, {
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
  return `${TOOLS_API_URL}${path}${qs ? `?${qs}` : ""}`;
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
    const url = `${TOOLS_API_URL}${schema.endpoint.path}`;
    return fetchJsonPost(url, resolvedArgs, contextHeaders);
  }

  const url = buildUrlFromEndpoint(schema.endpoint, resolvedArgs);
  return fetchJson(url, contextHeaders);
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
  if (ctx.conversationId) headers["X-Agent-Session-Id"] = ctx.conversationId;
  if (ctx.iteration !== undefined && ctx.iteration !== null) headers["X-Iteration"] = String(ctx.iteration);
  return headers;
}

async function fetchJson(url, extraHeaders = {}) {
  try {
    const res = await fetch(url, {
      headers: { ...extraHeaders },
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
    return { error: `Failed to reach API: ${err.message}` };
  }
}

async function fetchJsonPost(url, body, extraHeaders = {}) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
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
    name: "spawn_agent",
    description: "Spawn a worker agent to execute a task autonomously in an isolated git worktree. Workers have access to the full tool suite (read, write, search, shell). Use for parallelizable research, implementation, or verification tasks.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short label for the worker (shown in UI)" },
        prompt: { type: "string", description: "Self-contained task prompt. Include file paths, line numbers, and exact instructions. Workers cannot see the coordinator's conversation." },
        files: { type: "array", items: { type: "string" }, description: "Optional: specific file paths the worker should focus on" },
        model: { type: "string", description: "Optional: model override for the worker (defaults to coordinator's model)" },
      },
      required: ["description", "prompt"],
    },
  },
  {
    name: "send_message",
    description: "Send a follow-up message to a running or completed worker agent. Use to continue work, provide corrections, or give new instructions.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Agent ID returned by spawn_agent" },
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
];

export default class ToolOrchestratorService {
  /** AI-clean schemas (no endpoint/domain/dataSource/labels) — for LLM tool arrays */
  static getToolSchemas() {
    return [...cachedAISchemas, ...COORDINATOR_TOOL_SCHEMAS];
  }

  /** Client-facing schemas (with domain/dataSource/labels, no endpoint) — for Retina UI */
  static getClientToolSchemas() {
    // Coordinator tools are Prism-local — add domain metadata for UI grouping
    const coordinatorClient = COORDINATOR_TOOL_SCHEMAS.map((t) => ({
      ...t,
      domain: "Coordinator",
      labels: { category: "Orchestration" },
    }));
    return [...cachedClientSchemas, ...coordinatorClient];
  }

  /** Workspace root paths from tools-api (single source of truth) */
  static getWorkspaceRoots() {
    return cachedWorkspaceRoots;
  }

  /** Primary workspace root (first entry) */
  static getWorkspaceRoot() {
    return cachedWorkspaceRoots[0] || null;
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
      const res = await fetch(`${TOOLS_API_URL}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      online = res.ok;
    } catch {
      online = false;
    }

    const apiStatus = { [TOOLS_API_URL]: online };

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
    if (name === "generate_image" && ctx.messages) {
      const referenceImages = [];
      for (const msg of ctx.messages) {
        if (msg.images && Array.isArray(msg.images)) {
          for (const img of msg.images) {
            if (typeof img === "string" && img.startsWith("data:")) {
              referenceImages.push(img);
            }
          }
        }
      }
      if (referenceImages.length > 0) {
        args = { ...args, referenceImages };
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
   * Execute a coordinator tool (spawn_agent, send_message, stop_agent).
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
      sessionId: ctx.conversationId,
      injectMessage: ctx._injectMessage || null,
    };

    switch (name) {
      case "spawn_agent":
        return CoordinatorService.spawnFromTool({
          description: args.description,
          prompt: args.prompt,
          files: args.files,
          model: args.model,
          coordinatorCtx,
        });

      case "send_message":
        return CoordinatorService.sendMessage(args.to, args.message, coordinatorCtx);

      case "stop_agent":
        return CoordinatorService.stopAgent(args.agent_id);

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

    const url = `${TOOLS_API_URL}${streamPath}`;
    const contextHeaders = buildContextHeaders(ctx);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 65_000); // generous timeout

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
}

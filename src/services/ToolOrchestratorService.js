import { TOOLS_API_URL } from "../../secrets.js";
import MCPClientService from "./MCPClientService.js";
import logger from "../utils/logger.js";
import { COORDINATOR_ONLY_TOOLS } from "./CoordinatorPrompt.js";
import { createAbortController } from "../utils/AbortController.js";

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

/**
 * Lightweight JSON Schema validator for synthetic_output.
 * Handles: type, required, enum, min/max, items (arrays), nested objects.
 * Not a full JSON Schema implementation — just enough for tool-level validation.
 *
 * @param {*} data - Value to validate
 * @param {object} schema - JSON Schema definition
 * @param {string} path - Current property path (for error messages)
 * @param {string[]} errors - Accumulates validation error messages
 */
function validateJsonSchema(data, schema, path = "", errors = []) {
  if (!schema || typeof schema !== "object") return;

  const at = path || "root";

  // Type check
  if (schema.type) {
    const expected = schema.type;
    if (expected === "object" && (typeof data !== "object" || data === null || Array.isArray(data))) {
      errors.push(`${at}: expected object, got ${Array.isArray(data) ? "array" : typeof data}`);
      return;
    }
    if (expected === "array" && !Array.isArray(data)) {
      errors.push(`${at}: expected array, got ${typeof data}`);
      return;
    }
    if (expected === "string" && typeof data !== "string") {
      errors.push(`${at}: expected string, got ${typeof data}`);
    }
    if (expected === "number" && typeof data !== "number") {
      errors.push(`${at}: expected number, got ${typeof data}`);
    }
    if (expected === "boolean" && typeof data !== "boolean") {
      errors.push(`${at}: expected boolean, got ${typeof data}`);
    }
  }

  // Enum check
  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.includes(data)) {
      errors.push(`${at}: value must be one of [${schema.enum.join(", ")}]`);
    }
  }

  // String constraints
  if (typeof data === "string") {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push(`${at}: string length ${data.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && data.length > schema.maxLength) {
      errors.push(`${at}: string length ${data.length} > maxLength ${schema.maxLength}`);
    }
  }

  // Number constraints
  if (typeof data === "number") {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push(`${at}: ${data} < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push(`${at}: ${data} > maximum ${schema.maximum}`);
    }
  }

  // Required fields
  if (schema.required && Array.isArray(schema.required) && typeof data === "object" && data !== null) {
    for (const key of schema.required) {
      if (data[key] === undefined) {
        errors.push(`${at}: missing required field "${key}"`);
      }
    }
  }

  // Object properties (recursive)
  if (schema.properties && typeof data === "object" && data !== null && !Array.isArray(data)) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (data[key] !== undefined) {
        validateJsonSchema(data[key], propSchema, `${path ? path + "." : ""}${key}`, errors);
      }
    }
  }

  // Array items (recursive)
  if (schema.items && Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      validateJsonSchema(data[i], schema.items, `${path}[${i}]`, errors);
    }
  }
}

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
// Prism-Local Tool Schemas — available to ALL agents, not routed to tools-api
// ────────────────────────────────────────────────────────────

const PRISM_LOCAL_TOOL_SCHEMAS = [
  {
    name: "think",
    description:
      "Use this tool to reason through complex problems step-by-step before acting. " +
      "Write your private reasoning, analysis, or plan here — this content is NOT shown to the user. " +
      "Use this when you need to: break down a multi-step task, weigh trade-offs between approaches, " +
      "analyze information from previous tool calls, plan your next actions, or reason about ambiguous requirements. " +
      "This tool does not execute anything — it simply records your thinking for context continuity.",
    parameters: {
      type: "object",
      properties: {
        thought: {
          type: "string",
          description: "Your private reasoning, analysis, or plan. Be thorough — this is your scratchpad.",
        },
      },
      required: ["thought"],
    },
  },
  {
    name: "sleep",
    description:
      "Pause execution for a specified duration. Use for polling workflows — e.g. wait for a build " +
      "to finish, a server to restart, or a deployment to propagate before checking results. " +
      "Maximum duration is 120 seconds. The pause can be cancelled if the user aborts the session.",
    parameters: {
      type: "object",
      properties: {
        duration_seconds: {
          type: "number",
          description: "How long to wait in seconds (1–120). Default: 5.",
        },
        reason: {
          type: "string",
          description: "Brief explanation of why you are waiting (shown to the user).",
        },
      },
      required: ["duration_seconds"],
    },
  },
  {
    name: "enter_plan_mode",
    description:
      "Switch into planning mode. While in plan mode, you will not have access to any tools — " +
      "you can only output text. Use this to produce a structured implementation plan before " +
      "executing changes. Call exit_plan_mode when you are ready to resume tool execution. " +
      "Use this when the task is complex and benefits from upfront planning.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why you are entering plan mode (shown to the user).",
        },
      },
      required: [],
    },
  },
  {
    name: "exit_plan_mode",
    description:
      "Exit planning mode and resume normal tool execution. Call this after you have " +
      "produced your plan and are ready to execute it with tools.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Brief summary of the plan you are about to execute.",
        },
      },
      required: [],
    },
  },
  {
    name: "skill_create",
    description:
      "Create a reusable workflow skill. Skills are stored prompt templates with variable " +
      "interpolation ({{variable}}) that can be invoked by name. Use this to capture " +
      "multi-step workflows (refactor→test→commit, analyze→report, etc.) as reusable atomic operations. " +
      "Skills persist across sessions and can be shared across agents.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Unique skill name (e.g. 'refactor_and_test', 'code_review'). Used as the skill ID.",
        },
        description: {
          type: "string",
          description: "What the skill does — shown when listing skills.",
        },
        prompt: {
          type: "string",
          description:
            "The prompt template to execute. Use {{variable}} syntax for parameters. " +
            "Example: 'Refactor {{file_path}} to use {{pattern}}. Then run tests.'",
        },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "Optional: ordered list of step descriptions for documentation.",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Optional: specific tools to enable. If omitted, all tools are available.",
        },
        maxIterations: {
          type: "number",
          description: "Optional: max agentic loop iterations for the skill run (1-100). Default: 25.",
        },
        model: {
          type: "string",
          description: "Optional: model override for the skill run.",
        },
      },
      required: ["name", "prompt"],
    },
  },
  {
    name: "skill_execute",
    description:
      "Execute a previously created skill by its ID. The skill's prompt template is " +
      "interpolated with the provided variables and executed as an inline agentic task. " +
      "Use skill_list to see available skills.",
    parameters: {
      type: "object",
      properties: {
        skillId: {
          type: "string",
          description: "The skill ID to execute (derived from the skill name).",
        },
        variables: {
          type: "object",
          description:
            "Key-value pairs for {{variable}} interpolation in the skill's prompt template. " +
            "Example: { file_path: '/src/utils.js', pattern: 'Strategy pattern' }.",
        },
      },
      required: ["skillId"],
    },
  },
  {
    name: "skill_list",
    description:
      "List all available skills. Skills are reusable workflow templates created with skill_create.",
    parameters: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Optional: filter by project scope.",
        },
      },
      required: [],
    },
  },
  {
    name: "skill_delete",
    description: "Delete a skill by its ID.",
    parameters: {
      type: "object",
      properties: {
        skillId: {
          type: "string",
          description: "The skill ID to delete.",
        },
      },
      required: ["skillId"],
    },
  },
  {
    name: "synthetic_output",
    description:
      "Produce a structured JSON output conforming to a defined schema. Use this when the user " +
      "or a downstream system needs machine-readable data rather than natural language. " +
      "Provide the output format as a JSON Schema object and the data that conforms to it. " +
      "The tool validates the data against the schema and returns the validated result. " +
      "Use cases: API-like responses, data extraction, typed reports, pipeline outputs.",
    parameters: {
      type: "object",
      properties: {
        schema: {
          type: "object",
          description:
            "JSON Schema definition for the expected output structure. " +
            "Example: { type: 'object', properties: { title: { type: 'string' }, score: { type: 'number' } }, required: ['title'] }.",
        },
        data: {
          type: "object",
          description:
            "The structured data to output. Must conform to the provided schema. " +
            "Example: { title: 'My Report', score: 95 }.",
        },
        label: {
          type: "string",
          description: "Optional label for this output (e.g. 'analysis_result', 'extracted_entities').",
        },
      },
      required: ["data"],
    },
  },
  {
    name: "enter_worktree",
    description:
      "Enter an isolated git worktree for the current conversation. Creates a new branch " +
      "and redirects all file/git/shell tool calls to the worktree directory. " +
      "Use this to try risky refactors, experimental changes, or speculative edits " +
      "without affecting the main branch. Your full conversation context is preserved. " +
      "Call exit_worktree to merge or discard when done.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why you're entering an isolated worktree (e.g. 'risky refactor', 'experimental approach').",
        },
      },
      required: [],
    },
  },
  {
    name: "exit_worktree",
    description:
      "Exit the current isolated worktree and return to the main workspace. " +
      "Choose to 'merge' changes back to the main branch or 'discard' them entirely. " +
      "If merging, changes are committed and merged automatically.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["merge", "discard"],
          description: "'merge' to apply changes to main branch, 'discard' to throw them away.",
        },
        commitMessage: {
          type: "string",
          description: "Commit message for the merge (used when action is 'merge'). Auto-generated if not provided.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "todo_write",
    description:
      "Write or update a persistent TODO checklist for the current project. " +
      "Maintains a structured list of items with completion status. " +
      "Use this to track multi-step work, record progress, and keep a living " +
      "checklist that persists across conversation turns. " +
      "Each item has a status: 'pending', 'in_progress', or 'completed'. " +
      "Call with the full updated list — it replaces the previous state.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "The todo item text." },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "Item status. Default: 'pending'.",
              },
              priority: {
                type: "string",
                enum: ["high", "medium", "low"],
                description: "Optional priority level.",
              },
            },
            required: ["content"],
          },
          description: "Full list of todo items. Replaces the previous list entirely.",
        },
      },
      required: ["items"],
    },
  },
  {
    name: "brief",
    description:
      "Produce a compressed summary of the current conversation context. " +
      "Use this tool when the conversation is getting long and you need to " +
      "consolidate your understanding before continuing. The summary you write " +
      "is stored and can be referenced in future turns to recover context. " +
      "This is NOT shown to the user — it is your private working memory.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "Your compressed summary of the conversation so far. Include: " +
            "key decisions made, files modified, current task state, and what remains to be done.",
        },
        keyFiles: {
          type: "array",
          items: { type: "string" },
          description: "Optional: list of key file paths relevant to the current work.",
        },
        openQuestions: {
          type: "array",
          items: { type: "string" },
          description: "Optional: unresolved questions or ambiguities.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "ask_user_question",
    description:
      "Ask the user a question and wait for their response before continuing. " +
      "Use this when you need clarification, a decision between options, or explicit " +
      "confirmation before proceeding with a potentially impactful action. " +
      "The agent loop pauses until the user responds. " +
      "Provide optional choices for multiple-choice questions, or leave choices " +
      "empty for freeform input.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to present to the user.",
        },
        choices: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: predefined answer choices (e.g. ['Option A', 'Option B', 'Skip']). " +
            "If provided, the user selects one. If omitted, freeform text input is shown.",
        },
        context: {
          type: "string",
          description: "Optional: additional context to help the user answer (shown below the question).",
        },
      },
      required: ["question"],
    },
  },
];

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
          description: "The agent ID returned by spawn_agent.",
        },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "team_create",
    description:
      "Create a named team of worker agents that execute in parallel. Each team member " +
      "receives its own prompt and runs in an isolated worktree. Use teams for structured " +
      "parallel work — e.g. one agent writes code, another writes tests, a third updates docs. " +
      "Returns results from all members when they all complete.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Team name for identification (e.g. 'feature_x_team').",
        },
        members: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string", description: "Short label for this team member." },
              prompt: { type: "string", description: "Self-contained task prompt for this member." },
              files: { type: "array", items: { type: "string" }, description: "Optional: file paths to focus on." },
              model: { type: "string", description: "Optional: model override for this member." },
            },
            required: ["description", "prompt"],
          },
          description: "Array of team member definitions. Each member becomes a spawn_agent worker.",
        },
      },
      required: ["name", "members"],
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
    return [...cachedAISchemas, ...PRISM_LOCAL_TOOL_SCHEMAS, ...COORDINATOR_TOOL_SCHEMAS];
  }

  /** Client-facing schemas (with domain/dataSource/labels, no endpoint) — for Retina UI */
  static getClientToolSchemas() {
    // Prism-local tools — assign domain per tool name
    const LOCAL_DOMAINS = {
      think: "Reasoning",
      sleep: "Agentic: Control Flow",
      enter_plan_mode: "Agentic: Control Flow",
      exit_plan_mode: "Agentic: Control Flow",
      skill_create: "Agentic: Skills",
      skill_execute: "Agentic: Skills",
      skill_list: "Agentic: Skills",
      skill_delete: "Agentic: Skills",
      synthetic_output: "Agentic: Structured Output",
      enter_worktree: "Agentic: Git Isolation",
      exit_worktree: "Agentic: Git Isolation",
      todo_write: "Agentic: Task Management",
      brief: "Reasoning",
      ask_user_question: "Agentic: Control Flow",
    };

    // Labels — multi-tag arrays matching tools-api TOOL_LABELS format
    const LOCAL_LABELS = {
      think: ["coding"],
      sleep: ["coding"],
      enter_plan_mode: ["coding"],
      exit_plan_mode: ["coding"],
      skill_create: ["coding", "automation"],
      skill_execute: ["coding", "automation"],
      skill_list: ["coding", "automation"],
      skill_delete: ["coding", "automation"],
      synthetic_output: ["coding"],
      enter_worktree: ["coding", "git"],
      exit_worktree: ["coding", "git"],
      todo_write: ["coding"],
      brief: ["coding"],
      ask_user_question: ["coding"],
    };

    const localClient = PRISM_LOCAL_TOOL_SCHEMAS.map((t) => ({
      ...t,
      domain: LOCAL_DOMAINS[t.name] || "Reasoning",
      labels: LOCAL_LABELS[t.name] || ["coding"],
    }));
    // Coordinator tools are Prism-local — add domain metadata for UI grouping
    const coordinatorClient = COORDINATOR_TOOL_SCHEMAS.map((t) => ({
      ...t,
      domain: "Coordinator",
      labels: ["coding", "orchestration"],
    }));
    return [...cachedClientSchemas, ...localClient, ...coordinatorClient];
  }

  /** Workspace root paths from tools-api (single source of truth) */
  static getWorkspaceRoots() {
    return cachedWorkspaceRoots;
  }

  /** Primary workspace root (first entry) */
  static getWorkspaceRoot() {
    return cachedWorkspaceRoots[0] || null;
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
    // ── Prism-local no-op tools (think/scratchpad) ──────────────
    if (name === "think") {
      return { acknowledged: true };
    }

    // ── Sleep tool — timed pause with abort support ─────────────
    if (name === "sleep") {
      const duration = Math.max(1, Math.min(120, args.duration_seconds || 5));
      const durationMs = duration * 1000;
      logger.info(`[ToolOrchestrator] sleep: ${duration}s${args.reason ? ` — ${args.reason}` : ""}`);

      // Emit status so Retina can show a countdown
      if (ctx._emit) {
        ctx._emit({ type: "status", message: "sleeping", duration, reason: args.reason || null });
      }

      await new Promise((resolve) => {
        const timer = setTimeout(resolve, durationMs);
        // If session is aborted, resolve immediately
        if (ctx.signal && !ctx.signal.aborted) {
          const onAbort = () => { clearTimeout(timer); resolve(); };
          ctx.signal.addEventListener("abort", onAbort, { once: true });
        } else if (ctx.signal?.aborted) {
          clearTimeout(timer);
          resolve();
        }
      });

      return { acknowledged: true, slept_seconds: duration, reason: args.reason || null };
    }

    // ── Plan mode toggle tools ──────────────────────────────────
    if (name === "enter_plan_mode") {
      logger.info(`[ToolOrchestrator] enter_plan_mode${args.reason ? `: ${args.reason}` : ""}`);
      return { acknowledged: true, mode: "plan", reason: args.reason || null };
    }
    if (name === "exit_plan_mode") {
      logger.info(`[ToolOrchestrator] exit_plan_mode${args.summary ? `: ${args.summary}` : ""}`);
      return { acknowledged: true, mode: "execute", summary: args.summary || null };
    }

    // ── Synthetic output — structured JSON response ─────────────
    if (name === "synthetic_output") {
      const { schema, data, label } = args;

      if (!data || typeof data !== "object") {
        return { error: "'data' is required and must be an object" };
      }

      // Optional schema validation (best-effort)
      const validationErrors = [];
      if (schema && typeof schema === "object") {
        try {
          validateJsonSchema(data, schema, "", validationErrors);
        } catch (err) {
          validationErrors.push(`Validation error: ${err.message}`);
        }
      }

      const result = {
        acknowledged: true,
        label: label || null,
        data,
      };

      if (validationErrors.length > 0) {
        result.validationWarnings = validationErrors;
      }

      // Mark for downstream processing — the AgenticLoopService can
      // extract this as the structured final response.
      result._synthetic = true;

      logger.info(`[ToolOrchestrator] synthetic_output${label ? `: ${label}` : ""} — ${Object.keys(data).length} fields`);
      return result;
    }

    // ── Todo write — persistent checklist per session ───────────
    if (name === "todo_write") {
      const { items } = args;
      if (!Array.isArray(items)) {
        return { error: "'items' must be an array of todo objects" };
      }

      // Normalize items
      const normalized = items.map((item, i) => ({
        id: i + 1,
        content: item.content || "",
        status: item.status || "pending",
        priority: item.priority || "medium",
      }));

      const stats = {
        total: normalized.length,
        pending: normalized.filter((i) => i.status === "pending").length,
        in_progress: normalized.filter((i) => i.status === "in_progress").length,
        completed: normalized.filter((i) => i.status === "completed").length,
      };

      logger.info(`[ToolOrchestrator] todo_write: ${stats.total} items (${stats.completed} done, ${stats.in_progress} in progress, ${stats.pending} pending)`);

      // Emit to Retina so it can render the todo panel
      if (ctx._emit) {
        ctx._emit({ type: "todo_update", items: normalized, stats });
      }

      return { acknowledged: true, items: normalized, stats };
    }

    // ── Brief — context summarization working memory ────────────
    if (name === "brief") {
      const { summary, keyFiles, openQuestions } = args;
      if (!summary || typeof summary !== "string") {
        return { error: "'summary' is required and must be a non-empty string" };
      }

      const brief = {
        summary,
        keyFiles: keyFiles || [],
        openQuestions: openQuestions || [],
        timestamp: new Date().toISOString(),
      };

      logger.info(`[ToolOrchestrator] brief: ${summary.length} chars, ${(keyFiles || []).length} files, ${(openQuestions || []).length} questions`);

      // Emit to Retina for optional context panel display
      if (ctx._emit) {
        ctx._emit({ type: "brief_update", brief });
      }

      return { acknowledged: true, brief };
    }

    // ── Ask user question — pause loop for user input ───────────
    if (name === "ask_user_question") {
      const { question, choices, context: questionContext } = args;
      if (!question || typeof question !== "string") {
        return { error: "'question' is required and must be a non-empty string" };
      }

      const sessionId = ctx.agentSessionId;
      if (!sessionId) {
        return { error: "No agent session — ask_user_question requires an active session" };
      }

      logger.info(`[ToolOrchestrator] ask_user_question: "${question.slice(0, 80)}${question.length > 80 ? "..." : ""}" (${choices?.length || 0} choices)`);

      // Emit the question to Retina
      if (ctx._emit) {
        ctx._emit({
          type: "user_question",
          question,
          choices: choices || [],
          context: questionContext || null,
        });
      }

      // Pause via the same pendingApprovals mechanism used by tool approval.
      // AgenticLoopService.resolveUserQuestion() resolves this promise when
      // the user responds via the HTTP endpoint.
      const { default: AgenticLoopService } = await import("./AgenticLoopService.js");
      const answer = await new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
          resolve({ answer: null, timedOut: true });
        }, 300_000); // 5 minute timeout
        AgenticLoopService._setPendingQuestion(sessionId, {
          resolve: (val) => {
            clearTimeout(timeoutId);
            resolve(val);
          },
          question,
          choices: choices || [],
        });
      });

      if (answer.timedOut) {
        logger.warn(`[ToolOrchestrator] ask_user_question timed out after 5 minutes`);
        return { answer: null, timedOut: true, message: "The user did not respond within 5 minutes." };
      }

      logger.info(`[ToolOrchestrator] ask_user_question answered: "${String(answer.answer).slice(0, 80)}"`);
      return { answer: answer.answer, question };
    }

    // ── Worktree isolation — self-isolate main agent ────────────
    if (name === "enter_worktree") {
      const sessionId = ctx.agentSessionId;
      if (!sessionId) {
        return { error: "No agent session — worktree isolation requires an active session" };
      }
      if (activeWorktrees.has(sessionId)) {
        const existing = activeWorktrees.get(sessionId);
        return { error: `Already in a worktree (branch: ${existing.branchName}). Call exit_worktree first.` };
      }

      const workspaceRoot = ToolOrchestratorService.getWorkspaceRoot();
      if (!workspaceRoot) {
        return { error: "No workspace root configured" };
      }

      // Resolve the git repo path (may be a subdirectory)
      const { resolve } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const repoPath = existsSync(resolve(workspaceRoot, ".git"))
        ? workspaceRoot
        : workspaceRoot;

      const branchName = `worktree/${sessionId.slice(0, 8)}-${Date.now().toString(36)}`;

      // Create worktree via tools-api
      const createResult = await fetchJsonPost(
        `${TOOLS_API_URL}/agentic/git/worktree/create`,
        { path: repoPath, branch: branchName },
        buildContextHeaders(ctx),
        ctx.signal,
      );

      if (createResult.error) {
        return { error: `Failed to create worktree: ${createResult.error}` };
      }

      // Store the worktree state
      activeWorktrees.set(sessionId, {
        originalRoot: workspaceRoot,
        worktreePath: createResult.worktreePath,
        branchName,
        repoPath,
      });

      logger.info(`[ToolOrchestrator] enter_worktree: ${branchName} → ${createResult.worktreePath}`);

      if (ctx._emit) {
        ctx._emit({ type: "status", message: "worktree_entered", branch: branchName, path: createResult.worktreePath });
      }

      return {
        acknowledged: true,
        branch: branchName,
        worktreePath: createResult.worktreePath,
        reason: args.reason || null,
        message: `Now working in isolated worktree. All file operations are redirected to ${createResult.worktreePath}. Call exit_worktree with action 'merge' or 'discard' when done.`,
      };
    }

    if (name === "exit_worktree") {
      const sessionId = ctx.agentSessionId;
      if (!sessionId || !activeWorktrees.has(sessionId)) {
        return { error: "Not currently in a worktree. Call enter_worktree first." };
      }

      const wt = activeWorktrees.get(sessionId);
      const { action, commitMessage } = args;
      let mergeResult = null;

      if (action === "merge") {
        // Get diff summary before merging
        const diffResult = await fetchJsonPost(
          `${TOOLS_API_URL}/agentic/git/worktree/diff`,
          { path: wt.repoPath, branch: wt.branchName },
          buildContextHeaders(ctx),
          ctx.signal,
        );

        // Merge the worktree branch
        mergeResult = await fetchJsonPost(
          `${TOOLS_API_URL}/agentic/git/worktree/merge`,
          {
            path: wt.repoPath,
            branch: wt.branchName,
            message: commitMessage || `Merge worktree: ${wt.branchName}`,
          },
          buildContextHeaders(ctx),
          ctx.signal,
        );

        if (mergeResult.error) {
          // Don't clean up on merge failure — let the user resolve
          return { error: `Merge failed: ${mergeResult.error}. Worktree preserved at ${wt.worktreePath}. Resolve conflicts and try again, or exit_worktree with action 'discard'.` };
        }

        mergeResult.diff = diffResult.error ? null : diffResult;
      }

      // Remove the worktree (both merge and discard)
      await fetchJsonPost(
        `${TOOLS_API_URL}/agentic/git/worktree/remove`,
        { path: wt.repoPath, worktreePath: wt.worktreePath, deleteBranch: true },
        buildContextHeaders(ctx),
        ctx.signal,
      );

      // Restore original workspace
      activeWorktrees.delete(sessionId);

      logger.info(`[ToolOrchestrator] exit_worktree: ${action} — ${wt.branchName}`);

      if (ctx._emit) {
        ctx._emit({ type: "status", message: "worktree_exited", action, branch: wt.branchName });
      }

      return {
        acknowledged: true,
        action,
        branch: wt.branchName,
        merged: action === "merge" ? mergeResult : undefined,
        message: action === "merge"
          ? `Changes from ${wt.branchName} merged into main branch. Workspace restored.`
          : `Worktree ${wt.branchName} discarded. All changes removed. Workspace restored.`,
      };
    }

    // ── Skill tools — MongoDB-backed workflow templates ──────────
    if (name === "skill_create" || name === "skill_list" || name === "skill_delete" || name === "skill_execute") {
      const { default: SkillService } = await import("./SkillService.js");

      if (name === "skill_create") {
        return SkillService.create(args);
      }
      if (name === "skill_list") {
        return SkillService.list({ project: args.project || ctx.project });
      }
      if (name === "skill_delete") {
        return SkillService.delete(args.skillId);
      }
      if (name === "skill_execute") {
        // Prepare the skill (interpolate variables, get config)
        const prepared = await SkillService.prepare(args.skillId, args.variables || {});
        if (prepared.error) return prepared;

        // Execute the skill as an inline sub-task using the coordinator's
        // spawn_agent mechanism — same worktree isolation, diff collection,
        // and progress forwarding.
        logger.info(`[ToolOrchestrator] Executing skill "${prepared.name}" (${prepared.skillId})`);
        return ToolOrchestratorService.executeCoordinatorTool("spawn_agent", {
          description: `Skill: ${prepared.name}`,
          prompt: prepared.prompt,
          model: prepared.config.model || undefined,
        }, ctx);
      }
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

      case "task_output":
        return CoordinatorService.getTaskOutput(args.agent_id);

      case "team_create":
        return CoordinatorService.createTeam(args, coordinatorCtx);

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

    const url = `${TOOLS_API_URL}${streamPath}`;
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
}

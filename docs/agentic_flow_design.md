# Agentic Flow & Architecture: Retina & Prism Design

Based on analysis of state-of-the-art agent architectures (including open-source terminal agents like `pi-mono`, Anthropic's `claude-code` snapshot, and industry-standard patterns), here is a comprehensive breakdown of the agentic loop, architecture, and strategic roadmap for **Prism** (the local AI gateway) and **Retina** (the web UI).

> **Legend**: ✅ = Already implemented | ⚠️ = Partially implemented | 🔲 = Not started

---

## 1. The Core Agent Loop (The "11-Step Engine")

The Retina Agent executes a robust 11-step loop for every user interaction, built around streaming, context management, and recursive tool usage.

1. ✅ **User Input**: Captures input from the Retina UI. Two transports:
   - **WebSocket** (`/ws/chat`) — persistent bidirectional connection, used by Retina's real-time chat
   - **REST SSE** (`POST /agent`) — dedicated agentic endpoint with SSE streaming (default) or JSON response (`?stream=false`), used by server-to-server callers (Lupos, external integrations). Always enables `agenticLoopEnabled` + `functionCallingEnabled`.
2. ✅ **Message Creation**: Wraps text into standard LLM message formats via `expandMessagesForFC()`, normalizing across providers (OpenAI, Anthropic, Google, local).
3. ✅ **History Append**: Appends to a fast, in-memory `currentMessages` array within `AgenticLoopService`, backed by MongoDB persistence via `finalizeTextGeneration()` at loop end.
4. ✅ **System Prompt Assembly**: Dynamically builds the system prompt server-side via `SystemPromptAssembler`, registered as a `beforePrompt` hook in `AgentHooks`. The assembly pipeline:
   - ✅ Agent identity + coding guidelines
   - ✅ Available tools (domain-grouped with full parameter details)
   - ✅ Environment info (date/time, OS, workspace)
   - ✅ Project directory tree from `tools-api` (cached 1 minute)
   - ✅ Project skills (embedding-based relevance filtering via `fetchSkills()`, cosine similarity threshold 0.3)
   - ✅ Session memory from past conversations via `AgentMemoryService` (embedding-based search)
5. ✅ **API Streaming**: Starts a streaming connection via `provider.generateTextStream()` or `provider.generateTextStreamLive()` for Live API models. Local GPU models serialized via `LocalModelQueue` mutex.
6. ✅ **Token Parsing**: Chunk processing loop handles: `text`, `thinking`, `thinking_signature`, `toolCall`, `image`, `executableCode`, `codeExecutionResult`, `webSearchResult`, `audio`, `status`, and `usage` chunk types. Anthropic `thinking_signature` is captured and round-tripped for multi-turn tool use conversations.
7. ✅ **Tool Detection**: Resolves tool call chunks, including native MCP pass-through for LM Studio (`chunk.native === true`). Pre-flight permission checks are implemented via `AutoApprovalEngine` (three-tier system with `beforeToolCall` hook).
8. ✅ **Tool Loop**: Collects `passPendingToolCalls`, executes via `Promise.all` (with streaming SSE for shell/python/js/command tools), appends results to context, and re-prompts the LLM automatically. Capped at `MAX_TOOL_ITERATIONS = 25`. Consecutive error retry budgeting at `MAX_CONSECUTIVE_TOOL_ERRORS = 3` per tool name. Native web search collision prevention removes custom `web_search` when provider's native search is active.
9. ✅ **Context Window Enforcement**: Before each LLM call, `ContextWindowManager.enforce()` applies a three-strategy truncation cascade to prevent context overflow: (1) aggressive tool result truncation → (2) old assistant message compression → (3) sliding window turn dropping. Uses ~3.5 chars/token estimation, 80% utilization target, configurable per-model via `maxInputTokens`. Emits `context_truncated` status events to the UI.
10. ✅ **Exhaustion Recovery**: If the loop exits by hitting `MAX_TOOL_ITERATIONS`, a final tool-free LLM pass is triggered to summarize progress so the user understands where they stand. Emits `iteration_limit_reached` status.
11. ✅ **Response Rendering**: Flushes final text to the transport via `emit({ type: "chunk", content })`.
12. ✅ **Post-Sampling Hooks**: Background memory extraction via `MemoryExtractor`, registered as an `afterResponse` hook in `AgentHooks`. Uses a configurable extraction model (Settings → Memory Models) to extract memories using CC-style 4-type taxonomy: `user` (role, goals, preferences), `feedback` (corrections, confirmations, lessons), `project` (non-derivable context, decisions, deadlines), `reference` (external system pointers). Includes explicit "What NOT to save" negative constraints (code patterns, git history, debugging solutions). Implements **mutual exclusion** — skips extraction when the main agent used `upsert_memory` during the current turn. All memories stored in the single unified `memories` collection via `MemoryService.store()` with embedding-based cosine duplicate detection (>0.92 threshold). Triggers `MemoryConsolidationService.checkAndRun()` for session-threshold consolidation.
13. ✅ **Await Input**: The WebSocket connection stays open for the next message. REST SSE connections end cleanly.

---

## 2. Real-World Implementation Patterns

Concrete software patterns for building and extending Prism's agent loop:

### ✅ Unified Extensions & Hooks System

The core logic uses an `EventEmitter`-based hook system wrapping the `AgenticLoopService` while loop. Lifecycle events include:

| Event            | Fires When                    | Use Case                                 |
| ---------------- | ----------------------------- | ---------------------------------------- |
| `BeforePrompt`   | Before system prompt assembly | Inject skills, memory, directory context |
| `BeforeToolCall` | Before each tool execution    | Auto-Approval Engine permission check    |
| `AfterToolCall`  | After each tool returns       | Logging, mutation tracking               |
| `AfterResponse`  | After final text is flushed   | Session summarization, memory extraction |
| `OnError`        | On any loop error             | Error recovery, generating flag cleanup  |

Implementation: `EventEmitter`-based, registered via a plugin array in `AgenticLoopService`. Named hooks with sequential execution and error isolation.

### ✅ Dual Endpoint Architecture (`/chat` vs `/agent`)

The agentic loop is gated on a dedicated REST endpoint:

| Endpoint      | Agentic Loop      | Function Calling | Use Case                                     |
| ------------- | ----------------- | ---------------- | -------------------------------------------- |
| `POST /chat`  | ❌ Off by default | Optional         | Simple LLM calls, Chat tab                   |
| `POST /agent` | ✅ Always on      | ✅ Always on     | Autonomous agent workflows, Agent tab, Lupos |
| `WS /ws/chat` | Flag-gated        | Flag-gated       | Retina real-time chat                        |

`/agent` forces `agenticLoopEnabled: true` and `functionCallingEnabled: true` on every request. Supports SSE streaming (default) and JSON response (`?stream=false` for server-to-server callers like Lupos). Approval endpoint at `POST /agent/approve` resolves pending plan/tool approvals by conversationId.

**Files**: `prism/src/routes/agent.js`, `prism/src/routes/chat.js`

### ✅ Robust Execution Design

`ToolOrchestratorService` implements streaming shell execution for process-based tools:

- `execute_shell` → `/compute/shell/stream` (SSE)
- `execute_python` → `/utility/python/stream` (SSE)
- `execute_javascript` → `/compute/js/stream` (SSE)
- `run_command` → `/agentic/command/stream` (SSE)

All use POST + SSE streaming with 65s timeout, stdout/stderr separation, and exit code tracking. Non-streamable tools use direct REST calls to `tools-api`.

### ✅ Local GPU Mutex

`LocalModelQueue` provides a process-level mutex for local model requests (LM Studio, vLLM, Ollama). Prevents concurrent chat + benchmark requests from colliding on the GPU. Acquired before streaming, released in `finally` block. Queue depth logged for visibility.

### ✅ Skills System

Database-backed per-project skills stored in `agent_skills` MongoDB collection. Full CRUD via REST API (`/skills`), managed through the **SkillsPanel** tab in Retina's Agent page. `SystemPromptAssembler.fetchSkills()` queries enabled skills and injects them as `## Project Skills` context blocks into the system prompt, filtered by embedding-based relevance (cosine similarity ≥ 0.3 threshold). `AgenticLoopService` emits a `skills_injected` status event listing loaded skill names for the UI. **Files**: `prism/src/routes/skills.js`, `SystemPromptAssembler.js`, `retina/src/components/SkillsPanel.js`.

### 🔲 Prompt Templates & Slash Commands

Parameterized slash commands using bash-style argument substitution (`$1`, `$@`, `${@:start}`). Implementation lives in Retina's `ChatArea` component, expanding templates before sending to Prism.

### ✅ Tool Rendering Registry

Retina has `ToolResultRenderers.js` (733 lines) — a registry-based architecture where each tool type registers its own specialized renderer. Integrated into `MessageList.js` via `ToolResultView`. Includes:

- File tools → diff viewer with syntax highlighting
- Shell tools → terminal output panel with ANSI color support
- Search tools → result cards with file links
- Git tools → status/diff/log renderers
- Browser tools → screenshot display with action metadata

---

## 3. Prism / Retina Tool System

### Current Tool Inventory

Prism dynamically loads tool schemas from `tools-api/admin/tool-schemas` at boot via `ToolOrchestratorService.fetchSchemas()`. Tools are organized by domain service in `tools-api`:

| Service                 | Tools                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `AgenticFileService`    | `read_file`, `write_file`, `str_replace_file`, `patch_file`, `multi_file_read`, `file_info`, `file_diff`, `move_file`, `delete_file` |
| `AgenticCommandService` | `execute_shell`, `execute_python`, `execute_javascript`, `run_command`                                                               |
| `AgenticProjectService` | `list_directory`, `grep_search`, `glob_files`, `project_summary`                                                                     |
| `AgenticWebService`     | `fetch_url`, `web_search`                                                                                                            |
| `AgenticGitService`     | `git_status`, `git_diff`, `git_log` (+ worktree ops)                                                                                 |
| `AgenticBrowserService` | `browser_action`                                                                                                                     |
| `AgenticTaskService`    | `task_create`, `task_get`, `task_list`, `task_update`                                                                                |

Additionally, custom tools can be defined per-project in MongoDB (`custom_tools` collection) with arbitrary HTTP endpoints.

### Priority Additions

1. ✅ **MCP Client (Model Context Protocol)**:
   - **What**: Prism acts as an **MCP client**, connecting to external MCP servers and exposing their tools to the LLM.
   - **Implementation**: `MCPClientService` manages connections via `@modelcontextprotocol/sdk` (stdio + Streamable HTTP transports). Tools namespaced as `mcp__{server}__{tool}` and merged into `ToolOrchestratorService`. Managed via `/mcp-servers` REST API with CRUD + connect/disconnect endpoints. Retina MCPServersPanel in Agent sidebar. Auto-connect on startup.
   - **Files**: `MCPClientService.js`, `mcp-servers.js`, `ToolOrchestratorService.js`, `MCPServersPanel.js`

2. ✅ **Browser Automation ("Computer Use")**:
   - **What**: Headless Playwright-based browser tool for SPA navigation, E2E testing, and visual QA.
   - **Why**: `fetch_url` can't handle JavaScript-rendered pages, authentication flows, or visual regression testing.
   - **Implementation**: `AgenticBrowserService` in `tools-api` manages a Playwright browser instance via `browser_action` tool. Supports `navigate`, `click`, `type`, `screenshot`, `scroll`, `evaluate`, `get_elements` (DOM inspection with CSS selectors). Screenshots uploaded to MinIO as `screenshotRef` values and promoted into conversation `images` arrays.
   - **Files**: `tools-api/services/AgenticBrowserService.js`, `AgenticRoutes.js` (`/agentic/browser/action`), `retina/src/components/ToolResultRenderers.js`

3. ✅ **Semantic Code Navigation (LSP)**:
   - **What**: Exposing Language Server Protocol (LSP) capabilities to the agent for compiler-grade code intelligence instead of relying purely on regex `grep_search`.
   - **Why**: Allows the agent to precisely find definitions, trace references across files, and inspect type signatures natively, massively reducing hallucination on complex codebases.
   - **Implementation**: `AgenticLspService` in `tools-api` wrapping LSP servers (`typescript-language-server`, `pyright-langserver`) via `vscode-jsonrpc` stdio transport. Single `lsp_action` tool with operation enum: `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `goToImplementation`. Servers lazy-started on first request per language. `LspClient` handles JSON-RPC framing, `LspServerInstance` manages lifecycle with exponential backoff retry, `LspServerManager` routes requests by file extension.
   - **Files**: `tools-api/services/lsp/LspClient.js`, `LspServerInstance.js`, `LspServerManager.js`, `lspConfig.js`, `AgenticLspService.js`, `AgenticRoutes.js` (`/agentic/lsp/action`, `/agentic/lsp/health`, `/agentic/lsp/shutdown`)

4. ✅ **Task & State Management**:
   - **What**: A persistent, MongoDB-backed task list that survives context window truncation and memory consolidation — functioning as reliable **Working Memory** for multi-step agent workflows.
   - **Why**: As contexts slide and memory gets consolidated, agents lose track of complex multi-stage tasks. A persistent scratchpad decouples task tracking from the ephemeral conversation window.
   - **Implementation**: `AgenticTaskService` in `tools-api` with four tools: `task_create` (with subject, description, status, metadata), `task_get` (single task by ID), `task_list` (filterable by status, returns summary counts), `task_update` (status transitions, metadata merge). MongoDB `agent_tasks` collection with project-scoped isolation, monotonic IDs via `agent_task_counters`. All four tools registered as **Tier 1 (auto-approve)** in `AutoApprovalEngine` since they only modify the agent's own scratchpad, not user files. 200-task-per-project cap.
   - **Files**: `tools-api/services/AgenticTaskService.js`, `AgenticRoutes.js` (`/agentic/task/{create,list,get,update,delete}`), `ToolSchemaService.js`, `prism/src/services/AutoApprovalEngine.js`

5. 🔲 **Background Execution Monitoring (Terminal Capture)**:
   - **What**: The ability to inspect the output of persistent daemon processes (like `npm run dev` or a Python server).
   - **Why**: `execute_shell` relies on the process exiting to read output. Agents need to "glance" at long-running logs to debug errors from background servers.
   - **Implementation**: Terminal tail wrapping in `AgenticCommandService` via a `capture_terminal` tool.

> **Design principle**: Optimize for the _right_ tools at each capability tier, not raw count. Claude Code ships ~15 tools. Cursor ships fewer. Coverage of capability categories (filesystem, search, execution, network, browser) matters more than quantity.

### Tool Parity Matrix: Prism vs Claude Code

Complete tool-by-tool mapping between Claude Code (from [razakiau/claude-code `src/tools/`](https://github.com/razakiau/claude-code/tree/main/src/tools)) and the Prism/tools-api ecosystem. All Claude Code tools are accounted for — either matched, exceeded, or intentionally not adopted.

#### Filesystem & Code Editing

| Claude Code Tool | Prism Equivalent | Parity | Notes |
|---|---|---|---|
| `ReadTool` | `read_file` | ✅ Match | Single-file read with line range support |
| `ReadTool` (multi) | `multi_file_read` | ✅ **Superior** | Batch read multiple files in one call — CC requires sequential reads |
| `WriteTool` | `write_file` | ✅ Match | Full file creation/overwrite |
| `EditTool` | `str_replace_file`, `patch_file` | ✅ **Superior** | Two edit strategies: search-and-replace (`str_replace_file`) and unified diff (`patch_file`). CC only has search-and-replace. `patch_file` applies multi-hunk diffs in a single tool call |
| — | `file_info` | ✅ **Extra** | File metadata (size, mtime, permissions, MIME type) — no CC equivalent |
| — | `file_diff` | ✅ **Extra** | Structured diff between two files or file versions — no CC equivalent |
| — | `move_file` | ✅ **Extra** | Rename/move files — CC uses shell commands for this |
| — | `delete_file` | ✅ **Extra** | Delete files with safety checks — CC uses shell commands |

**Architectural note:** CC has a single `EditTool` that does search-and-replace. Our dual approach (`str_replace_file` for surgical edits, `patch_file` for multi-hunk diffs) is more expressive — `patch_file` can apply an entire unified diff in one tool call, which CC would need multiple sequential `EditTool` invocations for.

#### Code Intelligence & Search

| Claude Code Tool | Prism Equivalent | Parity | Notes |
|---|---|---|---|
| `GrepTool` | `grep_search` | ✅ Match | Regex/literal search across project files |
| `GlobTool` | `glob_files` | ✅ Match | File discovery by glob pattern |
| `ListTool` | `list_directory` | ✅ Match | Directory listing with recursive support |
| — | `project_summary` | ✅ **Extra** | Full project tree snapshot — no CC equivalent |
| — | `lsp_action` | ✅ **Superior** | LSP-based code intelligence (goToDefinition, findReferences, hover, documentSymbol, goToImplementation). CC relies on `GrepTool` for code navigation — no compiler-grade intelligence |

**Architectural note:** CC's code navigation is purely grep-based. Our `AgenticLspService` wraps actual language servers (`typescript-language-server`, `pyright-langserver`) for compiler-grade precision — zero hallucination on symbol resolution, type information, and cross-file reference tracing.

#### Command Execution

| Claude Code Tool | Prism Equivalent | Parity | Notes |
|---|---|---|---|
| `BashTool` | `execute_shell`, `run_command` | ✅ **Superior** | Two execution modes: `execute_shell` (raw shell via tools-api sandbox) and `run_command` (agentic command execution with working directory control). Both stream via SSE. CC's `BashTool` is a single shell executor |
| `REPLTool` (JS) | `execute_javascript` | ✅ Match | Both spawn a fresh subprocess per call — neither is a true REPL (no state persistence between calls). CC's naming is misleading |
| `REPLTool` (Python) | `execute_python` | ✅ **Superior** | Our Python executor has better sandboxing: memory limit (256MB via `resource.setrlimit`), network disabled (socket creation blocked), dangerous module blocking (`subprocess`, `shutil`, `ctypes`, `multiprocessing`, `signal`). Also supports SSE streaming of stdout/stderr chunks |

**Architectural note:** Despite the name "REPL Tool", Claude Code's `REPLTool` is NOT a true REPL — it spawns a fresh `child_process.execFile()` per call with no state persistence between invocations. It's functionally identical to our `execute_python` / `execute_javascript`. We are actually ahead in sandbox hardening (CC has no memory limits, no module blocking, no network isolation) and real-time output streaming (SSE for stdout/stderr chunks).

#### Web & Network

| Claude Code Tool | Prism Equivalent | Parity | Notes |
|---|---|---|---|
| `WebFetchTool` | `fetch_url` | ✅ Match | Fetch URL content with HTML-to-markdown conversion |
| `WebSearchTool` | `web_search` | ✅ Match | Web search with provider abstraction |
| — | `browser_action` | ✅ **Superior** | Playwright-based headless browser automation (navigate, click, type, screenshot, evaluate JS, DOM inspection). CC has `ComputerTool` but it's screen-pixel-based — our DOM-level interaction is more reliable and faster |

#### Git

| Claude Code Tool | Prism Equivalent | Parity | Notes |
|---|---|---|---|
| `GitDiffTool` | `git_diff` | ✅ Match | View diffs (staged, unstaged, between commits) |
| — | `git_status` | ✅ **Extra** | Structured git status — CC uses `BashTool` |
| — | `git_log` | ✅ **Extra** | Structured git log — CC uses `BashTool` |
| — | `enter_worktree`, `exit_worktree` | ✅ **Extra** | Self-isolate into a git worktree for safe experimentation. CC workers use worktrees but the main agent cannot self-isolate |

**Architectural note:** CC exposes only `GitDiffTool` as a dedicated tool — all other git operations go through `BashTool`. Our dedicated git tools (`git_status`, `git_diff`, `git_log`) return structured JSON that renders via specialized `ToolResultRenderers` in Retina, providing much richer UI than raw terminal output.

#### MCP (Model Context Protocol)

| Claude Code Tool | Prism Equivalent | Parity | Notes |
|---|---|---|---|
| `MCPTool` | MCP tools auto-injected as `mcp__{server}__{tool}` | ✅ Match | Different mechanism, same result. CC has an explicit `MCPTool` wrapper; we inject MCP tools directly into the agent's tool array via namespacing. The agent calls them by name without knowing they're MCP-backed |
| `ListMcpResourcesTool` | `list_mcp_resources` | ✅ Match | Lists MCP Resources (read-only data sources). Supports querying all connected servers or a specific one. Gracefully handles servers that don't implement the Resources API (JSON-RPC -32601) |
| `ReadMcpResourceTool` | `read_mcp_resource` | ✅ Match | Reads MCP resource content by URI. Strips blob data to prevent context overflow, flattens single-text responses for cleaner LLM consumption |
| `McpAuthTool` | `mcp_authenticate` | ✅ Match | Authenticates with MCP servers. Supports bearer tokens, API keys, and environment variable injection. Reconnects the server with updated credentials. CC's approach is similar (credential injection + reconnect) |

**Architectural note:** Our MCP tool calling differs architecturally from CC's but is functionally equivalent. CC has a single `MCPTool` that the agent explicitly invokes with `{ server_name, tool_name, args }`. We inject MCP tools directly into the tool array as `mcp__{server}__{tool}`, so the LLM calls them like any other tool — transparent routing via `MCPClientService.isMCPTool()` + `parseMCPToolName()`. This is arguably cleaner because the LLM doesn't need to know about MCP as a concept — it just sees tools.

#### Orchestration & Multi-Agent

| Claude Code Tool | Prism Equivalent | Parity | Notes |
|---|---|---|---|
| `AgentTool` | `spawn_agent` | ✅ Match | Spawn autonomous worker agents with task description and optional file paths |
| `SendMessageTool` | `send_message` | ✅ Match | Continue a running worker with additional instructions |
| — | `stop_agent` | ✅ **Extra** | Gracefully stop a running worker — CC lacks an explicit stop tool (workers run to completion) |
| `TaskOutputTool` | `task_output` | ✅ Match | Read worker agent output. Returns full result if completed, or partial output (last 2000 chars) if still running. Coordinator-only tool |
| `TeamCreateTool` | — | ❌ Not adopted | See Appendix B — our coordinator handles worker management without a persistent team abstraction |

**Architectural note:** Our coordinator has a key advantage over CC: **git worktree isolation**. CC runs all workers against the same filesystem, creating potential file conflicts. Our workers each get an isolated git worktree branch, preventing interference. We also distribute workers across multiple local provider instances (least-busy routing), which CC doesn't support.

#### Meta, Memory & Control Flow

| Claude Code Tool | Prism Equivalent | Parity | Notes |
|---|---|---|---|
| `ThinkTool` | `think` | ✅ Match | Extended reasoning scratchpad — contents not shown to user, used for complex multi-step planning |
| `TodoWriteTool` | `todo_write` | ✅ Match | Persistent session-based checklist with `pending`/`in_progress`/`completed` status. Emits `todo_update` SSE event to Retina for live UI rendering |
| `BriefTool` | `brief` | ✅ Match | Context summarization — private working memory for long sessions. Agent writes compressed summaries with key files, open questions, and progress. Emits `brief_update` SSE event |
| `AskUserQuestionTool` | `ask_user_question` | ✅ Match | Pauses the agentic loop to present a question to the user. Supports freeform text or multiple-choice via `choices` array. Uses the same Promise-based pause/resume pattern as tool approvals. 5-minute timeout with graceful fallback |
| `MemoryTool` (read/write) | `upsert_memory`, `search_memories`, `delete_memory` | ✅ **Superior** | CC has a single `MemoryTool` with read/write. We have 3 dedicated memory tools + a 5-store cognitive memory architecture (episodic, semantic, procedural, prospective, working). See Section 7.7 for deep comparison |
| — | `sleep` | ✅ **Extra** | Pause execution for a specified duration — useful for rate limiting and polling |
| — | `enter_plan_mode`, `exit_plan_mode` | ✅ **Extra** | Toggle planning mode from within the agentic loop — no CC equivalent (CC's planning is UI-triggered only) |
| — | `synthetic_output` | ✅ **Extra** | Emit structured JSON output for programmatic consumption — no CC equivalent |
| — | `skill_create`, `skill_execute`, `skill_list`, `skill_delete` | ✅ **Extra** | Full CRUD for project-scoped skills — no CC equivalent (CC skills are file-based, read-only) |

**Architectural note for `ask_user_question`:** This implements a **pause/resume loop** using the `pendingQuestions` registry in `AgenticLoopService` (same pattern as `pendingApprovals`). The agent calls the tool → handler emits `user_question` SSE event → Retina renders UI → user submits → `POST /agent/answer` resolves the pending promise → loop continues. This is architecturally identical to CC's implementation but adapted for our HTTP request lifecycle (CC's REPL loop is always alive).

#### Task Management (Persistent Working Memory)

| Claude Code Tool | Prism Equivalent | Parity | Notes |
|---|---|---|---|
| `TodoWriteTool` | `todo_write` (Prism-local) | ✅ Match | Session-scoped checklist |
| — | `task_create`, `task_get`, `task_list`, `task_update` | ✅ **Superior** | Full persistent task system in MongoDB with status tracking, metadata, project-scoped isolation, filterable queries. CC's `TodoWriteTool` is session-only; our `AgenticTaskService` persists across sessions |

**Architectural note:** We have TWO task systems: (1) `todo_write` (Prism-local, session-scoped, matches CC's `TodoWriteTool`) for lightweight checklists, and (2) `AgenticTaskService` (MongoDB-backed, persistent, 4 CRUD tools) for complex multi-session workflows. CC only has option 1.

#### Summary: Parity Status

| Category | CC Tools | Prism Tools | Status |
|---|---|---|---|
| Filesystem & Editing | 3 (Read, Write, Edit) | 9 (read_file, write_file, str_replace_file, patch_file, multi_file_read, file_info, file_diff, move_file, delete_file) | ✅ **Superior** |
| Code Intelligence | 3 (Grep, Glob, List) | 5 (grep_search, glob_files, list_directory, project_summary, lsp_action) | ✅ **Superior** |
| Execution | 2 (Bash, REPL) | 4 (execute_shell, run_command, execute_python, execute_javascript) | ✅ **Superior** |
| Web & Network | 2 (WebFetch, WebSearch) | 3 (fetch_url, web_search, browser_action) | ✅ **Superior** |
| Git | 1 (GitDiff) | 5 (git_status, git_diff, git_log, enter_worktree, exit_worktree) | ✅ **Superior** |
| MCP | 4 (MCPTool, ListResources, ReadResource, Auth) | 3 + transparent injection (list_mcp_resources, read_mcp_resource, mcp_authenticate, + auto-injected tools) | ✅ **Match** |
| Orchestration | 3 (Agent, SendMessage, TaskOutput) | 4 (spawn_agent, send_message, stop_agent, task_output) | ✅ **Superior** |
| Meta & Control | 4 (Think, TodoWrite, Brief, AskUser) | 10 (think, todo_write, brief, ask_user_question, sleep, enter_plan_mode, exit_plan_mode, synthetic_output, skill_*) | ✅ **Superior** |
| Memory | 1 (MemoryTool) | 3 (upsert_memory, search_memories, delete_memory) | ✅ **Superior** |

**Total: 23 CC tools → 46+ Prism tools.** Full coverage with significant depth advantages in filesystem operations, code intelligence (LSP), execution sandboxing, git integration, and memory architecture.

---

## 4. Advanced Architectural Paradigms

### ✅ Bridge Mode (Already Implemented)

Retina (Web UI) connects to Prism (local gateway) over WebSocket. This is the existing architecture — Retina issues requests, Prism executes tools locally, streams results back. REST SSE via `/agent` provides an alternative for server-to-server callers.

### ✅ UltraPlan (Planning Mode)

For tasks requiring extensive reasoning, the agent enters a dedicated planning loop:

1. ✅ Retina UI toggle activates "Plan First" mode (`planFirst` state in `AgentComponent`)
2. ✅ Prism injects a planning-specific system prompt via `PlanningModeService.preparePlanningPass()` — tools stripped
3. ✅ System prompt assembly runs on planning pass too (via `beforePrompt` hook)
4. ✅ Plan is presented to the user in Retina via `PlanCardComponent` for review/approval
5. ✅ Only after explicit approval does execution begin (120s timeout, registry-based approval via `resolveApproval`)
6. ✅ Approved plan injected as context via `PlanningModeService.buildExecutionMessages()`

**Implementation**: Retina UI flag → Prism wraps the first LLM call with a planning system prompt → response rendered via `PlanCardComponent` → approved plan injected as context for execution calls.

### ✅ Coordinator Mode (Multi-Agent Orchestration)

The coordinator (lead agent) breaks complex tasks apart, spawns parallel workers in isolated git worktrees, collects results. Adapted from Claude Code's public `coordinatorMode.ts`, `src/utils/swarm/`, `AgentTool/`, `TeamCreateTool/`, and `SendMessageTool/` patterns.

**Paradigm**: Chat-triggered subagent orchestration. The LLM itself decides when to fan out by calling `spawn_agent`, `send_message`, and `stop_agent` tools — identical to how Claude Code's coordinator uses `Agent`, `SendMessage`, and `TaskStop` tool calls.

**Architecture**:
Chat Message → Coordinator System Prompt Injection → LLM calls `spawn_agent` tool → Worker spawned with own `AgenticLoopService.runAgenticLoop()` in isolated git worktree → Worker autonomously uses full tool suite → Worker completes → `<task-notification>` XML notification injected as user-role message into coordinator's conversation → Coordinator synthesizes results → Optionally continues worker via `send_message` → User reviews unified diffs → Approve & Merge

**Implementation** (all ✅):

| Component                      | Description                                                                                                                                                                                                         | Key Files                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Coordinator Tools**          | `spawn_agent`, `send_message`, `stop_agent` tool schemas + dispatch via `ToolOrchestratorService`                                                                                                                   | `ToolSchemaService`, `ToolOrchestratorService`, `AutoApprovalEngine` |
| **Worker Execution Engine**    | `AgenticLoopService.runAgenticLoop()` in `_runWorkerLoop()` with per-worker conversation context, AbortController, auto-approve, scoped tools                                                                       | `CoordinatorService.js`                                              |
| **Coordinator System Prompt**  | Adapted from Claude Code's `getCoordinatorSystemPrompt()`: 4-phase workflow, verification guidance, failure handling, stopping workers, synthesization rules, purpose statements, continue-vs-spawn decision matrix | `CoordinatorPrompt.js`, `SystemPromptAssembler.js`                   |
| **Task Notification Pipeline** | `<task-notification>` XML generation via `buildTaskNotification()` + injection into coordinator's active conversation as user-role messages via `injectMessage()` + `_notifyWake()`                                 | `AgenticLoopService.js`, `CoordinatorService.js`                     |
| **Worker Isolation**           | Git worktree-based isolation — each worker runs in its own branch/directory, preventing file conflicts                                                                                                              | `AgenticGitService.js`, `CoordinatorService.js`                      |
| **Instance Pooling**           | Workers distributed across all available local provider instances (e.g. multiple LM Studio), with least-busy routing and fallback to cloud models                                                                   | `CoordinatorService.js`, `instance-registry.js`                      |
| **Retina UI**                  | Live worker status cards, tool result renderers for spawn/send/stop, `worker_notification` SSE events                                                                                                               | `AgentComponent.js`, `ToolResultRenderers.js`                        |
| **Worker Persistence**         | Worker snapshots persisted to parent session in MongoDB for page refresh survival                                                                                                                                   | `AgenticLoopService.js`                                              |

**Coordinator System Prompt Coverage** (all ✅, adapted from Claude Code):

| Section                   | Description                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| Role definition           | Coordinator identity, synthesize-don't-delegate philosophy                                  |
| Tool documentation        | `spawn_agent`, `send_message`, `stop_agent` with usage rules                                |
| Notification format       | `<task-notification>` XML schema with field descriptions                                    |
| 4-phase workflow          | Research → Synthesis → Implementation → Verification                                        |
| Concurrency rules         | Read-only parallel, write-heavy serial, verification independent                            |
| Verification quality      | "Proving the code works" — run tests with feature enabled, investigate errors, be skeptical |
| Failure handling          | Continue failed workers via `send_message` (they have error context)                        |
| Stopping workers          | `stop_agent` usage with example (direction change mid-flight)                               |
| Synthesization rules      | Anti-patterns ("based on your findings"), good/bad examples                                 |
| Purpose statements        | Calibrate worker depth: research vs implementation vs quick check                           |
| Continue vs. spawn matrix | 6-row decision table based on context overlap                                               |
| Worker prompt tips        | File paths, "done" criteria, verification depth, git precision                              |

**Notification Flow** (how worker results reach the coordinator):

```
Worker completes → buildTaskNotification(worker) generates XML
                 → coordinatorCtx.injectMessage(notification)
                 → pushes to injectedMessages[] queue with _taskNotification: true
                 → _notifyWake() fires to wake coordinator's wait loop
                 → coordinator drains queue after tool batch or wait loop
                 → emits worker_notification SSE event to Retina
                 → re-prompts model with notifications as user-role messages
```

**Key point**: Workers do NOT receive `<task-notification>` messages. They run self-contained agentic loops with standard `tool_result` messages. The coordinator is the only recipient of task notifications — one per worker completion.

**Architectural Differences: Claude Code vs Prism**:

Claude Code is a CLI REPL — its main loop is always alive, waiting for user input. Prism is an HTTP server — each agentic loop runs to completion within a single request lifecycle.

| Aspect                    | Claude Code (CLI REPL)                                                                                                    | Prism (HTTP Request)                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Loop lifecycle**        | Always alive — REPL event loop waits for input indefinitely                                                               | Terminates — agentic loop exits when model returns text                                                                                                                                               |
| **Notification delivery** | `enqueueAgentNotification()` pushes `<task-notification>` XML into the session's `inputQueue` as a synthetic user message | `injectMessage()` pushes `<task-notification>` XML to an in-memory array + fires `_notifyWake()` to wake a suspended Promise inside the loop                                                          |
| **Coordinator wait**      | Implicit — the REPL is always listening                                                                                   | Explicit — loop checks `CoordinatorService.listWorkers()` and suspends via `await new Promise()` with event-driven wake + 2s safety poll + 5min hard timeout                                          |
| **Re-prompting**          | The notification appears as the next user turn                                                                            | After draining notifications into `currentMessages`, the loop `continue`s to re-prompt the model                                                                                                      |
| **Concurrency model**     | Workers run as background tasks with their own `AbortController`                                                          | Workers run as concurrent async loops (in-process) via `_runWorkerLoop()`, each with isolated conversation context. Distributed across all available local provider instances with least-busy routing |

**Reference URLs** (Claude Code source, studied for this design):

- Coordinator system prompt & mode: https://github.com/razakiau/claude-code/blob/main/src/coordinator/coordinatorMode.ts
- AgentTool (spawn, async lifecycle, notification enqueue): https://github.com/razakiau/claude-code/blob/main/src/tools/AgentTool/AgentTool.tsx
- `runAsyncAgentLifecycle` + `enqueueAgentNotification` + `finalizeAgentTool`: https://github.com/razakiau/claude-code/blob/main/src/tools/AgentTool/agentToolUtils.ts
- Swarm utilities directory (inProcessRunner, spawnInProcess, teamHelpers, etc.): https://github.com/razakiau/claude-code/tree/main/src/utils/swarm

**Design decisions**:

- **Git worktrees retained** — our differentiator over Claude Code. CC runs all workers against the same filesystem. Our worktree isolation means workers literally cannot interfere with each other
- **In-process async** — workers are concurrent async loops in the same Node.js process (like Claude Code's `inProcessRunner`), not separate processes. Each gets isolated conversation context
- **Workers cannot spawn sub-workers** — `spawn_agent`/`send_message`/`stop_agent` excluded from worker tool sets to prevent recursion
- **Coordinator is a mode, not a persona** — the coordinator system prompt is injected as an addendum to the existing `CODING` persona when coordinator tools are available, not a separate identity
- **File paths optional for chat-triggered flow** — the coordinator LLM discovers files via its existing tools (`project_summary`, `grep_search`). Manual panel still requires explicit file paths

### ✅ Multi-System Cognitive Memory Architecture

Prism implements a **5-store memory system** inspired by Tulving's memory taxonomy and Baddeley's working memory model. Each store serves a distinct cognitive function, with `WorkingMemoryService` acting as the central executive that orchestrates retrieval across all long-term stores.

#### Memory Stores

| Store | Service | Collection | Analog | Purpose |
| ----- | ------- | ---------- | ------ | ------- |
| **Episodic** | `EpisodicMemoryService` | `memory_episodic` | "What happened" | Session narratives with temporal context, outcomes, participants, and cross-references to extracted memories |
| **Semantic** | `SemanticMemoryService` | `memory_semantic` | "What I know" | Stable, decontextualized knowledge — facts, preferences, rules, references. Includes confidence scoring (Ebbinghaus-inspired decay), reinforcement counting, and contradiction tracking |
| **Procedural** | `ProceduralMemoryService` | `memory_procedural` | "How to do it" | Learned tool sequences and problem-solving patterns. Stores trigger → step sequence → tool chain, with success/failure rate tracking |
| **Prospective** | `ProspectiveMemoryService` | `memory_prospective` | "Remember to remember" | Future intentions with time-based and cue-based triggers. Checked on every session start; auto-expires after configurable TTL (default 7 days) |
| **Working** | `WorkingMemoryService` | `memory_working` | Baddeley's central executive | Session-scoped, capacity-limited (18 slots). Orchestrates parallel retrieval from all 4 long-term stores, ranks by composite score, and formats for prompt injection |

#### Memory Extraction Pipeline

`MemoryExtractor` (replaces the former `SessionSummarizer`) runs as a fire-and-forget `afterResponse` hook. Uses Claude Haiku to extract three categories from each conversation:

1. **Episode** → `EpisodicMemoryService.store()` — narrative, outcome (resolved/partial/abandoned/deferred), satisfaction, key decisions, tags
2. **Semantic memories** → `SemanticMemoryService.store()` — with duplicate detection (cosine > 0.92 → reinforce instead of create). Also dual-writes to legacy `MemoryService` for backward compatibility
3. **Procedural memories** → `ProceduralMemoryService.store()` — trigger, step-by-step procedure, tool sequence

Cross-references: episode IDs linked to extracted semantic/procedural IDs via `EpisodicMemoryService.linkExtracted()`.

#### Prompt Injection Flow

```
User message → SystemPromptAssembler.fetchMemories()
            → WorkingMemoryService.load({ queryText })
            → Promise.all([
                SemanticMemoryService.search()   → context slots
                EpisodicMemoryService.search()   → experience slots
                ProceduralMemoryService.search() → procedure slots
                ProspectiveMemoryService.checkTriggers() → reminder slots (always priority)
              ])
            → Capacity management: top 18 slots by composite score
            → Formatted as ## sections: Pending Reminders, Known Facts, Relevant Past Sessions, Learned Procedures
            → Injected into system prompt as ## Agent Memory
```

Fallback: If `WorkingMemoryService` fails, `SystemPromptAssembler` falls back to legacy `MemoryService.search()` flat retrieval.

#### Confidence & Scoring

**Semantic memories** use an Ebbinghaus-inspired confidence model:
- Base confidence starts at 0.5, increases by 0.1 per reinforcement (capped at 1.0)
- Contradiction penalty: -0.15 per contradiction
- Time decay: `e^(-t/S)` where S = 10 + reinforcementCount × 5 (more reinforcement = slower decay)
- Search composite: 70% similarity + 20% confidence + 10% reinforcement bonus

**Procedural memories** weight by success rate:
- Search composite: 70% similarity + 30% success rate
- Success/failure tracked per procedure, used to surface reliable patterns

**Episodic memories** use logarithmic recency:
- Search composite: 80% similarity + 20% recency boost (1/log₂(ageDays + 1))

#### Memory Consolidation ✅

Autonomous background process that clusters, merges, and prunes accumulated **legacy** memories using Union-Find clustering on embeddings:

- `MemoryConsolidationService.js`: Clusters by cosine similarity, sends clusters to Claude Haiku for merge/delete/keep analysis, applies actions, records audit trail in `memory_consolidation_history` collection
- **Scheduled loop**: `setInterval` in `index.js` runs every 6 hours, processes all projects with 10+ memories (trigger: `scheduled`)
- **Cost guard**: `DAILY_MAX_CONSOLIDATIONS = 3` per project per day to prevent API credit burn
- **Audit trail**: Every run recorded with trigger type, memory counts (before/after), actions applied, duration, summary
- **Real-time feedback**: `broadcast` callback wired through `MemoryExtractor` → `ctx.emit` pushes `memory_consolidation_complete` events to Retina via WebSocket
- **API**: `GET /agent-memories/consolidation-history?project=X&limit=5`
- **UI**: `MemoriesPanel.js` has collapsible Consolidation History section with trigger badges (Manual / Scheduled / Session), timeline entries, and auto-refresh on consolidation events via `consolidationEvent` prop
- **Triggers**: Manual (POST endpoint), scheduled (6h interval), session-threshold (after N sessions via MemoryExtractor)

**Files**: `MemoryExtractor.js`, `EpisodicMemoryService.js`, `SemanticMemoryService.js`, `ProceduralMemoryService.js`, `ProspectiveMemoryService.js`, `WorkingMemoryService.js`, `MemoryService.js` (legacy), `MemoryConsolidationService.js`, `SystemPromptAssembler.js`

### ✅ Context Window Management

`ContextWindowManager` (utility class, no external dependencies) prevents context overflow in long-running agentic loops. Applied before every LLM call within `AgenticLoopService`, including the exhaustion recovery pass.

**Strategy cascade** (in priority order):

1. **Tool Result Truncation** — Caps old tool results at 3,000 chars; preserves last 4 user turns in full
2. **Assistant Message Compression** — Replaces old assistant content with summary markers, preserving tool call names but dropping results
3. **Sliding Window** — Drops middle turns entirely, keeping system prompt + first user message + recent tail

**Configuration**: `~3.5 chars/token` estimation, `80%` utilization target, `8,192` minimum output reserve, `2,000 + (toolCount × 150)` schema overhead tokens. Per-model context window via `modelDef.maxInputTokens`.

**Files**: `prism/src/utils/ContextWindowManager.js`

### ✅ Benchmarking System

Custom LLM accuracy benchmarking for evaluating model performance across providers:

- `BenchmarkService.js`: Orchestrates test execution against multiple models. Provider-bucketed concurrent execution (different providers run in parallel; models within the same provider run sequentially with 100ms stagger). Local GPU models grouped into a single sequential bucket.
- **Multi-assertion evaluation**: Supports `CONTAINS`, `EXACT`, `STARTS_WITH`, `REGEX` match modes with AND/OR assertion operators
- **Cost tracking**: Per-model estimated cost, GPU mutex via `LocalModelQueue` to prevent benchmark/chat collisions
- **Abort support**: `AbortController` signal propagates across all provider buckets for clean cancellation
- **REST API**: Full CRUD benchmarks + runs via `/benchmark` endpoints
- **UI**: Full benchmark dashboard in Retina (`BenchmarkDashboardComponent`, `BenchmarkPageComponent`, `BenchmarkFormComponent`, etc.)
- **Collections**: `benchmarks`, `benchmark_runs`

**Files**: `prism/src/services/BenchmarkService.js`, `prism/src/routes/benchmark.js`, `retina/src/components/Benchmark*.js`

### ✅ Visual Workflow System

Node-based visual workflow engine for multi-step AI pipelines:

- `WorkflowAssembler.js`: Assembles visual graph from raw step data. Each step produces text input nodes, conversation nodes (with compound ports), model nodes (with config-derived modality ports), output viewer nodes, and chain edges between non-utility steps.
- `workflows.js` route: Full CRUD (`GET`, `POST`, `PUT`, `DELETE`) + conversation linking (`PATCH`). Supports two payload formats: raw steps (assembled server-side) and pre-built graphs (passthrough from Retina editor). MinIO file extraction for base64 data URLs in nodes/results.
- **UI**: Full visual editor in Retina — `WorkflowCanvas`, `WorkflowNode`, `WorkflowInspector`, `WorkflowSidebar`, `WorkflowHeaderStatsComponent`. Separate pages for list, detail, and editor views.
- **Cost tracking**: Derived from linked conversation `totalCost` values

**Files**: `prism/src/services/WorkflowAssembler.js`, `prism/src/routes/workflows.js`, `retina/src/components/Workflow*.js`

---

## 5. Permissions & Safety

### ✅ Auto-Approval Engine (Three-Tier System)

A **rule-based** permission system for tool execution, replacing the need for expensive LLM-based classification:

| Tier                      | Risk                    | Tools                                                                                                                                                                                                                                             | Behavior                                                            |
| ------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Tier 1: Auto-Approve**  | Read-only / Scratchpad  | `read_file`, `list_directory`, `grep_search`, `glob_files`, `web_search`, `fetch_url`, `multi_file_read`, `file_info`, `file_diff`, `git_status`, `git_diff`, `git_log`, `project_summary`, `task_create`, `task_get`, `task_list`, `task_update` | Always execute without prompting                                    |
| **Tier 2: Configurable**  | Write                   | `write_file`, `str_replace_file`, `patch_file`, `move_file`, `delete_file`, `browser_action`                                                                                                                                                      | Auto-approve when user enables "Auto Mode" toggle; otherwise prompt |
| **Tier 3: Always Prompt** | Destructive / Arbitrary | `execute_shell`, `execute_python`, `execute_javascript`, `run_command`                                                                                                                                                                            | Always require explicit user approval                               |

**Implementation**: ✅ Integrated via the `beforeToolCall` hook in `AgentHooks`. Default tier assignments in `AutoApprovalEngine.js`. Unknown tools default to Tier 2. `ApprovalCardComponent` renders approval UI in Retina. "Approve All" option (`approveAll`) promotes all remaining tools to auto-approve for the rest of the session. 🔲 Per-tool tier overrides in Retina settings UI not yet built (constructor accepts `tierOverrides` but no UI exposes it).

**Escape hatch**: ✅ `fullAuto` mode (via `options.autoApprove`) promotes all tools to Tier 1. 🔲 Retina confirmation dialog for activating Full Auto not yet implemented.

---

## 6. Engineering Guardrails

Principles to avoid common pitfalls seen in rigid agent codebases:

### ✅ Explicit State Machines over Ad-Hoc Control Flow

The `AgenticLoopService` implements a structured loop with clear state transitions via hooks and iteration tracking:

```
IDLE → ASSEMBLING (beforePrompt) → CONTEXT_ENFORCEMENT → STREAMING → TOOL_GATING (beforeToolCall/approval) → TOOL_EXECUTING → afterToolCall → STREAMING → ... → EXHAUSTION_CHECK → FINALIZING (afterResponse) → IDLE
```

Planning mode adds a pre-loop state: `PLANNING → PLAN_APPROVAL → EXECUTING`. The `isGenerating` flag and `finally` cleanup ensure clean state transitions even on errors/aborts. `pendingApprovals` Map is cleaned up in `finally` to prevent dangling promises.

### ✅ Raw Token Integrity

Prism streams raw chunks (`emit({ type: "chunk", content })`) without transformation. All rendering (markdown, syntax highlighting, ANSI colors) happens client-side in Retina. This separation must be maintained — Prism should never mutate token content. The `/agent` SSE endpoint strips heavy base64 image data when `minioRef` is available, sending lightweight references instead.

### ✅ Memory as a First-Class Citizen

Prism implements a 5-store cognitive memory architecture (episodic, semantic, procedural, prospective, working) inspired by Tulving's memory taxonomy and Baddeley's working memory model. `WorkingMemoryService` acts as the central executive — orchestrating parallel retrieval from all 4 long-term stores into capacity-limited (18-slot) workspaces. Integrated into `SystemPromptAssembler.fetchMemories()` via `WorkingMemoryService.load()`, with fallback to legacy `MemoryService.search()`. See Section 4 "Multi-System Cognitive Memory Architecture" for full details.

### ✅ Client-Server Tool Decoupling

`ToolOrchestratorService` dynamically fetches schemas from `tools-api` at boot and proxies execution. Tool definitions live entirely in `tools-api` — Prism is transport-agnostic. This decoupling allows `tools-api` to add new tools without Prism changes. MCP tools are transparently routed via `MCPClientService`.

### ✅ Request Logging & Cost Tracking

Every agentic iteration is individually logged via `RequestLogger.logChatGeneration()` with per-pass usage metrics, iteration number, tool calls, and estimated cost. Overall usage aggregates across all iterations with `requests` count. Pricing derived from `config.js` model definitions.

---

## Strategic Roadmap for Prism & Retina

### Phase 1: Foundation & Planning ✅ COMPLETE

1. ✅ **Event Hook System** — `AgentHooks` (`EventEmitter`-based) with `beforePrompt`, `beforeToolCall`, `afterToolCall`, `afterResponse`, `onError` lifecycle events
2. ✅ **Dynamic System Prompt Assembly** — `SystemPromptAssembler`: agent identity + coding guidelines + tool schemas (domain-grouped) + project structure + skills (embedding-filtered) + environment + memory
3. ✅ **Auto-Approval Engine** — `AutoApprovalEngine`: three-tier system with `beforeToolCall` hook + `ApprovalCardComponent` UI + "Approve All" escalation
4. ✅ **UltraPlan Mode** — `PlanningModeService` + `PlanCardComponent`: plan → approve → execute workflow
5. ✅ **Memory Extraction** — `MemoryExtractor` (replaces `SessionSummarizer`): Claude Haiku extraction → 3-category multi-store pipeline (episodic + semantic + procedural) → MongoDB

### Phase 2: Memory & Extensibility ✅ COMPLETE (5/6)

1. ✅ **Generalized MemoryService** — `AgentMemoryService` (legacy): project-scoped, embedding-based, 4-type taxonomy, duplicate detection
2. ✅ **Multi-System Cognitive Memory** — 5-store architecture: `EpisodicMemoryService`, `SemanticMemoryService`, `ProceduralMemoryService`, `ProspectiveMemoryService`, `WorkingMemoryService` (central executive). `MemoryExtractor` replaces `SessionSummarizer` with multi-store extraction pipeline. `SystemPromptAssembler` wired to `WorkingMemoryService.load()` with legacy fallback
3. ✅ **Skills System** — DB-backed per-project skills with embedding-based relevance filtering, CRUD via `/skills` API, SkillsPanel UI, injected into system prompt
4. ✅ **Tool Rendering Registry** — `ToolResultRenderers.js`: registry-based rendering with specialized components per tool domain
5. ✅ **MCP Client** — Prism connects to external MCP servers for third-party tool access
6. 🔲 **Slash Commands** — Parameterized prompt templates with argument substitution

### Phase 3: Multi-Agent & Autonomy ✅ COMPLETE

1. ✅ **Coordinator Mode** — Full implementation: `CoordinatorService`, `CoordinatorPrompt`, worker execution engine, task notification pipeline, instance pooling, git worktree isolation, Retina UI
2. ✅ **Mutation Queue** — `MutationQueue.js`: per-path FIFO mutex singleton for concurrent write safety
3. ✅ **Memory Consolidation** — `MemoryConsolidationService`: scheduled 6h loop, audit trail, cost guard, real-time broadcast, UI history panel
4. ✅ **Browser Automation** — `AgenticBrowserService`: Playwright integration with `browser_action` tool, DOM inspection, screenshot persistence

### Phase 4: Hardening & Intelligence ✅ COMPLETE (8/13)

1. ✅ **Token-Budget Truncation** — `ContextWindowManager`: three-strategy cascade wired into `AgenticLoopService` before every LLM call
2. ✅ **Dedicated Agent Endpoint** — `POST /agent` with SSE streaming + JSON fallback, approval endpoint
3. ✅ **Exhaustion Recovery** — Final tool-free LLM pass on iteration limit, summarizes progress for user
4. ✅ **Local GPU Mutex** — `LocalModelQueue`: process-level lock preventing GPU collisions across chat + benchmark
5. ✅ **Request Iteration Logging** — Per-pass `RequestLogger.logChatGeneration()` with agenticIteration number
6. ✅ **Benchmarking System** — `BenchmarkService`: custom LLM accuracy benchmarking with multi-model comparison
7. ✅ **Visual Workflow System** — `WorkflowAssembler` + `workflows.js`: node-based visual graph engine
8. ✅ **Task & State Management** — `AgenticTaskService`: MongoDB-backed persistent task list with 4 tools
9. 🔲 **Slash Commands** — Parameterized prompt templates with `$1`, `$@` argument substitution
10. 🔲 **Per-Tool Tier Overrides UI** — Retina settings panel to customize Auto-Approval tiers per tool
11. 🔲 **Coordinator Conflict Resolution** — Interactive diff merge UI for worktree conflicts
12. 🔲 **Full Auto Confirmation Dialog** — Retina modal confirming the user wants to activate `autoApprove` mode
13. 🔲 **Background Execution Monitoring** — `capture_terminal` tool for inspecting daemon process output

### Phase 5: Process Reliability & Lifecycle (from Claude Code Analysis)

Tasks identified via deep comparison with Claude Code's `src/utils/` infrastructure. Prioritized by impact on robustness.

1. ✅ **AbortController Tree** — `createAbortController()` + `createChildAbortController(parent)` in `utils/AbortController.js`. WeakRef-based GC-safe propagation with module-scope bound handlers. Threaded through `ToolOrchestratorService` (tool fetch calls abort on session cancel), `SseUtilities` (SSE session controllers), `CoordinatorService` (worker controllers), `SystemPromptAssembler`, and `benchmark.js`. AbortError handling in `fetchJson`/`fetchJsonPost`.
2. ✅ **Cleanup Registry** — `utils/CleanupRegistry.js`: global `Set<fn>` singleton with `registerCleanup()` / `runCleanupFunctions()`. `installShutdownHandlers()` wired in `index.js` — handles SIGTERM/SIGINT with 5s hard timeout. Registered services: `CoordinatorService` (abort workers + remove worktrees), `MCPClientService` (disconnect all servers + kill stdio transports), `benchmark.js` (abort active runs).
3. ✅ **Background Housekeeping** — `BackgroundHousekeepingService`: boot-time worktree pruning (`/tmp/prism-worktrees/` > 24h), periodic stale session/request-log cleanup (6h interval), MinIO orphan purge, stale `isGenerating` flag cleanup. Wired in `index.js` as boot-time fire-and-forget + 6h `setInterval`.
4. ✅ **Process Kill Endpoint** — `POST /agentic/command/kill` in `tools-api`: process-tree kill via `killProcessTree()` in `AgenticCommandService.js`. SIGTERM with 3s grace period, SIGKILL escalation. PID 1 and self-kill protection.
5. 🔲 **Session Resume Sanitization** — `filterUnresolvedToolUses()` pass on MongoDB session reload to prevent API errors from orphaned tool_use blocks. Reference: CC's `conversationRecovery.ts`
6. 🔲 **Interrupted Turn Detection** — Detect `interrupted_prompt` vs `interrupted_turn` states on session resume. Auto-inject "Continue from where you left off" for interrupted turns. QoL improvement

---

## 7. Claude Code Architectural Comparison

Deep comparative analysis against [razakiau/claude-code](https://github.com/razakiau/claude-code) (Anthropic's agentic coding tool snapshot). Studied component-by-component to identify architectural gaps, validate design choices, and surface patterns worth adopting.

### 7.1 Architecture Overview

| Aspect        | Claude Code                                                                                                               | Prism/Retina                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Runtime**   | Bun (single binary, TypeScript-native)                                                                                    | Node.js + Express + MongoDB                                     |
| **UI**        | React Ink (terminal TUI via `src/screens/`)                                                                               | React web UI (Retina, Next.js)                                  |
| **Transport** | CLI REPL with background UDS daemon                                                                                       | HTTP REST + WebSocket + SSE                                     |
| **State**     | File-based (JSONL transcripts, `~/.claude/`)                                                                              | MongoDB collections + MinIO                                     |
| **Memory**    | `src/memdir/` — file-based with `MEMORY.md` index, Sonnet side-query relevance selection, forked-agent extraction (prompt cache sharing), `autoDream` consolidation, 4-type taxonomy (`user`/`feedback`/`project`/`reference`), team memory scoping | 5-store cognitive architecture — MongoDB + embeddings, Ebbinghaus decay, `WorkingMemoryService` central executive, `MemoryExtractor` + `MemoryConsolidationService` |
| **Skills**    | `src/skills/` — `bundledSkills.ts` + `loadSkillsDir.ts` + `mcpSkillBuilders.ts`                                           | DB-backed per-project skills with embedding relevance filtering |
| **Plugins**   | `src/plugins/` — `bundled/` directory + `builtinPlugins.ts` registry                                                      | No plugin architecture (tools via `tools-api` schemas)          |
| **Tasks**     | `src/tasks/` — 5 polymorphic task runners                                                                                 | Single `AgenticLoopService` for all execution paths             |

### 7.2 Process Lifecycle & Abort Propagation

**Claude Code** (`src/utils/abortController.ts`): Implements a **WeakRef-based parent-child AbortController tree**. Key patterns:

- `createAbortController()` — factory with `setMaxListeners(50)` to prevent Node warnings
- `createChildAbortController(parent)` — child aborts when parent aborts, but NOT vice versa. Uses `WeakRef` so abandoned children can be GC'd without leaking parent listeners
- Module-scope `propagateAbort()` and `removeAbortHandler()` functions (bound via `.bind()`) avoid per-call closure allocation
- `combinedAbortSignal.ts` — merges multiple signals into one

**Claude Code** (`src/utils/cleanupRegistry.ts`): Global shutdown registry pattern:

```
registerCleanup(fn) → Set<() => Promise<void>>
runCleanupFunctions() → Promise.all(cleanupFunctions)
```

Any service can register a cleanup function; all run during graceful shutdown.

**Prism**: ✅ **Resolved** — `utils/AbortController.js` implements the same WeakRef-based parent-child tree with module-scope bound handlers. `utils/CleanupRegistry.js` provides the global shutdown registry with `installShutdownHandlers()` wired in `index.js`. Signal threading through `ToolOrchestratorService.fetchJson()`/`fetchJsonPost()`, `SseUtilities`, `CoordinatorService` (worker controllers), `SystemPromptAssembler`, and `benchmark.js`. AbortError handling returns clean `{ error: "Tool execution aborted" }` messages. See Phase 5.1 and 5.2 in the roadmap and Section 8 "Abort Propagation" for full implementation details.

### 7.3 Cleanup & Housekeeping

**Claude Code** (`src/utils/cleanup.ts`): Comprehensive background cleanup system — `cleanupOldMessageFilesInBackground()` orchestrates:

- `cleanupOldMessageFiles()` — purge error/MCP logs older than configurable `cleanupPeriodDays` (default 30)
- `cleanupOldSessionFiles()` — walk project dirs, remove stale `.jsonl`/`.cast` files + tool result subdirectories
- `cleanupOldPlanFiles()` — purge old `~/.claude/plans/*.md`
- `cleanupOldFileHistoryBackups()` — remove file-history session directories
- `cleanupOldSessionEnvDirs()` — remove stale session environment directories
- `cleanupOldDebugLogs()` — remove old debug logs, preserve `latest` symlink
- `cleanupOldImageCaches()` — purge image store
- `cleanupOldPastes()` — purge paste store
- **`cleanupStaleAgentWorktrees(cutoffDate)`** — critical: removes orphaned coordinator worktrees

**Claude Code** (`src/utils/backgroundHousekeeping.ts`): Scheduled background tasks that run during idle periods.

**Prism**: ✅ **Resolved** — `BackgroundHousekeepingService.js`: boot-time + 6h scheduled cleanup. Targets: orphaned worktrees (>24h), stale `isGenerating` flags (>2h), old request logs (>90 days), MinIO orphans (conversation-ID-scoped objects with no matching MongoDB document). Wired in `index.js` as fire-and-forget boot run + `setInterval`. Process kill via `POST /agentic/command/kill` in tools-api.

### 7.4 Conversation Recovery & Session Resume

**Claude Code** (`src/utils/conversationRecovery.ts`): Sophisticated session resume with:

- **Turn interruption detection** — 3-way state: `none`, `interrupted_prompt` (user sent text but assistant never responded), `interrupted_turn` (assistant was mid-tool-use)
- **Automatic continuation** — interrupted turns get a synthetic `"Continue from where you left off."` user message appended
- **Message sanitization pipeline** — `filterUnresolvedToolUses()` → `filterOrphanedThinkingOnlyMessages()` → `filterWhitespaceOnlyAssistantMessages()`
- **Skill state restoration** — `restoreSkillStateFromMessages()` rebuilds invoked skills from transcript attachments
- **Plan copying** — `copyPlanForResume()` associates plans with the resumed session
- **JSONL chain walking** — `buildConversationChain()` resolves UUID-linked message trees (supports forks/sidechains)
- **Metadata restoration** — agent name, color, custom title, coordinator mode, worktree session, PR info

**Prism equivalent**: MongoDB-backed session persistence via `finalizeTextGeneration()`. Sessions survive page refreshes (worker snapshots persisted to parent session). No turn interruption detection — if the user disconnects mid-tool, the next session starts fresh.

**Gap**: No automatic continuation of interrupted turns. No message sanitization for orphaned tool uses or thinking-only messages. No transcript chain resolution (we use flat arrays in MongoDB).

**Recommendation**: Lower priority — our MongoDB model is simpler and handles the common cases. Worth adding: (1) a `filterUnresolvedToolUses()` pass before resume to prevent API errors from orphaned tool_use blocks, (2) a "Continue from last session" option that detects interrupted state and auto-injects a continuation prompt. These are quality-of-life improvements, not blocking.

### 7.5 Polymorphic Task System

**Claude Code** (`src/tasks/`): Five distinct task runners sharing a common interface:

| Task Type               | Purpose                                   |
| ----------------------- | ----------------------------------------- |
| `LocalMainSessionTask`  | Primary interactive session (REPL)        |
| `LocalAgentTask`        | In-process sub-agent (coordinator worker) |
| `LocalShellTask`        | Shell-driven execution                    |
| `InProcessTeammateTask` | Shared-memory teammate (swarm member)     |
| `RemoteAgentTask`       | Cross-network agent execution             |
| `DreamTask`             | Background autonomous operation           |

Plus `stopTask.ts` (graceful shutdown), `pillLabel.ts` (UI label generation), `types.ts` (shared interface).

**Prism equivalent**: Single `AgenticLoopService.runAgenticLoop()` handles all execution paths. `CoordinatorService._runWorkerLoop()` wraps it for sub-agent use. No separate task types — the loop is parameterized via options (`autoApprove`, `workerTools`, `workerCwd`).

**Gap**: Prism's single-loop model is simpler but less extensible. Adding new execution modes (background dream tasks, remote agents) requires forking the loop or adding more options.

**Recommendation**: Not a current priority. Our single-loop + options pattern is sufficient for coordinator workers and direct chat. If we need `DreamTask`-style background autonomous operation or `RemoteAgentTask`-style cross-network execution later, consider abstracting a `TaskRunner` interface. For now, the simplicity is a feature.

### 7.6 Plugin Architecture

**Claude Code** (`src/plugins/`): Plugin system with `bundled/` directory and `builtinPlugins.ts` registry. Plugins can contribute tools, commands, and hooks.

**Prism equivalent**: No formal plugin architecture. Tool extensibility comes from: (1) `tools-api` dynamic schema loading, (2) MCP server connections, (3) custom tools in MongoDB.

**Gap**: No way for third parties to extend Prism's behavior beyond adding tools. Claude Code's plugins can modify the agent loop itself.

**Recommendation**: Lower priority. Our MCP client + custom tools + tools-api schema pattern provides the tool extensibility we need. A plugin system would only matter if we wanted to distribute Prism as a framework (not our current goal).

### 7.7 Persistent Memory Architecture — Deep Comparison

**Reference URLs** (Claude Code source, studied for this analysis):

- Memory directory core: https://github.com/razakiau/claude-code/blob/main/src/memdir/memdir.ts
- Memory type taxonomy: https://github.com/razakiau/claude-code/blob/main/src/memdir/memoryTypes.ts
- Memory extraction (forked agent): https://github.com/razakiau/claude-code/blob/main/src/services/extractMemories/extractMemories.ts
- Extraction prompts: https://github.com/razakiau/claude-code/blob/main/src/services/extractMemories/prompts.ts
- Relevance matching (Sonnet side-query): https://github.com/razakiau/claude-code/blob/main/src/memdir/findRelevantMemories.ts
- Memory scanning: https://github.com/razakiau/claude-code/blob/main/src/memdir/memoryScan.ts
- Memory age/decay: https://github.com/razakiau/claude-code/blob/main/src/memdir/memoryAge.ts
- Background consolidation: https://github.com/razakiau/claude-code/tree/main/src/services/autoDream
- Team memory paths: https://github.com/razakiau/claude-code/blob/main/src/memdir/teamMemPaths.ts

#### 7.7.1 Claude Code: File-Based `memdir` Architecture

CC uses a **flat file-based memory system** stored at `~/.claude/projects/<path>/memory/`. The architecture has three layers:

| Layer | System | Purpose |
| ----- | ------ | ------- |
| **Storage** | `memdir/` — Markdown files with YAML frontmatter | One `.md` file per memory, plus `MEMORY.md` index |
| **Extraction** | `extractMemories.ts` — forked agent | Runs a cloned agent after each turn to write memories |
| **Consolidation** | `autoDream/` — "dreaming" agent | Background consolidation during idle time |

**Memory Type Taxonomy** (4 types, flat — defined in `memoryTypes.ts`):

| CC Type | What it stores | Prism Equivalent Store |
| ------- | -------------- | --------------------- |
| `user` | User's role, goals, expertise, preferences | `SemanticMemoryService` (category: `preference`, `reference`) |
| `feedback` | Corrections + confirmations ("don't mock DB", "yes, bundled PR was right") | `ProceduralMemoryService` (learned approaches) + `SemanticMemoryService` (category: `rule`) |
| `project` | Non-derivable project context (deadlines, incidents, decisions) | `SemanticMemoryService` (category: `fact`) + `EpisodicMemoryService` (event context) |
| `reference` | Pointers to external systems (Linear projects, Grafana boards) | `SemanticMemoryService` (category: `reference`) |

**Explicit exclusions** from memory (defined in `WHAT_NOT_TO_SAVE_SECTION`):
- Code patterns, architecture, file paths (derivable via grep/git)
- Git history (use `git log` / `git blame`)
- Debugging solutions (fix is in the code)
- Anything already in `CLAUDE.md` files
- Ephemeral task details
- These exclusions apply **even when the user explicitly asks** — CC prompts the user for what was *surprising* or *non-obvious* instead

**Storage Format** — Each memory is a markdown file with frontmatter:

```markdown
---
name: user_role
description: User is a senior data scientist focused on observability
type: user
---
User is a data scientist investigating logging infrastructure.
```

The `MEMORY.md` index is a flat list of links — **not a memory itself**, but a manually-maintained index:
```markdown
- [User Role](user_role.md) — senior data scientist, observability focus
- [Testing Policy](feedback_testing.md) — no mocking databases
```
Capped at `MAX_ENTRYPOINT_LINES = 200` / `MAX_ENTRYPOINT_BYTES = 25,000`. Truncation warning injected if exceeded. `MEMORY.md` is always loaded into the system prompt (every turn), topic files are loaded selectively.

#### 7.7.2 CC Memory Extraction: Forked Agent Pattern

CC's `extractMemories.ts` implements the most architecturally interesting pattern — a **forked agent** that shares the parent's prompt cache:

1. **Forked agent** — `runForkedAgent()` creates a full clone of the current conversation that shares the parent's prompt cache key. This means the input tokens for extraction are **nearly free** (cache read tokens only)
2. **Sandboxed permissions** — the forked agent can only: read files, grep, glob, read-only bash, and write/edit files **within the memory directory**. Created via `createAutoMemCanUseTool(memoryDir)` which returns a `canUseTool` function
3. **Cursor-based** — tracks `lastMemoryMessageUuid` so each run only processes messages added since the last extraction
4. **Mutual exclusion** — if the main agent already wrote to the memory directory this turn (`hasMemoryWritesSince()`), the forked extraction is skipped entirely and the cursor is advanced past that range
5. **Coalescing** — if a second turn arrives while extraction is running, the context is stashed in `pendingContext` and a single trailing extraction runs after the current one finishes
6. **Hard-capped** at `maxTurns: 5` to prevent verification rabbit-holes
7. **Turn throttling** — configurable via feature flag `tengu_bramble_lintel` (default 1), allows running extraction every N eligible turns
8. **Drain hook** — `drainPendingExtraction()` called before graceful shutdown to await in-flight extractions with a soft timeout (default 60s)

**Key implementation detail**: The forked agent is a **full agentic loop** — it can read files, grep for existing memories, and decide whether to create new ones or update existing ones. It's not a simple prompt-and-parse extraction. The agent receives the full conversation context via prompt cache sharing, plus a pre-scanned manifest of existing memory files (via `scanMemoryFiles()` + `formatMemoryManifest()`), so it doesn't waste turns on `ls`.

#### 7.7.3 CC Memory Retrieval: Sonnet Side-Query

CC's `findRelevantMemories.ts` uses a **Sonnet side-query** (not just grep) for relevance matching:

1. `scanMemoryFiles()` walks the memory directory and reads YAML frontmatter (name, description, type) from each `.md` file
2. Formats all memory headers into a manifest string
3. Sends a `sideQuery()` to Sonnet with system prompt: *"You are selecting memories that will be useful to Claude Code as it processes a user's query"*
4. Sonnet returns up to 5 filenames as a JSON schema response
5. Recently-used tools are passed to the selector to **avoid re-surfacing API docs** for tools already in active use (keyword overlap false positive prevention)
6. `alreadySurfaced` set filters paths already shown in prior turns so the 5-slot budget is spent on fresh candidates
7. Selected files are read in full and injected into the conversation context

**Important**: CC does NOT use embeddings. Its retrieval is: (1) `MEMORY.md` always in system prompt (200-line index), (2) Sonnet-based relevance selection for topic files (up to 5 per turn), (3) Manual `grep` available via the model's own tool use. The Sonnet call costs tokens but leverages the model's semantic understanding — a middle ground between pure keyword search and embedding vectors.

#### 7.7.4 CC Memory Consolidation: AutoDream

CC's `autoDream/` directory implements background consolidation during idle time:

| File | Purpose |
| ---- | ------- |
| `autoDream.ts` | Main consolidation service — runs during idle periods |
| `config.ts` | Configuration (consolidation thresholds, intervals) |
| `consolidationLock.ts` | File-based lock preventing concurrent consolidation |
| `consolidationPrompt.ts` | Prompt template for the consolidation agent |

The autoDream service runs a consolidation agent that merges, deduplicates, and prunes memory files. Uses file-based locking to prevent concurrent consolidation across multiple CC instances.

**KAIROS mode**: For long-lived "assistant" sessions, CC switches to an append-only daily log format (`logs/YYYY/MM/YYYY-MM-DD.md`) instead of maintaining `MEMORY.md` directly. A separate nightly process distills logs into topic files. The prompt is date-pattern-based (not hardcoded date) to preserve prompt cache across midnight rollovers.

#### 7.7.5 CC Memory Prompt Integration

CC's `memdir.ts` builds the memory behavioral instructions (`buildMemoryLines()`) which include:

- **`## Types of memory`** — XML-structured type taxonomy with `<name>`, `<description>`, `<when_to_save>`, `<how_to_use>`, `<body_structure>`, `<examples>` per type
- **`## What NOT to save`** — explicit exclusions (code patterns, git history, debugging solutions)
- **`## How to save memories`** — two-step process: (1) write topic file with frontmatter, (2) add index entry to `MEMORY.md`
- **`## When to access memories`** — recall triggers with "ignore" semantics (if user says to ignore memory, proceed as if `MEMORY.md` were empty)
- **`## Before recommending from memory`** — **recall verification**: if a memory names a file path, check it exists; if it names a function, grep for it. *"'The memory says X exists' is not the same as 'X exists now.'"*
- **`## Searching past context`** — instructions for grep-based search across memory files and session transcript logs (JSONL)
- **Combined mode** — when team memory is enabled, adds `<scope>` tags (private/team) to each type's XML block and dual-directory guidance

**Team memory** (`teamMemPaths.ts` / `teamMemPrompts.ts`): When enabled via feature flag `TEAMMEM`, CC adds a shared team directory alongside the private memory directory. Types get `<scope>` annotations (e.g., `feedback` defaults to private but can be team if the guidance is a project-wide convention). Team memories are synced across all CC users on the same project.

#### 7.7.6 Dimension-by-Dimension Comparison

| Dimension | Claude Code | Prism |
| --------- | ---------- | ----- |
| **Storage backend** | Markdown files on filesystem (`~/.claude/projects/<path>/memory/`) | MongoDB collections (`memory_episodic`, `memory_semantic`, `memory_procedural`, `memory_prospective`, `memory_working`) |
| **Type system** | 4 flat types (`user`, `feedback`, `project`, `reference`) with XML taxonomy | 5 cognitive stores modeled on Tulving's episodic/semantic distinction + Baddeley's working memory |
| **Retrieval** | **Sonnet side-query** on frontmatter manifest (up to 5 files per turn) + `MEMORY.md` always in prompt | **Cosine similarity** on embedding vectors + temporal/decay scoring across all stores |
| **Extraction trigger** | `afterResponse` hook via `handleStopHooks` → `runForkedAgent()` | `afterResponse` hook via `MemoryExtractor` → separate Claude Haiku LLM call |
| **Extraction efficiency** | **Forked agent shares parent prompt cache** — input tokens are cache reads (nearly free) | Separate LLM call rebuilds context from scratch (full input token cost) |
| **Extraction output** | File writes to memory directory (the forked agent uses tools to create/edit files) | Structured JSON extraction → MongoDB inserts via service methods |
| **Mutual exclusion** | ✅ Tracks `hasMemoryWritesSince()` — if main agent wrote to memory dir, forked extraction skips | ❌ No deduplication — `MemoryExtractor` always runs regardless of main agent's memory activity |
| **Coalescing** | ✅ `pendingContext` stash + trailing run after in-progress extraction completes | ❌ Each turn triggers independently — no stash/trailing pattern |
| **Turn throttling** | Configurable N-turn interval via feature flag (default: every turn) | Runs every turn (no throttle gate) |
| **Consolidation** | `autoDream/` — idle-time consolidation agent with file-based locking | `MemoryConsolidationService` — 6h scheduled Union-Find clustering with audit trail |
| **Capacity management** | 200-line / 25KB cap on `MEMORY.md` + 5-file selection per turn | 18-slot working memory with relevance-based eviction across all stores |
| **Prompt integration** | `MEMORY.md` always injected in system prompt + selected topic files in context | `WorkingMemoryService.load()` selects top-k memories per turn, formatted as `## Agent Memory` sections |
| **Decay model** | Implicit — old files get stale, `memoryAge.ts` provides freshness weighting | Ebbinghaus forgetting curve: `e^(-t/S)` where `S = 10 + reinforcementCount × 5` |
| **Confidence scoring** | None — all memories are equally trusted | Per-memory confidence: base 0.5, +0.1 per reinforcement, -0.15 per contradiction |
| **Duplicate detection** | Forked agent manually checks existing files before creating new ones | Automated cosine similarity threshold (> 0.92 → reinforce instead of create) |
| **Multi-user** | Team memory (`TEAMMEM` feature flag) with private/team scoping | Per-agent, per-project scoping (no team memory concept) |
| **Recall verification** | ✅ "Before recommending from memory" section forces model to verify file paths and grep for functions | ❌ No recall-side verification — memories are trusted as-is |
| **Cross-session** | File persistence — always available across sessions | MongoDB persistence — cross-session by default |
| **Procedural memory** | Partially covered by `feedback` type (learned approaches) | Dedicated `ProceduralMemoryService` with trigger → step sequence → tool chain, success/failure rate tracking |
| **Prospective memory** | ❌ None | `ProspectiveMemoryService` — future intentions with time-based and cue-based triggers, auto-expiration TTL |
| **Episodic memory** | ❌ None (session transcripts exist as JSONL files but are not structured as episodic memories) | `EpisodicMemoryService` — session narratives with outcome tracking, cross-references to extracted semantic/procedural IDs |

#### 7.7.7 What CC Does Better

1. **Forked agent prompt cache sharing** — CC's extraction runs a full agent clone that reuses the parent's prompt cache key, so input tokens for extraction are nearly free (cache reads only). Our `MemoryExtractor` makes a separate Haiku call that rebuilds context from scratch. This is CC's single biggest memory architecture advantage — it makes extraction cost-efficient enough to run every turn
2. **Mutual exclusion** — CC tracks whether the main agent already wrote memories this turn (`hasMemoryWritesSince()`) and skips the forked extraction. We don't have this deduplication, risking redundant extraction work
3. **"What NOT to save" negative constraints** — CC's exclusion list is eval-validated (memory-prompt-iteration evals). They explicitly prevent saving code patterns, git history, and debugging solutions — even when the user asks. Our `MemoryExtractor` prompt doesn't have this level of negative constraint
4. **Recall verification** — CC's "Before recommending from memory" section forces the model to `grep` or `stat` before acting on a recalled memory. *"'The memory says X exists' is not the same as 'X exists now.'"* We don't have this drift-detection pattern
5. **Coalescing** — CC stashes extraction requests that arrive during an in-progress run and runs a single trailing pass. Our `afterResponse` hook runs once per turn with no coalescing
6. **Sonnet-based relevance selection** — CC uses a Sonnet side-query with the full memory manifest to select which topic files to load (up to 5). This leverages the model's semantic understanding at retrieval time, whereas our embedding-based cosine similarity is cheaper but less contextually aware

#### 7.7.8 Where Prism Is Stronger

1. **Embedding-based retrieval** — CC uses a Sonnet side-query (smart but costs tokens per turn). We use cosine similarity on pre-computed embedding vectors, which is instant and scales to thousands of memories without per-query LLM cost
2. **Ebbinghaus decay** — Our `SemanticMemoryService` implements a forgetting curve with `strength` that decays over time, naturally prioritizing frequently-accessed memories. CC has `memoryAge.ts` for freshness but no spaced-repetition decay model
3. **Procedural memory** — We track tool-chain success rates as first-class `ProceduralMemoryService` records. CC partially covers this via `feedback` type memories, but doesn't track trigger → steps → tools with success/failure metrics
4. **Prospective memory** — We support trigger-based "remind me when X" intentions with time/cue-based firing and auto-expiration. CC has no equivalent
5. **Episodic memory** — We maintain structured session narratives (outcome, satisfaction, key decisions, tags) with cross-references to extracted memories. CC stores raw JSONL transcripts but doesn't structure them as episodic records
6. **Working memory orchestration** — Our `WorkingMemoryService` acts as a central executive (Baddeley's model) that selects the most relevant memories from all stores per turn with explicit 18-slot capacity management. CC dumps `MEMORY.md` into the prompt (always) and selects up to 5 topic files (via Sonnet)
7. **Automated duplicate detection** — Our cosine similarity threshold (> 0.92 → reinforce) prevents memory bloat automatically. CC relies on the forked agent manually checking existing files
8. **Consolidation audit trail** — Our `MemoryConsolidationService` records every run with trigger type, memory counts (before/after), actions applied, duration, and summary. CC's `autoDream` runs silently with file-based locking

#### 7.7.9 Adopted from CC (Implemented)

The following CC patterns were adopted into Prism's memory architecture:

1. ✅ **CC-style 4-type taxonomy** — Replaced the 5-store cognitive model (episodic, semantic, procedural, prospective, working) with CC's flat `user | feedback | project | reference` taxonomy in a single `memories` collection. All memories stored via `MemoryService.store()` with embedding-based dedup
2. ✅ **Negative constraint list** — Added explicit "What NOT to save" constraints to `MemoryExtractor`'s extraction prompt: excludes code patterns, git history, debugging solutions, ephemeral task details, and anything derivable from the codebase
3. ✅ **Mutual exclusion** — `MemoryExtractor.createHook()` checks `toolCalls` in the `afterResponse` payload; skips extraction when `upsert_memory` was called during the turn
4. ✅ **Configurable extraction model** — Uses `SettingsService.getSection("memory")` for provider/model instead of hardcoded Haiku
5. 🔲 **Recall verification prompt** — Planned: add a "Before recommending from memory" system prompt section to verify recalled file paths before acting on them

**Why prompt cache sharing was NOT adopted:** CC's forked agent reuses the parent's Anthropic API cache key because it runs in-process as a CLI tool with direct SDK access. Prism is an HTTP server calling providers through a unified abstraction — we have no access to the cache key machinery. The extraction call uses a separate, cheap LLM call instead.

**Files (CC)**: `src/memdir/memdir.ts`, `memoryTypes.ts`, `findRelevantMemories.ts`, `memoryScan.ts`, `memoryAge.ts`, `paths.ts`, `teamMemPaths.ts`, `teamMemPrompts.ts`, `src/services/extractMemories/extractMemories.ts`, `prompts.ts`, `src/services/autoDream/autoDream.ts`, `config.ts`, `consolidationLock.ts`, `consolidationPrompt.ts`

**Files (Prism)**: `MemoryExtractor.js` (CC-style extraction with 4-type taxonomy + mutual exclusion), `MemoryService.js` (unified single-store with embedding dedup), `MemoryConsolidationService.js` (Union-Find clustering + LLM merge), `SystemPromptAssembler.js` (embedding search retrieval into system prompt)

### 7.8 Skills System Comparison

**Claude Code** (`src/skills/`):

- `bundledSkills.ts` — hard-coded skills shipped with the binary
- `loadSkillsDir.ts` — filesystem-based skill loading from `~/.claude/skills/`
- `mcpSkillBuilders.ts` — MCP-derived skill generation
- `bundled/` — directory of built-in skill definitions

**Prism** (`SkillsPanel` + `SystemPromptAssembler`):

- MongoDB-backed per-project skills with CRUD API
- Embedding-based relevance filtering (cosine similarity ≥ 0.3)
- Injected into system prompt via `SystemPromptAssembler.fetchSkills()`
- `skills_injected` status event for UI

**Comparison**: Different approaches — CC uses filesystem convention (drop a skill file in a directory), Prism uses database + embeddings. CC's `mcpSkillBuilders.ts` is interesting — it auto-generates skills from connected MCP servers, which we don't do.

**Potential adoption**: Consider auto-generating skill hints from MCP server tool descriptions. Low priority.

### 7.9 Utils Surface Area

Claude Code's `src/utils/` is massive (~100+ files). Notable subdirectories and utilities not present in Prism:

| Utility                             | What it does                            | Prism equivalent                     | Gap?                  |
| ----------------------------------- | --------------------------------------- | ------------------------------------ | --------------------- |
| `abortController.ts`                | WeakRef parent-child abort tree         | `utils/AbortController.js`           | ✅ Equivalent         |
| `cleanup.ts` + `cleanupRegistry.ts` | Global shutdown + periodic cleanup      | `utils/CleanupRegistry.js`           | ✅ Equivalent         |
| `conversationRecovery.ts`           | Session resume with interrupt detection | MongoDB persistence                  | **Partial — see 7.4** |
| `backgroundHousekeeping.ts`         | Idle-time maintenance tasks             | `BackgroundHousekeepingService`       | ✅ Equivalent         |
| `sandbox/`                          | Sandboxed execution environments        | None (Tier 3 approval only)          | Accepted risk         |
| `permissions/`                      | Permission system directory             | `AutoApprovalEngine`                 | ✅ Equivalent         |
| `hooks/`                            | Hook utilities                          | `AgentHooks` EventEmitter            | ✅ Equivalent         |
| `swarm/`                            | Multi-agent coordination utilities      | `CoordinatorService`                 | ✅ Equivalent         |
| `git/`                              | Git operations                          | `AgenticGitService` in tools-api     | ✅ Equivalent         |
| `shell/` + `bash/` + `powershell/`  | Shell abstraction per OS                | `AgenticCommandService` in tools-api | ✅ Equivalent         |
| `mcp/`                              | MCP client utilities                    | `MCPClientService`                   | ✅ Equivalent         |
| `memory/`                           | Memory helpers                          | CC-style single `memories` store     | ✅ Equivalent (see 7.7)  |
| `model/`                            | Model configuration/selection           | `config.js` model definitions        | ✅ Equivalent         |
| `settings/`                         | User settings management                | Retina settings + Prism config       | ✅ Equivalent         |
| `computerUse/`                      | Computer use (screen interaction)       | `AgenticBrowserService`              | ✅ Equivalent         |
| `todo/`                             | TODO/task list utilities                | `AgenticTaskService`                 | ✅ Equivalent         |
| `ultraplan/`                        | Planning mode utilities                 | `PlanningModeService`                | ✅ Equivalent         |
| `suggestions/`                      | Context suggestions                     | None                                 | Not needed (web UI)   |
| `telemetry/`                        | Analytics/telemetry                     | `RequestLogger`                      | ✅ Equivalent         |
| `filePersistence/`                  | File state persistence                  | MinIO + MongoDB                      | ✅ Equivalent         |
| `deepLink/`                         | Deep linking (URI schemes)              | Not applicable (web UI)              | N/A                   |
| `claudeInChrome/`                   | Chrome extension integration            | Not applicable                       | N/A                   |
| `codeIndexing.ts`                   | Code indexing for search                | `AgenticLspService`                  | ✅ Superior           |
| `contextAnalysis.ts`                | Context window analysis                 | `ContextWindowManager`               | ✅ Equivalent         |
| `autoUpdater.ts`                    | Self-update mechanism                   | Not applicable (dev tool)            | N/A                   |

---

## 8. Known Gaps & Technical Debt

Identified gaps between the current implementation and production-grade robustness, ordered by impact. Updated with findings from the Claude Code comparative analysis (Section 7).

### ⚠️ Test Coverage for Critical Paths

**Impact**: High — `AgenticLoopService` and `SystemPromptAssembler` lack automated tests. `ContextWindowManager` and `AutoApprovalEngine` now have full unit test coverage.

| Service                 | Testability        | Status                                                                                                                                  |
| ----------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ContextWindowManager`  | Pure logic, no I/O | ✅ 27 tests — token estimation, all 3 truncation strategies, budget math, edge cases                                                    |
| `AutoApprovalEngine`    | Pure logic, no I/O | ✅ 59 tests — tier assignments (all 23 tools), overrides, labels, check/checkBatch, fullAuto, createHook                                |
| `AgenticLoopService`    | Requires mocking   | 🔲 Integration tests needed: mock provider streams, tool executor, hooks. Verify iteration counting, exhaustion recovery, approval flow |
| `SystemPromptAssembler` | Requires mocking   | 🔲 Integration tests needed: mock tools-api, MongoDB, embedding service                                                                 |

**Files**: `tests/contextWindowManager.test.js`, `tests/autoApprovalEngine.test.js`

### ✅ Abort Propagation to Tool Processes (RESOLVED)

**Impact**: ~~High~~ → Resolved. Implemented `utils/AbortController.js` (WeakRef-based tree) and `utils/CleanupRegistry.js` (global shutdown hooks).

**What was built**:
- `createAbortController()` — factory with `setMaxListeners(50)` to prevent MaxListenersExceededWarning
- `createChildAbortController(parent)` — WeakRef-based GC-safe propagation: parent abort cascades to children, child abort does not affect parent, abandoned children can be garbage-collected
- `CleanupRegistry` — global `Set<fn>` singleton with `registerCleanup()` / `runCleanupFunctions()` / `installShutdownHandlers()`
- Signal threading through `ToolOrchestratorService.fetchJson()` / `fetchJsonPost()` — all tool HTTP requests now abort when the session is cancelled
- `executeToolStreaming()` combines session abort signal with 65s timeout via event listener wiring
- AbortError handling returns `{ error: "Tool execution aborted" }` instead of cryptic fetch errors
- Registered shutdown cleanup in: `CoordinatorService` (abort workers + remove worktrees), `MCPClientService` (disconnect servers + kill stdio transports), `benchmark.js` (abort active runs)
- `installShutdownHandlers()` in `index.js` — SIGTERM/SIGINT with 5s hard timeout

**Remaining** (lower priority):
- PID tracking in `AgenticLoopService.finally` for spawned shell processes (optional — processes are already terminated on session cancel via `AbortController` signal)

### ✅ Background Housekeeping & Boot-Time Cleanup

**Impact**: Medium — Identified as critical gap after studying Claude Code's `cleanup.ts` which runs 8+ cleanup passes including `cleanupStaleAgentWorktrees()`.

**Implemented**: `BackgroundHousekeepingService.js` — runs at boot (fire-and-forget) and on a 6h `setInterval` in `index.js`.

Cleanup targets:
1. **Worktree pruning**: `/tmp/prism-worktrees/` directories older than 24h removed recursively
2. **Stale session cleanup**: `isGenerating` flags older than 2h cleared in `conversations` and `agent_sessions`
3. **Request log pruning**: Request logs older than 90 days deleted from `requests` collection
4. **MinIO orphan purge**: Objects whose conversation/session ID prefix no longer exists in MongoDB are removed

**Process Kill Endpoint**: `POST /agentic/command/kill` — `killProcessTree(pid)` in `AgenticCommandService.js`. Attempts SIGTERM on the process group (-pgid), waits 3s grace period, escalates to SIGKILL. Safety: refuses PID 1 and self-kill.

**Files**: `prism/src/services/BackgroundHousekeepingService.js`, `tools-api/services/AgenticCommandService.js`, `tools-api/routes/AgenticRoutes.js`

### ⚠️ Token Estimation Accuracy

**Impact**: Low — `ContextWindowManager` uses a fixed `~3.5 chars/token` ratio for budget enforcement. This is intentionally conservative but has known limitations:

| Content Type         | Actual Ratio     | Estimation Accuracy                           |
| -------------------- | ---------------- | --------------------------------------------- |
| English prose        | ~4.0 chars/token | Slightly over-estimates (safe)                |
| Code (JS/Python)     | ~3.5 chars/token | Accurate                                      |
| CJK text             | ~1.5 chars/token | **Under-estimates by ~2×** (risk of overflow) |
| JSON/structured data | ~3.0 chars/token | Slightly over-estimates (safe)                |
| Base64 data          | ~4.0 chars/token | Accurate                                      |

**Current mitigation**: The `80%` utilization target (`TARGET_UTILIZATION = 0.80`) provides a 20% safety margin that absorbs most estimation errors. No production overflow incidents observed.

**Future improvement**: Per-model tokenizer integration (e.g. `tiktoken` for OpenAI, `@anthropic-ai/tokenizer` for Anthropic) would give exact counts but adds ~2ms latency per estimation and external dependencies. Only worth it if CJK-heavy workflows become common.

### 🔲 Tool Execution Sandboxing

**Impact**: Accepted risk — `execute_shell`, `execute_python`, `execute_javascript`, and `run_command` execute arbitrary code on the host system with the user's permissions. The **only** safety layer is the Tier 3 approval gate.

**Current design**: This is an intentional tradeoff for a local-first tool. The agent runs on the user's own machine with their own filesystem access — sandboxing would limit the agent's utility for its primary use case (autonomous coding).

**Claude Code reference**: Has a `src/utils/sandbox/` directory for sandboxed execution environments — indicates Anthropic considers this worth investing in. Their `src/utils/permissions/` directory is a dedicated subsystem (vs our single `AutoApprovalEngine` file).

**Noted risks**:

- `autoApprove` / Full Auto mode bypasses the approval gate entirely
- No audit log of executed commands beyond `RequestLogger` (queryable but not surfaced in UI)
- No resource limits (CPU, memory, disk) on spawned processes

**Possible future hardening** (if needed):

- Command allowlist/denylist patterns in `AutoApprovalEngine` (e.g. block `rm -rf /`, `sudo`, `curl | sh`)
- Per-session command audit panel in Retina
- Docker/container-based execution for untrusted tool calls

### 🔲 Session Resume & Interrupted Turn Recovery

**Impact**: Low (quality-of-life) — Claude Code has sophisticated conversation recovery (`src/utils/conversationRecovery.ts`) with turn interruption detection and automatic continuation. Prism relies on MongoDB persistence which handles the common case but doesn't detect or recover interrupted turns.

**Missing capabilities**:

- No `filterUnresolvedToolUses()` — orphaned tool_use blocks can cause API errors on session resume
- No interrupted turn detection — if user disconnects mid-tool, next session starts fresh instead of continuing
- No "Continue from where you left off" auto-injection

**Recommendation**: Add a message sanitization pass on session load that strips unresolved tool_use blocks. Turn interruption detection is nice-to-have but not blocking.

### 🔲 Undocumented Systems

**Impact**: Low — Several implemented systems are not covered in this design document because they are orthogonal to the agentic loop:

| System              | Route              | Service                  | Purpose                                                                                 |
| ------------------- | ------------------ | ------------------------ | --------------------------------------------------------------------------------------- |
| **Synthesis**       | `/synthesis`       | `synthesis.js`           | User simulation — generates synthetic multi-turn conversations for testing and training |
| **VRAM Benchmarks** | `/vram-benchmarks` | `vram-benchmarks.js`     | GPU memory profiling for local models across different quantizations                    |
| **Change Streams**  | —                  | `ChangeStreamService.js` | MongoDB change stream watchers for real-time UI updates                                 |
| **Request Logger**  | —                  | `RequestLogger.js`       | Structured logging of all LLM API calls with cost, latency, and usage metrics           |

These are documented in their respective source files but excluded from this agentic architecture document to maintain focus.

---

## Appendix A: Removed Features (Do Not Implement)

The following features were present in the original design document but were removed during the code-grounded review. They are preserved here for historical context.

### ❌ Daemon Mode & UDS Inbox (JSON-RPC)

> _Original_: Prism sessions will run in the background like system services. Multiple sessions communicate over Unix Domain Sockets (UDS Inbox) using JSON-RPC/JSONL.

**Why removed**: Prism is already an Express + WebSocket server on port 7777. Adding a parallel JSON-RPC/UDS transport creates two communication paths that must be kept in sync, doubling the API surface for zero user benefit. The existing WebSocket transport already supports everything this pattern described. UDS only makes sense for CLI-to-CLI IPC — Prism is a server, not a CLI tool.

### ❌ Anti-Distillation

> _Original_: Inject fake tool definitions to prevent competitors from scraping and training on successful trajectories.

**Why removed**: This is a concern for hosted public APIs, not a local-first tool. No competitor is scraping tool definitions from a local Prism instance. Adds unnecessary complexity and noise to the tool schema pipeline.

### ❌ Undercover Mode

> _Original_: A stealth logic block that strips all traces of AI involvement (e.g., commit messages, `Co-Authored-By` tags) when working in public repositories.

**Why removed**: Stripping AI attribution from public repos is deceptive and violates most open-source contribution guidelines. This has no place in a professional tool — design documents should focus on features that serve users, not adversarial posturing.

### ❌ LLM-Based YOLO Classifier

> _Original_: Use a dedicated side-query LLM layer (`classifyYoloAction`) to decide whether to auto-execute a tool.

**Why removed**: Not the feature itself (permission gating is critical), but the _implementation approach_. Using an LLM side-query for every tool call is expensive, slow (~500ms+ latency per classification), and unreliable. Replaced with the **Auto-Approval Engine** — a deterministic, rule-based three-tier system that achieves the same goal with zero latency and zero cost. LLM-based classification can be revisited as a Tier 2 fallback for ambiguous custom tools if needed.

---

## Appendix B: Intentionally Not Implemented (By Design)

Features studied from Claude Code's architecture that we explicitly chose NOT to implement, with rationale.

### ❌ TeamCreateTool / Persistent Multi-Agent Swarms

> _Claude Code_: `TeamCreateTool` creates persistent multi-agent teams with team files, shared task lists, and cleanup hooks.

**Why not**: Our coordinator mode already handles the useful subset — parallel workers with isolated contexts. The "team" abstraction adds a management layer (team files, team deletion, team-scoped tasks) that creates complexity without proportional benefit for our use case. If a task needs more workers, the coordinator just spawns them.

### ❌ Task Swarm Extensions (task_claim, DAG enforcement, owner fields)

> _Original design_: Activate `owner`, `blocks`/`blockedBy` DAG enforcement, `task_claim` tool, `activeForm` UI text in `AgenticTaskService`.

**Why not**: The coordinator already manages worker assignment — it decides what tasks to create and which workers to spawn. Adding atomic task claiming, dependency DAGs, and worker ownership tracking duplicates the coordinator's job at a lower abstraction level. These patterns are designed for autonomous swarms where agents self-organize; our coordinator is the central brain. The task system works well as a simple persistent scratchpad for single-agent workflows.

### ❌ Worker-to-Worker Communication

> _Claude Code_: Workers can be configured to check on each other.

**Why not**: The coordinator system prompt explicitly says "Do not use one worker to check on another." Workers report to the coordinator; the coordinator decides what to do next. Worker-to-worker communication creates implicit dependencies and makes it harder to reason about the system state.

### ❌ Coordinator WebSocket Streaming (for Manual Panel)

> _Original_: Replace polling at `GET /coordinator/status/:taskId` with WebSocket push events.

**Why not**: The manual panel decomposition flow is a lower-priority UX path now that chat-triggered coordinator mode is fully functional. The polling works fine for the occasional manual decomposition. If the manual panel sees more use, this can be revisited.

### ❌ DreamTask / RemoteAgentTask (Polymorphic Task Runners)

> _Claude Code_ (`src/tasks/`): Five polymorphic task types — `DreamTask` (background autonomous), `RemoteAgentTask` (cross-network), `InProcessTeammateTask` (shared-memory), `LocalShellTask`, `LocalAgentTask`.

**Why not**: Our single `AgenticLoopService.runAgenticLoop()` parameterized via options handles all current execution paths: direct chat, coordinator workers, and REST callers. The polymorphic task hierarchy adds abstraction overhead that only pays off when you need fundamentally different execution environments. `DreamTask` (background autonomous loops without user interaction) and `RemoteAgentTask` (cross-network agent execution) are architecturally interesting but not in our roadmap. If we need them later, extracting a `TaskRunner` interface is straightforward.

### ❌ File-Based Memory (`memdir/`)

> _Claude Code_ (`src/memdir/`): File-based memory system using `~/.claude/projects/<path>/memory/` with markdown files + YAML frontmatter, `MEMORY.md` as always-loaded index, Sonnet side-query relevance selection (up to 5 topic files per turn), forked-agent extraction (prompt cache sharing for near-free input tokens), `autoDream` idle-time consolidation, 4-type taxonomy (`user`, `feedback`, `project`, `reference`), and team memory scoping.

**Why not**: Our 5-store cognitive memory architecture is categorically more capable — see **Section 7.7** for the full deep comparison. Key advantages: embedding-based retrieval (instant, scales to thousands of memories vs Sonnet call per turn), Ebbinghaus confidence decay with reinforcement/contradiction tracking, 5 specialized cognitive stores vs 1 flat taxonomy, procedural memory with tool-chain success rates, prospective memory (future intentions) with no CC equivalent, and consolidation audit trails. CC's forked-agent prompt cache sharing is genuinely clever (makes extraction nearly free on input tokens), but our MongoDB-backed approach trades that for structured queries, automated duplicate detection (cosine > 0.92 → reinforce), and working memory orchestration (Baddeley's central executive, 18-slot capacity). The file-based approach is simpler to debug but scales poorly, lacks semantic search, and has no formal decay or confidence model.

**Worth adopting from CC**: Recall verification prompting ("Before recommending from memory" — verify file paths and function names before acting), negative constraint list for extraction ("What NOT to save" — exclude derivable information), and mutual exclusion (skip extraction when main agent already wrote memories this turn). See Section 7.7.9 for the full adoption list.

### ❌ JSONL Transcript Chains with UUID Linking

> _Claude Code_ (`src/utils/conversationRecovery.ts`): Messages stored in JSONL files with UUID parent links. `buildConversationChain()` walks the chain from leaf nodes, supports forks/sidechains, and resolves message trees.

**Why not**: Our MongoDB document model with flat message arrays per conversation is simpler, supports efficient queries, and doesn't require chain resolution. JSONL chains with UUID linking are designed for file-system-first architectures (CLI tools) where you can't assume a database. Our architecture has MongoDB as a given — using it for structured queries and atomic updates is the right call.

### ❌ CLI-Native Features (Suggestions, Deep Links, Chrome Integration)

> _Claude Code_: `src/utils/suggestions/` (context-aware next-action suggestions), `src/utils/deepLink/` (URI scheme handling), `src/utils/claudeInChrome/` (browser extension integration), `src/utils/nativeInstaller/` (native binary installer).

**Why not**: These are CLI-specific UX patterns. Retina's web UI has its own interaction paradigms — suggestions would be implemented as UI autocomplete (not terminal inline hints), deep links would be URL routes (not URI schemes), and browser integration is native to a web app. These patterns don't translate to our architecture.

### ❌ NPM Cache / Version Cleanup Housekeeping

> _Claude Code_ (`src/utils/cleanup.ts`): `cleanupNpmCacheForAnthropicPackages()` purges old `@anthropic-ai/claude-*` cache entries. `cleanupOldVersionsThrottled()` removes old CLI versions.

**Why not**: These are specific to Claude Code's deployment model (npm-distributed CLI binary with frequent dev releases). Prism is a server running in development — we don't have cached npm package versions to clean up or old binaries to prune. Our equivalent housekeeping targets are MongoDB collections (stale sessions), MinIO objects (orphaned uploads), and `/tmp/prism-worktrees/` (orphaned worktrees).

### ❌ Plugin Architecture (`src/plugins/`)

> _Claude Code_: `builtinPlugins.ts` + `bundled/` directory — extensibility point for third-party contributions to modify the agent loop, add commands, or inject hooks.

**Why not**: Prism is a single-user local tool, not a framework for distribution. Tool extensibility is handled through three existing mechanisms: (1) `tools-api` dynamic schema loading (add a service + routes → tools appear automatically), (2) MCP server connections (industry-standard third-party tool integration), (3) custom tools in MongoDB (per-project arbitrary HTTP endpoints). A plugin system adds framework complexity without user benefit in our context.

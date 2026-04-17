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
12. ✅ **Post-Sampling Hooks**: Background processes for memory extraction via `SessionSummarizer`, registered as an `afterResponse` hook. Uses Claude Haiku to extract 4-type memories (user, feedback, project, reference) and stores via `AgentMemoryService`. Also triggers `MemoryConsolidationService.checkAndRun()` for session-threshold consolidation.
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

### ✅ Persistent Memory (Two-Phase)

**Phase A — Session Summarization** ✅:
`SessionSummarizer` runs as a fire-and-forget `afterResponse` hook, extracting memories via `claude-haiku-4-5` into a 4-type taxonomy (user, feedback, project, reference). Stored in `agent_memories` collection via `AgentMemoryService` with embedding-based duplicate detection (cosine similarity > 0.92 = skip). Memories include staleness caveats and age metadata for prompt injection.

**Phase B — Memory Consolidation** ✅:
Autonomous background process that clusters, merges, and prunes accumulated memories using Union-Find clustering on embeddings. Implementation:

- `MemoryConsolidationService.js`: Clusters memories by cosine similarity, sends clusters to Claude Haiku for merge/delete/keep analysis, applies actions, records audit trail in `memory_consolidation_history` collection
- **Scheduled loop**: `setInterval` in `index.js` runs every 6 hours, processes all projects with 10+ memories (trigger: `scheduled`)
- **Cost guard**: `DAILY_MAX_CONSOLIDATIONS = 3` per project per day to prevent API credit burn
- **Audit trail**: Every run recorded with trigger type, memory counts (before/after), actions applied, duration, summary
- **Real-time feedback**: `broadcast` callback wired through `SessionSummarizer` → `ctx.emit` pushes `memory_consolidation_complete` events to Retina via WebSocket
- **API**: `GET /agent-memories/consolidation-history?project=X&limit=5`
- **UI**: `MemoriesPanel.js` has collapsible Consolidation History section with trigger badges (Manual / Scheduled / Session), timeline entries, and auto-refresh on consolidation events via `consolidationEvent` prop
- **Triggers**: Manual (POST endpoint), scheduled (6h interval), session-threshold (after N sessions via SessionSummarizer)

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

`AgentMemoryService` is a fully generalized project-scoped memory system (stripped of Discord-specific fields). Uses embedding-based storage with cosine similarity search, 4-type taxonomy (user, feedback, project, reference), duplicate detection, and staleness caveats. Integrated into `SystemPromptAssembler.fetchMemories()` — relevant memories are injected into the system prompt on every agentic loop iteration.

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
5. ✅ **Session Summarization** — `SessionSummarizer` + `AgentMemoryService`: Claude Haiku extraction → 4-type memory taxonomy → MongoDB

### Phase 2: Memory & Extensibility ✅ COMPLETE (4/5)

1. ✅ **Generalized MemoryService** — `AgentMemoryService`: project-scoped, embedding-based, 4-type taxonomy, duplicate detection, wired into `SystemPromptAssembler`
2. ✅ **Skills System** — DB-backed per-project skills with embedding-based relevance filtering, CRUD via `/skills` API, SkillsPanel UI, injected into system prompt
3. ✅ **Tool Rendering Registry** — `ToolResultRenderers.js`: registry-based rendering with specialized components per tool domain
4. ✅ **MCP Client** — Prism connects to external MCP servers for third-party tool access
5. 🔲 **Slash Commands** — Parameterized prompt templates with argument substitution

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
3. 🔲 **Background Housekeeping** — `BackgroundHousekeeping` service: boot-time worktree pruning (`/tmp/prism-worktrees/` > 24h), periodic stale session/request-log cleanup (6h interval), MinIO orphan purge. Reference: CC's `cleanup.ts` + `backgroundHousekeeping.ts`
4. 🔲 **Process Kill Endpoint** — `POST /compute/shell/kill/:pid` in `tools-api` for process-tree cleanup. Track spawned PIDs in `AgenticLoopService`, kill in `finally` block
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
| **Memory**    | `src/memdir/` — file-based `memdir.ts` with `findRelevantMemories.ts`, `memoryAge.ts`, `memoryScan.ts`, `teamMemPaths.ts` | `AgentMemoryService` — MongoDB + embeddings with consolidation  |
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

**Prism gap**: Our `AbortController` usage is flat — one controller per session, `signal.aborted` checks in the loop. No parent-child propagation, no WeakRef-based cleanup, no global cleanup registry. In-flight `ToolOrchestratorService` fetch calls are not aborted when the user cancels.

**Recommendation**: Implement a `createChildAbortController()` utility modeled on CC's pattern. Pass child signals to `executeTool()` / `executeToolStreaming()` so fetch calls abort cleanly. Add a `CleanupRegistry` singleton that runs registered teardown functions (worktree removal, shell PID kills) in Prism's `SIGTERM`/`SIGINT` handler and in `AgenticLoopService.finally`.

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

**Prism gap**: No boot-time or scheduled cleanup. Orphaned worktrees in `/tmp/prism-worktrees/` accumulate indefinitely. No periodic purge of old session data or tool results.

**Recommendation**: Implement a `BackgroundHousekeeping` service that runs on Prism startup and periodically (6h interval like memory consolidation). Priority: worktree pruning (already identified as 🔲), stale MongoDB session cleanup, MinIO orphan purge.

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

### 7.7 Memory Architecture Comparison

**Claude Code** (`src/memdir/`):

- `memdir.ts` — core memory directory manager
- `findRelevantMemories.ts` — relevance-based memory retrieval
- `memoryAge.ts` — time-decay weighting for memory freshness
- `memoryScan.ts` — directory scanning for memory files
- `memoryTypes.ts` — type definitions
- `teamMemPaths.ts` / `teamMemPrompts.ts` — team-scoped memory paths and prompts

**Storage**: File-based — memories stored as files in `~/.claude/memdir/`. Relevance matching via content scanning (not embeddings).

**Prism** (`AgentMemoryService` + `MemoryConsolidationService`):

- MongoDB-backed with embedding vectors (cosine similarity search)
- 4-type taxonomy: user, feedback, project, reference
- Duplicate detection via embedding similarity > 0.92
- Automated consolidation: Union-Find clustering → Claude Haiku merge/delete/keep analysis
- Staleness caveats injected into prompts
- Consolidation audit trail with UI history panel

**Comparison**: Prism's memory system is **significantly more sophisticated** than Claude Code's file-based `memdir`. We have embedding-based search (vs. file scanning), automated consolidation (vs. manual), and a richer type taxonomy. Claude Code's team memory paths are irrelevant to our architecture (we don't have team concepts).

**Our advantage**: ✅ No changes needed. Our memory architecture exceeds Claude Code's.

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
| `abortController.ts`                | WeakRef parent-child abort tree         | Flat AbortController                 | **Yes — see 7.2**     |
| `cleanup.ts` + `cleanupRegistry.ts` | Global shutdown + periodic cleanup      | Missing                              | **Yes — see 7.3**     |
| `conversationRecovery.ts`           | Session resume with interrupt detection | MongoDB persistence                  | **Partial — see 7.4** |
| `backgroundHousekeeping.ts`         | Idle-time maintenance tasks             | Missing                              | **Yes — see 7.3**     |
| `sandbox/`                          | Sandboxed execution environments        | None (Tier 3 approval only)          | Accepted risk         |
| `permissions/`                      | Permission system directory             | `AutoApprovalEngine`                 | ✅ Equivalent         |
| `hooks/`                            | Hook utilities                          | `AgentHooks` EventEmitter            | ✅ Equivalent         |
| `swarm/`                            | Multi-agent coordination utilities      | `CoordinatorService`                 | ✅ Equivalent         |
| `git/`                              | Git operations                          | `AgenticGitService` in tools-api     | ✅ Equivalent         |
| `shell/` + `bash/` + `powershell/`  | Shell abstraction per OS                | `AgenticCommandService` in tools-api | ✅ Equivalent         |
| `mcp/`                              | MCP client utilities                    | `MCPClientService`                   | ✅ Equivalent         |
| `memory/`                           | Memory helpers                          | `AgentMemoryService`                 | ✅ Superior           |
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
- `POST /compute/shell/kill/:pid` endpoint in `tools-api` for shell process tree cleanup
- PID tracking in `AgenticLoopService.finally` for spawned shell processes

### 🔲 Background Housekeeping & Boot-Time Cleanup

**Impact**: Medium — Identified as critical gap after studying Claude Code's `cleanup.ts` which runs 8+ cleanup passes including `cleanupStaleAgentWorktrees()`.

**Current state**: No boot-time or periodic cleanup. Orphaned git worktrees in `/tmp/prism-worktrees/` accumulate from improper shutdowns or unhandled worker crashes. No periodic purge of stale MongoDB session data, old request logs, or MinIO orphans.

**Claude Code reference**: `src/utils/cleanup.ts` (8 cleanup passes), `src/utils/backgroundHousekeeping.ts` (idle-time tasks).

**Implementation path**:

1. Boot-time: Prune `/tmp/prism-worktrees/` directories older than 24h on Prism startup
2. Scheduled: 6h interval cleanup of stale request logs, orphaned MinIO objects, expired session data
3. ~~Shutdown: `CleanupRegistry` runs all registered teardown functions~~ ✅ Done — implemented in Phase 5.2

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

> _Claude Code_ (`src/memdir/`): File-based memory system using `~/.claude/memdir/` with `memoryScan.ts` (directory walking), `memoryAge.ts` (time-decay), and `teamMemPaths.ts`/`teamMemPrompts.ts` (team-scoped memory).

**Why not**: Our MongoDB + embedding-based `AgentMemoryService` with automated `MemoryConsolidationService` is strictly more capable: semantic search via cosine similarity (vs file scanning), automated clustering and merging (vs manual file management), 4-type taxonomy, duplicate detection, and consolidation audit trails. File-based memory is simpler to debug but scales poorly and lacks semantic awareness.

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

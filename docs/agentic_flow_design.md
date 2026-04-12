# Agentic Flow & Architecture: Retina & Prism Design

Based on analysis of state-of-the-art agent architectures (including open-source terminal agents like `pi-mono` and industry-standard patterns), here is a comprehensive breakdown of the agentic loop, architecture, and strategic roadmap for **Prism** (the local AI gateway) and **Retina** (the web UI).

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
10. ✅ **Exhaustion Recovery**: If the loop exits by hitting `MAX_TOOL_ITERATIONS`, a final tool-free LLM pass is triggered to summarize progress so the user understands where things stand. Emits `iteration_limit_reached` status.
11. ✅ **Response Rendering**: Flushes final text to the transport via `emit({ type: "chunk", content })`.
12. ✅ **Post-Sampling Hooks**: Background processes for memory extraction via `SessionSummarizer`, registered as an `afterResponse` hook. Uses Claude Haiku to extract 4-type memories (user, feedback, project, reference) and stores via `AgentMemoryService`. Also triggers `MemoryConsolidationService.checkAndRun()` for session-threshold consolidation.
13. ✅ **Await Input**: The WebSocket connection stays open for the next message. REST SSE connections end cleanly.

---

## 2. Real-World Implementation Patterns

Concrete software patterns for building and extending Prism's agent loop:

### ✅ Unified Extensions & Hooks System
The core logic uses an `EventEmitter`-based hook system wrapping the `AgenticLoopService` while loop. Lifecycle events include:

| Event | Fires When | Use Case |
|---|---|---|
| `BeforePrompt` | Before system prompt assembly | Inject skills, memory, directory context |
| `BeforeToolCall` | Before each tool execution | Auto-Approval Engine permission check |
| `AfterToolCall` | After each tool returns | Logging, mutation tracking |
| `AfterResponse` | After final text is flushed | Session summarization, memory extraction |
| `OnError` | On any loop error | Error recovery, generating flag cleanup |

Implementation: `EventEmitter`-based, registered via a plugin array in `AgenticLoopService`. Named hooks with sequential execution and error isolation.

### ✅ Dual Endpoint Architecture (`/chat` vs `/agent`)
The agentic loop is gated on a dedicated REST endpoint:

| Endpoint | Agentic Loop | Function Calling | Use Case |
|---|---|---|---|
| `POST /chat` | ❌ Off by default | Optional | Simple LLM calls, Chat tab |
| `POST /agent` | ✅ Always on | ✅ Always on | Autonomous agent workflows, Agent tab, Lupos |
| `WS /ws/chat` | Flag-gated | Flag-gated | Retina real-time chat |

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

| Service | Tools |
|---|---|
| `AgenticFileService` | `read_file`, `write_file`, `str_replace_file`, `patch_file`, `multi_file_read`, `file_info`, `file_diff`, `move_file`, `delete_file` |
| `AgenticCommandService` | `execute_shell`, `execute_python`, `execute_javascript`, `run_command` |
| `AgenticProjectService` | `list_directory`, `grep_search`, `glob_files`, `project_summary` |
| `AgenticWebService` | `fetch_url`, `web_search` |
| `AgenticGitService` | `git_status`, `git_diff`, `git_log` (+ worktree ops) |
| `AgenticBrowserService` | `browser_action` |
| `AgenticTaskService` | `task_create`, `task_get`, `task_list`, `task_update` |

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
   - **Implementation**: `AgenticTaskService` in `tools-api` with four tools: `task_create` (with subject, description, status, metadata), `task_get` (single task by ID), `task_list` (filterable by status, returns summary counts), `task_update` (status transitions, metadata merge). MongoDB `agent_tasks` collection with project-scoped isolation, monotonic IDs via `agent_task_counters`. Schema pre-wired for future swarm support with `owner`, `blocks`, `blockedBy` fields (unused in single-agent mode). All four tools registered as **Tier 1 (auto-approve)** in `AutoApprovalEngine` since they only modify the agent's own scratchpad, not user files. 200-task-per-project cap.
   - **Files**: `tools-api/services/AgenticTaskService.js`, `AgenticRoutes.js` (`/agentic/task/{create,list,get,update,delete}`), `ToolSchemaService.js`, `prism/src/services/AutoApprovalEngine.js`
   - **Future (Swarm Extensions)**: When Coordinator workers are wired to `AgenticLoopService`, the task system will serve as a shared work queue. Planned additions:
     - `task_claim` — Atomic acquisition with agent-busy check and file locking (prevents two workers from claiming the same task). Modeled after Claude Code's `claimTask()` with retry-backoff semantics.
     - `task_stop` / `task_output` — Allow workers to report results and completion status back to the coordinator.
     - `blocks` / `blockedBy` DAG enforcement — Tasks can declare dependencies; `task_claim` checks that all blockers are `completed` before allowing acquisition.
     - `owner` field activation — Workers identify themselves via `agentId`; tasks track which worker is operating on them.
     - `activeForm` field — Present-continuous spinner text for Retina UI (e.g., "Running tests", "Refactoring auth module").
     - Coordinator WebSocket integration — `notifyTasksUpdated()` broadcasts real-time task state changes to Retina via existing WebSocket infrastructure.

5. 🔲 **Background Execution Monitoring (Terminal Capture)**:
   - **What**: The ability to inspect the output of persistent daemon processes (like `npm run dev` or a Python server).
   - **Why**: `execute_shell` relies on the process exiting to read output. Agents need to "glance" at long-running logs to debug errors from background servers.
   - **Implementation**: Terminal tail wrapping in `AgenticCommandService` via a `capture_terminal` tool.

> **Design principle**: Optimize for the *right* tools at each capability tier, not raw count. Claude Code ships ~15 tools. Cursor ships fewer. Coverage of capability categories (filesystem, search, execution, network, browser) matters more than quantity.

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

### ⚠️ Coordinator Mode (Multi-Agent Orchestration)
The coordinator (lead agent) breaks complex tasks apart, spawns parallel workers in isolated git worktrees, collects results. Based on analysis of Claude Code's public `coordinatorMode.ts`, `src/utils/swarm/`, `AgentTool/`, `TeamCreateTool/`, and `SendMessageTool/` patterns.

**Paradigm shift**: Moving from manual-panel-only decomposition to **chat-triggered subagent orchestration**. The LLM itself decides when to fan out by calling `spawn_agent`, `send_message`, and `stop_agent` tools — identical to how Claude Code's coordinator uses `Agent`, `SendMessage`, and `TaskStop` tool calls.

**Current Architecture** (✅ built, workers stubbed):
User Request → LLM Decomposition (Claude Sonnet) → N Workers → Git Worktree Isolation → MutationQueue Safety → Unified Diff → User Approval → Git Merge

**Target Architecture** (🔲 to build):
Chat Message → Coordinator System Prompt Injection → LLM calls `spawn_agent` tool → Worker spawned with own `AgenticLoopService.runAgenticLoop()` in isolated git worktree → Worker autonomously uses full tool suite → Worker completes → `<task-notification>` XML injected as user-role message into coordinator's conversation → Coordinator synthesizes results → Optionally continues worker via `send_message` → User reviews unified diffs → Approve & Merge

**Reference Architecture (Claude Code)**:
- **coordinatorMode.ts**: Feature-gated via `CLAUDE_CODE_COORDINATOR_MODE` env var. `getCoordinatorSystemPrompt()` returns a 300-line system prompt defining the coordinator's role, tool usage examples (`Agent`, `SendMessage`, `TaskStop`), 4-phase workflow (Research → Synthesis → Implementation → Verification), concurrency rules (read-only parallel, write-heavy serial), synthesization anti-patterns, continue-vs-spawn decision matrix
- **src/utils/swarm/inProcessRunner.ts**: `InProcessRunnerConfig` wraps `runAgent()` with `AsyncLocalStorage`-based context isolation, `TeammateIdentity`, linked `AbortController`, plan mode approval support, idle notification to leader via file-based mailbox, task claiming from team task list
- **src/utils/swarm/spawnInProcess.ts**: Creates `TeammateContext`, registers `InProcessTeammateTaskState` in `AppState`, returns `InProcessSpawnOutput` with `abortController` and `teammateContext`
- **AgentTool/**: Coordinator calls `Agent(description, prompt, subagent_type)` → spawns worker. Worker results arrive as `<task-notification>` XML in user-role messages containing `task-id`, `status`, `summary`, `result`, `usage`
- **TeamCreateTool/**: Higher-level team concept for persistent multi-agent swarms. Creates team file, resets task list, registers cleanup. Beyond our current scope.
- **Key insight**: Workers **cannot see the coordinator's conversation**. Every prompt must be self-contained. Coordinator must synthesize research findings before delegating implementation — never write "based on your findings."

**Infrastructure** ✅ (already built):
- `CoordinatorService.js`: `decompose()` (LLM-based task decomposition via Claude Sonnet, max 5 sub-tasks), `execute()` (parallel worktree spawning), `approveMerge()`, `abort()`, status polling, `_runWorker()` stub
- `MutationQueue.js`: Per-file-path FIFO mutex with `acquire()`/`release()`/`withLock()` — singleton pattern for concurrent write safety
- `coordinator.js` route: `POST /coordinator/{plan,execute,approve-merge,abort}`, `GET /coordinator/{status/:taskId,tasks}`
- `AgenticGitService.js` (tools-api): 5 worktree functions — `create`, `remove`, `merge` (`--no-ff`), `diff` (three-dot), `cleanup` (prune orphans from `/tmp/prism-worktrees/`)
- `AgenticRoutes.js`: `POST /agentic/git/worktree/{create,remove,merge,diff,cleanup}`
- `CoordinatorPanel.js` + CSS: Full lifecycle UI — Input → Plan Review (complexity badges) → Executing → Diff Review (+/- counts) → Approve & Merge / Reject & Cleanup
- Wired as `GitBranch` tab in Agent sidebar (`AgentComponent.js`)
- `AgenticTaskService.js`: Schema pre-wired with `owner`, `blocks`, `blockedBy`, `activeForm` fields for swarm coordination

**Implementation Components** 🔲 (7 components to build):

| # | Component | Description | Key Files |
|---|-----------|-------------|-----------|
| 1 | **Coordinator Tools** | `spawn_agent`, `send_message`, `stop_agent` tool schemas + dispatch | `ToolSchemaService`, `ToolOrchestratorService`, `AutoApprovalEngine` |
| 2 | **Worker Execution Engine** | Wire `AgenticLoopService.runAgenticLoop()` into `_runWorker()` with per-worker conversation context, AbortController, auto-approve, scoped tools | `CoordinatorService.js` |
| 3 | **Coordinator System Prompt** | Adapted from Claude Code's `getCoordinatorSystemPrompt()`: 4-phase workflow, tool usage examples, synthesization rules, continue-vs-spawn matrix | `CoordinatorPrompt.js` (new), `SystemPromptAssembler.js` |
| 4 | **Task Notification Pipeline** | `<task-notification>` XML generation + injection into coordinator's active conversation as user-role messages | `AgenticLoopService.js`, `CoordinatorService.js` |
| 5 | **Task System Activation** | Activate `owner`, `blocks`/`blockedBy` DAG enforcement, `task_claim` tool, `activeForm` UI text | `AgenticTaskService.js` |
| 6 | **Retina UI Updates** | Live worker status in CoordinatorPanel, tool result renderers for spawn/send/stop, `<task-notification>` card renderer | `CoordinatorPanel.js`, `ToolResultRenderers.js`, `MessageList.js` |
| 7 | **WebSocket Progress** | Replace polling with `coordinator_worker_update` push events | `coordinator.js` route |

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

| Tier | Risk | Tools | Behavior |
|---|---|---|---|
| **Tier 1: Auto-Approve** | Read-only / Scratchpad | `read_file`, `list_directory`, `grep_search`, `glob_files`, `web_search`, `fetch_url`, `multi_file_read`, `file_info`, `file_diff`, `git_status`, `git_diff`, `git_log`, `project_summary`, `task_create`, `task_get`, `task_list`, `task_update` | Always execute without prompting |
| **Tier 2: Configurable** | Write | `write_file`, `str_replace_file`, `patch_file`, `move_file`, `delete_file`, `browser_action` | Auto-approve when user enables "Auto Mode" toggle; otherwise prompt |
| **Tier 3: Always Prompt** | Destructive / Arbitrary | `execute_shell`, `execute_python`, `execute_javascript`, `run_command` | Always require explicit user approval |

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

### Phase 3: Multi-Agent & Autonomy ✅ COMPLETE (4/4 infrastructure)
1. ✅ **Coordinator Mode** — Infrastructure: `CoordinatorService`, `CoordinatorPanel`, git worktree endpoints, REST API. 🔲 Worker loop integration (wiring `AgenticLoopService` into `_runWorker`)
2. ✅ **Mutation Queue** — `MutationQueue.js`: per-path FIFO mutex singleton for concurrent write safety
3. ✅ **Memory Consolidation** — `MemoryConsolidationService`: scheduled 6h loop, audit trail, cost guard, real-time broadcast, UI history panel
4. ✅ **Browser Automation** — `AgenticBrowserService`: Playwright integration with `browser_action` tool, DOM inspection, screenshot persistence

### Phase 4: Hardening & Intelligence
1. ✅ **Token-Budget Truncation** — `ContextWindowManager`: three-strategy cascade (tool result truncation → old message compression → sliding window) wired into `AgenticLoopService` before every LLM call. Uses ~3.5 chars/token estimation, 80% utilization target, configurable per-model via `maxInputTokens`
2. ✅ **Dedicated Agent Endpoint** — `POST /agent` with SSE streaming + JSON fallback, approval endpoint, decoupled from `/chat`
3. ✅ **Exhaustion Recovery** — Final tool-free LLM pass on iteration limit, summarizes progress for user
4. ✅ **Local GPU Mutex** — `LocalModelQueue`: process-level lock preventing GPU collisions across chat + benchmark
5. ✅ **Request Iteration Logging** — Per-pass `RequestLogger.logChatGeneration()` with agenticIteration number, per-pass and overall usage aggregation
6. ✅ **Benchmarking System** — `BenchmarkService`: custom LLM accuracy benchmarking with multi-model comparison, provider-bucketed execution, multi-assertion evaluation, abort support, full UI dashboard
7. ✅ **Visual Workflow System** — `WorkflowAssembler` + `workflows.js`: node-based visual graph engine, MinIO file handling, full editor UI in Retina
8. ✅ **Task & State Management** — `AgenticTaskService`: MongoDB-backed persistent task list with `task_create`, `task_get`, `task_list`, `task_update`. Project-scoped, monotonic IDs, Tier 1 auto-approve. Schema pre-wired for swarm (`owner`, `blocks`, `blockedBy`)
9. 🔲 **Coordinator Worker Loop** — Wire `AgenticLoopService.runAgenticLoop()` into `CoordinatorService._runWorker()` so workers autonomously edit files
10. 🔲 **Slash Commands** — Parameterized prompt templates with `$1`, `$@` argument substitution
11. 🔲 **Per-Tool Tier Overrides UI** — Retina settings panel to customize Auto-Approval tiers per tool
12. 🔲 **Coordinator Conflict Resolution** — Interactive diff merge UI for worktree conflicts
13. 🔲 **Boot-Time Cleanup** — Prune orphan worktrees from `/tmp/prism-worktrees/` on Prism startup
14. 🔲 **Full Auto Confirmation Dialog** — Retina modal confirming the user wants to activate `autoApprove` mode before enabling it
15. 🔲 **Task Swarm Extensions** — `task_claim` (atomic acquisition + agent-busy check), `task_stop`/`task_output` (worker reporting), `blocks`/`blockedBy` DAG enforcement, `owner` field activation, `activeForm` spinner text, Coordinator WebSocket broadcast of task state changes

---

## 7. Known Gaps & Technical Debt

Identified gaps between the current implementation and production-grade robustness, ordered by impact.

### ⚠️ Test Coverage for Critical Paths
**Impact**: High — `AgenticLoopService` and `SystemPromptAssembler` lack automated tests. `ContextWindowManager` and `AutoApprovalEngine` now have full unit test coverage.

| Service | Testability | Status |
|---|---|---|
| `ContextWindowManager` | Pure logic, no I/O | ✅ 27 tests — token estimation, all 3 truncation strategies, budget math, edge cases |
| `AutoApprovalEngine` | Pure logic, no I/O | ✅ 59 tests — tier assignments (all 23 tools), overrides, labels, check/checkBatch, fullAuto, createHook |
| `AgenticLoopService` | Requires mocking | 🔲 Integration tests needed: mock provider streams, tool executor, hooks. Verify iteration counting, exhaustion recovery, approval flow |
| `SystemPromptAssembler` | Requires mocking | 🔲 Integration tests needed: mock tools-api, MongoDB, embedding service |

**Files**: `tests/contextWindowManager.test.js`, `tests/autoApprovalEngine.test.js`

### 🔲 Abort Propagation to Tool Processes
**Impact**: Medium — When a user aborts an agentic session (via disconnect or cancel), the `AbortController` signal stops the LLM stream and breaks the loop, but **in-flight tool executions may continue running** on `tools-api`.

**Current behavior**:
- `signal.aborted` → `stream.return()` breaks the LLM stream
- `Promise.all` of pending tool calls is not cancelled — HTTP requests to `tools-api` complete independently
- Shell processes spawned by `execute_shell`/`run_command` may keep running as orphans

**Gap**: No abort signal is forwarded to `ToolOrchestratorService.executeTool()` or the SSE streaming connection. `tools-api` has no abort/kill endpoint for in-flight processes.

**Mitigation path**:
1. Pass `signal` through to `executeTool()` / `executeToolStreaming()` and abort the `fetch()` calls
2. Add a `POST /compute/shell/kill/:pid` endpoint to `tools-api` for process-tree cleanup
3. Track spawned PIDs in `AgenticLoopService` and kill them in the `finally` block

### 🔲 Coordinator WebSocket Streaming
**Impact**: Low — The Coordinator Mode currently uses **polling** (`GET /coordinator/status/:taskId`) to track worker progress. This works but creates unnecessary request overhead and latency in the UI.

**Gap**: `CoordinatorService._runWorker()` does not emit events to a WebSocket channel. `CoordinatorPanel.js` polls on a timer instead of receiving push updates.

**Mitigation path**: Emit `coordinator_progress` events via the existing WebSocket broadcast infrastructure. Wire `CoordinatorService` to accept a `broadcast` callback (same pattern as `MemoryConsolidationService`).

### ⚠️ Token Estimation Accuracy
**Impact**: Low — `ContextWindowManager` uses a fixed `~3.5 chars/token` ratio for budget enforcement. This is intentionally conservative but has known limitations:

| Content Type | Actual Ratio | Estimation Accuracy |
|---|---|---|
| English prose | ~4.0 chars/token | Slightly over-estimates (safe) |
| Code (JS/Python) | ~3.5 chars/token | Accurate |
| CJK text | ~1.5 chars/token | **Under-estimates by ~2×** (risk of overflow) |
| JSON/structured data | ~3.0 chars/token | Slightly over-estimates (safe) |
| Base64 data | ~4.0 chars/token | Accurate |

**Current mitigation**: The `80%` utilization target (`TARGET_UTILIZATION = 0.80`) provides a 20% safety margin that absorbs most estimation errors. No production overflow incidents observed.

**Future improvement**: Per-model tokenizer integration (e.g. `tiktoken` for OpenAI, `@anthropic-ai/tokenizer` for Anthropic) would give exact counts but adds ~2ms latency per estimation and external dependencies. Only worth it if CJK-heavy workflows become common.

### 🔲 Tool Execution Sandboxing
**Impact**: Accepted risk — `execute_shell`, `execute_python`, `execute_javascript`, and `run_command` execute arbitrary code on the host system with the user's permissions. The **only** safety layer is the Tier 3 approval gate.

**Current design**: This is an intentional tradeoff for a local-first tool. The agent runs on the user's own machine with their own filesystem access — sandboxing would limit the agent's utility for its primary use case (autonomous coding).

**Noted risks**:
- `autoApprove` / Full Auto mode bypasses the approval gate entirely
- No audit log of executed commands beyond `RequestLogger` (queryable but not surfaced in UI)
- No resource limits (CPU, memory, disk) on spawned processes

**Possible future hardening** (if needed):
- Command allowlist/denylist patterns in `AutoApprovalEngine` (e.g. block `rm -rf /`, `sudo`, `curl | sh`)
- Per-session command audit panel in Retina
- Docker/container-based execution for untrusted tool calls

### 🔲 Undocumented Systems
**Impact**: Low — Several implemented systems are not covered in this design document because they are orthogonal to the agentic loop:

| System | Route | Service | Purpose |
|---|---|---|---|
| **Synthesis** | `/synthesis` | `synthesis.js` | User simulation — generates synthetic multi-turn conversations for testing and training |
| **VRAM Benchmarks** | `/vram-benchmarks` | `vram-benchmarks.js` | GPU memory profiling for local models across different quantizations |
| **Change Streams** | — | `ChangeStreamService.js` | MongoDB change stream watchers for real-time UI updates |
| **Request Logger** | — | `RequestLogger.js` | Structured logging of all LLM API calls with cost, latency, and usage metrics |

These are documented in their respective source files but excluded from this agentic architecture document to maintain focus.

---

## Appendix: Removed Features (Do Not Implement)

The following features were present in the original design document but were removed during the code-grounded review. They are preserved here for historical context.

### ❌ Daemon Mode & UDS Inbox (JSON-RPC)
> *Original*: Prism sessions will run in the background like system services. Multiple sessions communicate over Unix Domain Sockets (UDS Inbox) using JSON-RPC/JSONL.

**Why removed**: Prism is already an Express + WebSocket server on port 7777. Adding a parallel JSON-RPC/UDS transport creates two communication paths that must be kept in sync, doubling the API surface for zero user benefit. The existing WebSocket transport already supports everything this pattern described. UDS only makes sense for CLI-to-CLI IPC — Prism is a server, not a CLI tool.

### ❌ Anti-Distillation
> *Original*: Inject fake tool definitions to prevent competitors from scraping and training on successful trajectories.

**Why removed**: This is a concern for hosted public APIs, not a local-first tool. No competitor is scraping tool definitions from a local Prism instance. Adds unnecessary complexity and noise to the tool schema pipeline.

### ❌ Undercover Mode
> *Original*: A stealth logic block that strips all traces of AI involvement (e.g., commit messages, `Co-Authored-By` tags) when working in public repositories.

**Why removed**: Stripping AI attribution from public repos is deceptive and violates most open-source contribution guidelines. This has no place in a professional tool — design documents should focus on features that serve users, not adversarial posturing.

### ❌ LLM-Based YOLO Classifier
> *Original*: Use a dedicated side-query LLM layer (`classifyYoloAction`) to decide whether to auto-execute a tool.

**Why removed**: Not the feature itself (permission gating is critical), but the *implementation approach*. Using an LLM side-query for every tool call is expensive, slow (~500ms+ latency per classification), and unreliable. Replaced with the **Auto-Approval Engine** — a deterministic, rule-based three-tier system that achieves the same goal with zero latency and zero cost. LLM-based classification can be revisited as a Tier 2 fallback for ambiguous custom tools if needed.

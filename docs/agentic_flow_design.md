# Agentic Flow & Architecture: Retina & Prism Design

Based on analysis of state-of-the-art agent architectures (including open-source terminal agents like `pi-mono` and industry-standard patterns), here is a comprehensive breakdown of the agentic loop, architecture, and strategic roadmap for **Prism** (the local AI gateway) and **Retina** (the web UI).

> **Legend**: ✅ = Already implemented | ⚠️ = Partially implemented | 🔲 = Not started

---

## 1. The Core Agent Loop (The "11-Step Engine")

The Retina Agent executes a robust 11-step loop for every user interaction, built around streaming, context management, and recursive tool usage.

1. ✅ **User Input**: Captures input from the Retina UI via WebSocket (`/ws/chat`). Prism's `handleWsChat` handler receives JSON payloads and delegates to `handleChat()`.
2. ✅ **Message Creation**: Wraps text into standard LLM message formats via `expandMessagesForFC()`, normalizing across providers (OpenAI, Anthropic, Google, local).
3. ✅ **History Append**: Appends to a fast, in-memory `currentMessages` array within `AgenticLoopService`, backed by MongoDB persistence via `finalizeTextGeneration()` at loop end.
4. ✅ **System Prompt Assembly**: Dynamically builds the system prompt server-side via `SystemPromptAssembler`, registered as a `beforePrompt` hook in `AgentHooks`. The assembly pipeline:
   - ✅ Loads project-scoped memory from MongoDB via `AgentMemoryService` (embedding-based search)
   - ✅ Injects enabled tool schemas from `ToolOrchestratorService` (domain-grouped with parameter details)
   - ✅ Injects directory/file tree context from `tools-api` (cached 1 minute)
   - ✅ Injects environment info (date/time, OS, workspace)
   - 🔲 Apply token-budget–aware truncation to stay within context limits
5. ✅ **API Streaming**: Starts a streaming connection via `provider.generateTextStream()` or `provider.generateTextStreamLive()` for Live API models.
6. ✅ **Token Parsing**: Chunk processing loop handles: `text`, `thinking`, `toolCall`, `image`, `executableCode`, `codeExecutionResult`, `webSearchResult`, `audio`, and `status` chunk types.
7. ✅ **Tool Detection**: Resolves tool call chunks, including native MCP pass-through for LM Studio (`chunk.native === true`). Pre-flight permission checks are implemented via `AutoApprovalEngine` (three-tier system with `beforeToolCall` hook).
8. ✅ **Tool Loop**: Collects `passPendingToolCalls`, executes via `Promise.all`, appends results to context, and re-prompts the LLM automatically. Capped at `MAX_TOOL_ITERATIONS = 10`.
9. ✅ **Response Rendering**: Flushes final text to the WebSocket via `emit({ type: "chunk", content })`.
10. ✅ **Post-Sampling Hooks**: Background processes for memory extraction via `SessionSummarizer`, registered as an `afterResponse` hook. Uses Claude Haiku to extract 4-type memories (user, feedback, project, reference) and stores via `AgentMemoryService`. Token compaction is 🔲.
11. ✅ **Await Input**: The WebSocket connection stays open for the next message.

---

## 2. Real-World Implementation Patterns

Concrete software patterns for building and extending Prism's agent loop:

### ✅ Unified Extensions & Hooks System
The core logic must use an event-based hook system wrapping the `AgenticLoopService` while loop. Lifecycle events include:

| Event | Fires When | Use Case |
|---|---|---|
| `BeforePrompt` | Before system prompt assembly | Inject skills, memory, directory context |
| `BeforeToolCall` | Before each tool execution | Auto-Approval Engine permission check |
| `AfterToolCall` | After each tool returns | Logging, mutation tracking |
| `AfterResponse` | After final text is flushed | Session summarization, memory extraction |
| `OnError` | On any loop error | Error recovery, generating flag cleanup |

Implementation: `EventEmitter`-based, registered via a plugin array in `AgenticLoopService`.

### ⚠️ Robust Bash Execution Design (Exists)
`ToolOrchestratorService` already implements streaming shell execution:
- `execute_shell` → `/compute/shell/stream` (SSE)
- `execute_python` → `/utility/python/stream` (SSE)
- `execute_javascript` → `/compute/js/stream` (SSE)

All use POST + SSE streaming with 65s timeout, stdout/stderr separation, and exit code tracking. **Remaining gap**: PID/process-tree killing for runaway server processes needs hardening in `tools-api`.

### ✅ Skills System
Database-backed per-project skills stored in `agent_skills` MongoDB collection. Full CRUD via REST API (`/skills`), managed through the **SkillsPanel** tab in Retina's Agent page. `SystemPromptAssembler.fetchSkills()` queries enabled skills and injects them as `## Project Skills` context blocks into the system prompt. `AgenticLoopService` emits a `skills_injected` status event listing loaded skill names for the UI. **Files**: `prism/src/routes/skills.js`, `SystemPromptAssembler.js`, `retina/src/components/SkillsPanel.js`.

### 🔲 Prompt Templates & Slash Commands
Parameterized slash commands using bash-style argument substitution (`$1`, `$@`, `${@:start}`). Implementation lives in Retina's `ChatArea` component, expanding templates before sending to Prism.

### ✅ Tool Rendering Registry
Retina has `ToolResultRenderers.js` (624 lines) — a registry-based architecture where each tool type registers its own specialized renderer. Integrated into `MessageList.js` via `ToolResultView`. Includes:
- File tools → diff viewer with syntax highlighting
- Shell tools → terminal output panel with ANSI color support
- Search tools → result cards with file links
- Git tools → status/diff/log renderers

---

## 3. Prism / Retina Tool System

### Current Tool Inventory
Prism dynamically loads tool schemas from `tools-api/admin/tool-schemas` at boot via `ToolOrchestratorService.fetchSchemas()`. The current set includes file operations (`read_file`, `write_file`, `str_replace_file`, `patch_file`), search (`grep_search`, `glob_files`, `list_directory`), network (`fetch_url`, `web_search`), and execution (`execute_shell`, `execute_python`, `execute_javascript`).

Additionally, custom tools can be defined per-project in MongoDB (`custom_tools` collection) with arbitrary HTTP endpoints.

### Priority Additions

1. ✅ **MCP Client (Model Context Protocol)**:
   - **What**: Prism acts as an **MCP client**, connecting to external MCP servers and exposing their tools to the LLM.
   - **Implementation**: `MCPClientService` manages connections via `@modelcontextprotocol/sdk` (stdio + Streamable HTTP transports). Tools namespaced as `mcp__{server}__{tool}` and merged into `ToolOrchestratorService`. Managed via `/mcp-servers` REST API with CRUD + connect/disconnect endpoints. Retina MCPServersPanel in Agent sidebar. Auto-connect on startup.
   - **Files**: `MCPClientService.js`, `mcp-servers.js`, `ToolOrchestratorService.js`, `MCPServersPanel.js`

2. 🔲 **Browser Automation ("Computer Use")**:
   - **What**: Headless Playwright-based browser tool for SPA navigation, E2E testing, and visual QA.
   - **Why**: `fetch_url` can't handle JavaScript-rendered pages, authentication flows, or visual regression testing.
   - **Implementation**: `tools-api` spawns a Playwright browser instance, exposes actions (`navigate`, `click`, `type`, `screenshot`, `evaluate`) as tool parameters. Screenshots are uploaded to MinIO and returned as image references.

> **Design principle**: Optimize for the *right* tools at each capability tier, not raw count. Claude Code ships ~15 tools. Cursor ships fewer. Coverage of capability categories (filesystem, search, execution, network, browser) matters more than quantity.

---

## 4. Advanced Architectural Paradigms

### ✅ Bridge Mode (Already Implemented)
Retina (Web UI) connects to Prism (local gateway) over WebSocket. This is the existing architecture — Retina issues requests, Prism executes tools locally, streams results back. No additional work needed beyond hardening the connection lifecycle (reconnection, session resumption).

### ✅ UltraPlan (Planning Mode)
For tasks requiring extensive reasoning, the agent enters a dedicated planning loop:
1. ✅ Retina UI toggle activates "Plan First" mode (`planFirst` state in `AgentComponent`)
2. ✅ Prism injects a planning-specific system prompt via `PlanningModeService.preparePlanningPass()` — tools stripped
3. ✅ Plan is presented to the user in Retina via `PlanCardComponent` for review/approval
4. ✅ Only after explicit approval does execution begin (120s timeout, registry-based approval via `resolveApproval`)
5. ✅ Approved plan injected as context via `PlanningModeService.buildExecutionMessages()`

**Implementation**: Retina UI flag → Prism wraps the first LLM call with a planning system prompt → response rendered via `PlanCardComponent` → approved plan injected as context for execution calls.

### 🔲 Coordinator Mode (Multi-Agent Orchestration)
Retina can act as a manager, breaking a complex task into pieces and spawning parallel worker agents. **Scoped to a single concrete use case**: fan-out a refactoring task across N files in isolated git worktrees, then merge results.

- Prism spawns worker instances (forked `AgenticLoopService` runs) with isolated file contexts
- Each worker operates in a git worktree branch
- Results are merged via git and presented as a unified diff for review
- **Requires**: Mutation Queue (file-write serialization) to prevent conflicts

### ⚠️ Persistent Memory (Two-Phase)

**Phase A — Session Summarization** ✅:
`SessionSummarizer` runs as a fire-and-forget `afterResponse` hook, extracting memories via `claude-haiku-4-5` into a 4-type taxonomy (user, feedback, project, reference). Stored in `agent_memories` collection via `AgentMemoryService` with embedding-based duplicate detection (cosine similarity > 0.92 = skip). Memories include staleness caveats and age metadata for prompt injection.

**Phase B — Auto-Dream** (higher complexity, deferred):
Between sessions, a background inference loop reviews accumulated session summaries, identifies patterns, and consolidates knowledge into project-specific skill/memory files. Requires careful cost management to avoid burning API credits on low-value consolidation.

---

## 5. Permissions & Safety

### ✅ Auto-Approval Engine (Three-Tier System)
A **rule-based** permission system for tool execution, replacing the need for expensive LLM-based classification:

| Tier | Risk | Tools | Behavior |
|---|---|---|---|
| **Tier 1: Auto-Approve** | Read-only | `read_file`, `list_directory`, `grep_search`, `glob_files`, `web_search`, `fetch_url` | Always execute without prompting |
| **Tier 2: Configurable** | Write | `write_file`, `str_replace_file`, `patch_file` | Auto-approve when user enables "Auto Mode" toggle; otherwise prompt |
| **Tier 3: Always Prompt** | Destructive / Arbitrary | `execute_shell`, `execute_python`, `execute_javascript`, delete operations | Always require explicit user approval |

**Implementation**: ✅ Integrated via the `beforeToolCall` hook in `AgentHooks`. Default tier assignments in `AutoApprovalEngine.js`. Unknown tools default to Tier 2. `ApprovalCardComponent` renders approval UI in Retina. 🔲 Per-tool tier overrides in Retina settings UI not yet built (constructor accepts `tierOverrides` but no UI exposes it).

**Escape hatch**: ✅ `fullAuto` mode (via `options.autoApprove`) promotes all tools to Tier 1. 🔲 Retina confirmation dialog for activating Full Auto not yet implemented.

---

## 6. Engineering Guardrails

Principles to avoid common pitfalls seen in rigid agent codebases:

### ✅ Explicit State Machines over Ad-Hoc Control Flow
The `AgenticLoopService` implements a structured loop with clear state transitions via hooks and iteration tracking:

```
IDLE → ASSEMBLING (beforePrompt) → STREAMING → TOOL_GATING (beforeToolCall/approval) → TOOL_EXECUTING → afterToolCall → STREAMING → ... → FINALIZING (afterResponse) → IDLE
```

Planning mode adds a pre-loop state: `PLANNING → PLAN_APPROVAL → EXECUTING`. The `isGenerating` flag and `finally` cleanup ensure clean state transitions even on errors/aborts.

### ✅ Raw Token Integrity
Prism streams raw chunks (`emit({ type: "chunk", content })`) without transformation. All rendering (markdown, syntax highlighting, ANSI colors) happens client-side in Retina. This separation must be maintained — Prism should never mutate token content.

### ✅ Memory as a First-Class Citizen
`AgentMemoryService` is a fully generalized project-scoped memory system (stripped of Discord-specific fields). Uses embedding-based storage with cosine similarity search, 4-type taxonomy (user, feedback, project, reference), duplicate detection, and staleness caveats. Integrated into `SystemPromptAssembler.fetchMemories()` — relevant memories are injected into the system prompt on every agentic loop iteration.

### ✅ Client-Server Tool Decoupling
`ToolOrchestratorService` dynamically fetches schemas from `tools-api` at boot and proxies execution. Tool definitions live entirely in `tools-api` — Prism is transport-agnostic. This decoupling allows `tools-api` to add new tools without Prism changes.

---

## Strategic Roadmap for Prism & Retina

### Phase 1: Foundation & Planning ✅ COMPLETE
1. ✅ **Event Hook System** — `AgentHooks` (`EventEmitter`-based) with `beforePrompt`, `beforeToolCall`, `afterToolCall`, `afterResponse`, `onError` lifecycle events
2. ✅ **Dynamic System Prompt Assembly** — `SystemPromptAssembler`: tool schemas + project context + directory tree + environment + memory. 🔲 Token-budget truncation
3. ✅ **Auto-Approval Engine** — `AutoApprovalEngine`: three-tier system with `beforeToolCall` hook + `ApprovalCardComponent` UI
4. ✅ **UltraPlan Mode** — `PlanningModeService` + `PlanCardComponent`: plan → approve → execute workflow
5. ✅ **Session Summarization** — `SessionSummarizer` + `AgentMemoryService`: Claude Haiku extraction → 4-type memory taxonomy → MongoDB

### Phase 2: Memory & Extensibility (3/5 complete)
1. ✅ **Generalized MemoryService** — `AgentMemoryService`: project-scoped, embedding-based, 4-type taxonomy, duplicate detection, wired into `SystemPromptAssembler`
2. 🔲 **Skills System** — Markdown skill files scanned from project directory, injected into system prompt
3. ✅ **Tool Rendering Registry** — `ToolResultRenderers.js`: registry-based rendering with specialized components per tool domain
4. ✅ **MCP Client** — Prism connects to external MCP servers for third-party tool access
5. 🔲 **Slash Commands** — Parameterized prompt templates with argument substitution

### Phase 3: Multi-Agent & Autonomy
1. **Coordinator Mode** — Parallel file refactoring with git worktree isolation, scoped to fan-out/merge pattern
2. **Mutation Queue** — File-write serialization for concurrent agent sessions (required by Coordinator Mode)
3. **Auto-Dream** — Background inference for knowledge consolidation between sessions
4. **Browser Automation** — Headless Playwright integration in `tools-api` for E2E testing and visual QA

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

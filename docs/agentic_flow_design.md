# Agentic Flow & Architecture: Retina & Prism Design

Based on an in-depth analysis of state-of-the-art agent architectures (including open-source terminal agents like `pi-mono` and industry-standard leaked patterns), here is a comprehensive breakdown of the ideal agentic loop, architecture, and a strategic feature roadmap for what we must implement in **Prism** (the local runner) and **Retina** (the web UI).

## 1. The Core Agent Loop (The "11-Step Engine")

The Retina Agent will execute a robust 11-step loop for every user interaction, built around streaming, context management, and recursive tool usage. 

1. **User Input**: Captures input from the Retina UI or piped stdin via Prism.
2. **Message Creation**: Wraps text into standard LLM message formats.
3. **History Append**: Appends to a fast, in-memory chronological array.
4. **System Prompt Assembly**: Dynamically builds the system prompt, including tool definitions, directory context, and consolidated long-term memory.
5. **API Streaming**: Starts an SSE stream with the LLM API.
6. **Token Parsing**: Tokens are rendered immediately. Markdown is evaluated on the fly.
7. **Tool Detection**: Resolves tool call XML/JSON blocks, validates arguments, runs pre-flight permission checks (**"YOLO Classifier"**), and executes tools in parallel.
8. **Tool Loop**: Collects results, appends them to history, and re-triggers the LLM automatically.
9. **Response Rendering**: Flushes final text to the UI when no tools are called.
10. **Post-Sampling Hooks**: Background processes kick in (token compaction, memory extraction).
11. **Await Input**: The agent idles and awaits the next command.

---

## 2. Real-World Implementation Patterns

Based on studying mature implementations, here are the concrete software patterns we will use to build Prism's agent loop:

*   **Unified Extensions & Hooks System**: The core logic must use an event-based hook system (e.g., `BeforeAgentStartEvent`, `ToolCallEvent`, `ToolResultEvent`). This is the ideal place to inject the YOLO Risk Classifier without bloating the core loop.
*   **Mutation Queue Pattern**: To handle parallel tool execution safely, file writes and edits must be routed through a `file-mutation-queue`. This sequentially applies edits to prevent race conditions during heavy parallel refactoring.
*   **Robust Bash Execution Design**: A production-grade bash executor must handle: timeout management, streaming stdout/stderr, PID/process-tree killing (for hanging servers), and persistent logging of large outputs to temporary files to prevent OOM errors.
*   **"Skills" System**: Agent capabilities should be stored as Markdown files containing YAML frontmatter (`name`, `description`, `disable-model-invocation`). This allows for dynamic injection of project-specific context and logic.
*   **Prompt Templates & Slash Commands**: Advanced slash commands should use bash-style argument substitution (e.g., `$1`, `$@`, `${@:start}`) to easily trigger complex parameterized instructions.
*   **Thinking Labels & Artifact UI**: Decouple tool results from their UI representation using a "Tool Rendering Registry" in Retina, enabling rich HTML/SVG previews (Artifacts) and visual breakdown of the "Thinking" phases.

---

## 3. Prism / Retina Tool System

Currently, Retina has 9 foundational tools (`read_file`, `write_file`, `str_replace_file`, `patch_file`, `list_directory`, `grep_search`, `glob_files`, `fetch_url`, `web_search`). 

To reach parity with top-tier agents that feature 50+ tools and unlock true autonomy, we must prioritize:

### Highest Priority Additions
1. **Command Execution (`Bash` / `REPL`)**: 
   - **Why**: The agent must run tests (`npm run lint`, `pytest`) and interact with the system environment.
   - **Implementation**: Prism will use a robust bash execution design (with PID killing and temp logging) under the hood.
2. **Native Model Context Protocol (MCP)**: 
   - **Why**: Native MCP support instantly unlocks hundreds of community tools (GitHub, Postgres, Slack) without writing custom wrappers.
3. **Browser Automation ("Computer Use")**: 
   - **Why**: SPA navigation, E2E testing, and visual QA require a full headless browser or screenshot-based computer use tool, rather than just `fetch_url`.

---

## 4. Advanced Architectural Paradigms

We will architect Prism and Retina to support these cutting-edge agent paradigms:

> **Coordinator Mode (Multi-Agent Orchestration)**
> Retina can act as a manager, breaking a complex task into pieces, spawning parallel worker agents in **isolated git worktrees** (`--worktree`), and merging the results. Prism must support parallel daemon instances for large refactors.

> **Daemon Mode & UDS Inbox (JSON-RPC)**
> Prism sessions will run in the background like system services (similar to `docker ps`). If multiple sessions are running, they communicate with each other over **Unix Domain Sockets (UDS Inbox)**. Utilizing a JSON-RPC/JSONL daemon setup will simplify the connection between Prism and Retina.

> **Bridge Mode**
> Prism allows users to run the agent locally while controlling it securely from a browser. **This perfectly mirrors our Prism + Retina architecture**. Retina (Web UI) will seamlessly connect to, monitor, and approve permissions for a local Prism daemon.

> **Kairos & Auto-Dream (Persistent Memory)**
> The Retina Agent consolidates memory across sessions, keeping daily logs. Between sessions, "Auto-Dream" spins up a background inference loop to review what happened, what failed, and organizes knowledge. Prism will implement background "dreaming" processes to optimize long-term project memory.

> **UltraPlan**
> For tasks needing immense reasoning, it spins up a dedicated planning loop merely for exploration. Only once the comprehensive plan is generated and user-approved does execution begin.

---

## 5. Permissions, Security, and Telemetry

We will implement sophisticated internal controls to ensure system safety:

- **YOLO Classifier**: We will use a dedicated side-query LLM layer (`classifyYoloAction`) to decide whether it can safely auto-execute a tool (Risk levels: LOW/MEDIUM/HIGH) or if it must prompt the user for approval. We will implement this heuristic in `tools-api` using the Event Hooks system.
- **Anti-Distillation**: Injecting fake tool definitions to prevent competitors from scraping and training on successful trajectories.
- **Undercover Mode**: A stealth logic block that strips all traces of AI involvement (e.g., commit messages, `Co-Authored-By` tags) when working in public repositories.

---

## 6. Engineering Guardrails (Community Insights)

To avoid common pitfalls seen in rigid, older agent codebases, Prism and Retina must actively adhere to:

*   **Explicit State Machines over "Defensive Regexes"**: We must avoid "defensive programming," such as frustration regexes and unpredictable state rollbacks. **Prism must govern workflows via a rigid, external State Machine** (e.g., using `XState` or similar robust finite state machines) rather than relying on regex hacks to parse LLM outputs.
*   **Raw Token Integrity (Avoiding "Fancy" Transmutations)**: A major complaint about leading CLI agents is that they heavily rasterize/reformat text, converting simple ASCII into rich Unicode which breaks Unix pipes. **Retina must strictly separate UI rendering from the raw data payloads**, ensuring that terminal outputs and generated code maintain 100% byte-for-byte integrity. 
*   **Memory as a First-Class Citizen**: Without a native way to consolidate context, the architecture forces developers to babysit a leaky, ever-expanding context window. Implementing **Kairos/Auto-Dream (Persistent Memory)** is a fundamental requirement to prevent system fragility over long tasks.
*   **Client-Server Tool Decoupling**: We will create a highly generalized, simple set of tools on the client/runner (Prism) so that the Retina web layer can innovate rapidly without requiring frequent user updates to Prism.

---

## Strategic Roadmap for Prism & Retina

1. **Phase 1: Architecture & Execution**
   - Implement the **Event Hook System** to cleanly manage the agent lifecycle.
   - Implement `run_command` in `tools-api` prioritizing the **Robust Bash Execution** pattern (timeout management, PID trees, temp files).
   - Migrate to a JSON-RPC daemon to solidify **Bridge Mode** between Retina and Prism.
2. **Phase 2: Permissions & Planning**
   - Build the **"YOLO Classifier"** (hooked into `ToolCallEvent`) to auto-approve safe tools while strictly gating destructive commands.
   - Implement **Mutation Queues** to prevent file-write race conditions when executing tools in parallel.
   - Implement an **UltraPlan** equivalent in Retina, forcing a strict "Planning Phase" approval before massive execution begins.
3. **Phase 3: Multi-Agent & Memory**
   - Introduce **Coordinator Mode**: Allowing Prism to spawn background daemon branches for parallel work.
   - Build **Auto-Dream** background hooks to condense conversation histories into project-specific **Skills/Memory files**.

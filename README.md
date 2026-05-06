# Prism — AI Gateway

Centralized AI gateway that routes requests to **9 providers** (OpenAI, Anthropic, Google GenAI, ElevenLabs, Inworld, LM Studio, Ollama, llama.cpp, vLLM) through a unified REST + WebSocket API. Single entry point for the entire Sun ecosystem — every service and client proxies AI calls through Prism.

**Port:** `7777` · **Runtime:** Node.js (ES Modules) · **Framework:** Express 5 · **DB:** MongoDB · **Storage:** MinIO (S3-compat) · **Tests:** Vitest

## Architecture

### Directory Structure

```
prism-service/
├── src/
│   ├── middleware/          # Auth (dual-secret) + request logging
│   ├── providers/           # AI provider SDK integrations (9 providers)
│   ├── routes/              # Express route handlers (26 routes)
│   ├── services/            # Core business logic (30+ services)
│   ├── utils/               # Shared utilities
│   ├── websocket/           # WebSocket streaming handlers
│   └── wrappers/            # MongoDB + MinIO connection wrappers
├── tests/
│   └── live/                # Live integration tests (require running services)
├── scripts/                 # Migration + utility scripts
├── docs/                    # Design documentation
└── package.json
```

### Core Services

| Service | Purpose |
|---|---|
| **AgenticLoopService** | Server-side agentic tool-use loop — up to 100 iterations with parallel tool execution, streaming output, and auto-approval gating |
| **ToolOrchestratorService** | Central tool dispatcher — routes to tools-api or hosts 15+ Prism-local tools (think, sleep, plan mode, skills, worktree) |
| **CoordinatorService** | Multi-agent orchestration — spawns parallel workers in isolated git worktrees, routes to least-busy local inference instance |
| **SystemPromptAssembler** | Assembles 9-section agent system prompt (identity, tools, guidelines, environment, skills, memory) |
| **AgentPersonaRegistry** | In-memory persona registry (CODING, LUPOS, custom) with MongoDB persistence |
| **MemoryService** | Agent-scoped memory with embedding search + duplicate detection (cosine > 0.92) |
| **LocalProviderGateway** | Unified local model discovery, routing, capability detection, and VRAM estimation |
| **MCPClientService** | Model Context Protocol client — connects to external MCP servers |

## Supported Providers

| Provider | Text Gen | Streaming | TTS | STT | Image Gen | Vision | Embeddings | Thinking | Web Search | Code Exec |
|---|---|---|---|---|---|---|---|---|---|---|
| **OpenAI** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| **Anthropic** | ✅ | ✅ | — | — | — | ✅ | — | ✅ | ✅ | ✅ |
| **Google GenAI** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| **ElevenLabs** | — | — | ✅ | — | — | — | — | — | — | — |
| **Inworld** | — | — | ✅ | — | — | — | — | — | — | — |
| **LM Studio** | ✅ | ✅ | — | — | — | ✅ | — | — | — | — |
| **Ollama** | ✅ | ✅ | — | — | — | — | — | — | — | — |
| **llama.cpp** | ✅ | ✅ | — | — | — | — | — | — | — | — |
| **vLLM** | ✅ | ✅ | — | — | — | — | — | — | — | — |

## API Endpoints

### REST

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Health check — server info |
| `GET` | `/config` | Full model catalog with pricing, capabilities, and arena scores |
| `POST` | `/chat` | Primary text generation — REST + SSE streaming |
| `POST` | `/agent` | Agentic loop entry point |
| `POST` | `/coordinator` | Multi-agent coordination — task decomposition + parallel workers |
| `POST` | `/text-to-audio` | Text-to-speech (OpenAI, Google, ElevenLabs, Inworld) |
| `POST` | `/audio-to-text` | Speech-to-text (OpenAI Whisper, Google) |
| `POST` | `/media` | Image generation (DALL-E, Imagen) and vision |
| `POST` | `/embed` | Text embeddings via OpenAI |
| `GET` | `/conversations` | Conversation CRUD |
| `GET` | `/agent-sessions` | Agent session CRUD |
| `GET` | `/memory` | Memory management — list, store, delete, search |
| `GET` | `/workflows` | Multi-step workflow CRUD + execution |
| `GET` | `/benchmark` | Model benchmarking engine |
| `GET` | `/skills` | Agent skill definitions |
| `GET` | `/custom-tools` | User-defined tool CRUD |
| `GET` | `/custom-agents` | User-defined agent persona CRUD |
| `GET` | `/mcp-servers` | MCP server connection management |
| `GET` | `/lm-studio` | Local LM Studio model management |
| `GET` | `/settings` | User settings persistence |
| `GET` | `/favorites` | User model/tool favorites |

### WebSocket

| Endpoint | Description |
|---|---|
| `/ws/chat` | Streaming chat (delegates to chat handler) |
| `/ws/text-to-audio` | Streaming TTS (binary audio frames) |
| `/ws/live` | Persistent bidirectional Live API session (Gemini Live) |

### Admin (requires `x-admin-secret`)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/admin/requests` | Paginated request logs with filters |
| `GET` | `/admin/stats` | Aggregate stats (tokens, cost, latency) |
| `GET` | `/admin/stats/projects` | Per-project breakdown |
| `GET` | `/admin/stats/models` | Per-model breakdown |
| `GET` | `/admin/stats/endpoints` | Per-endpoint breakdown |
| `GET` | `/admin/stats/timeline` | Hourly request/cost timeline |
| `GET` | `/admin/health` | System health, memory, and DB stats |
| `GET` | `/admin/lm-studio/models` | List LM Studio models |
| `POST` | `/admin/lm-studio/load` | Load/unload LM Studio models |

## Prerequisites

- **Node.js** v20+ (ES Modules)
- **MongoDB** — conversation storage, request logging, memory
- **MinIO** _(optional)_ — S3-compatible object storage (falls back to MongoDB inline)

### Optional Provider Dependencies

Only needed for the corresponding providers:

- **OpenAI API Key** — GPT models, TTS, STT, embeddings, image generation
- **Anthropic API Key** — Claude models
- **Google GenAI API Key** — Gemini models, TTS, image generation
- **ElevenLabs API Key** — ElevenLabs TTS
- **Inworld Credentials** — Inworld TTS
- **LM Studio** — Local LLM inference (default `localhost:1234`)

## Tech Stack

| Dependency | Purpose |
|---|---|
| Express 5 | HTTP framework |
| MongoDB | Database driver |
| MinIO | S3-compatible object storage |
| ws | WebSocket streaming |
| Vitest | Testing framework |
| OpenAI / Anthropic / Google GenAI SDKs | Provider integrations |

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure secrets
cp secrets.example.js secrets.js
# Edit secrets.js with your API keys, MongoDB URI, etc.

# 3. Start the server
npm run dev        # Development (auto-reload with nodemon)
npm start          # Production
```

## Scripts

```bash
npm start            # Start server
npm run dev          # Start with auto-reload (nodemon)
npm run lint         # Run ESLint
npm run lint:fix     # Auto-fix lint issues
npm run format       # Format with Prettier
npm run format:check # Check formatting
npm test             # Run tests (vitest)
npm run test:watch   # Run tests in watch mode
```

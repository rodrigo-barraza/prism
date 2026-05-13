# Prism Service

Centralized AI gateway routing requests to **9 providers** (OpenAI, Anthropic, Google GenAI, ElevenLabs, Inworld, LM Studio, Ollama, llama.cpp, vLLM) through a unified REST + WebSocket API. Single entry point for the entire ecosystem.

**Port:** `7777` · **Runtime:** Node.js (ES Modules) · **Framework:** Express 5 · **DB:** MongoDB · **Storage:** MinIO

## Quick Start

```bash
cp secrets.example.js secrets.js   # API keys, MongoDB URI, etc.
npm install
npm run dev
```

## Provider Capabilities

| Provider | Text | Stream | TTS | STT | Image | Vision | Embed | Think | Search | Code |
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
| `POST` | `/chat` | Primary text generation — REST + SSE streaming |
| `POST` | `/agent` | Agentic loop entry point |
| `POST` | `/coordinator` | Multi-agent coordination — task decomposition + parallel workers |
| `POST` | `/text-to-audio` | TTS (OpenAI, Google, ElevenLabs, Inworld) |
| `POST` | `/audio-to-text` | STT (OpenAI Whisper, Google) |
| `POST` | `/media` | Image generation (DALL-E, Imagen) and vision |
| `POST` | `/embed` | Text embeddings via OpenAI |
| `GET` | `/config` | Full model catalog with pricing and capabilities |
| `GET` | `/conversations` | Conversation CRUD |
| `GET` | `/memory` | Memory management — list, store, delete, search |
| `GET` | `/workflows` | Multi-step workflow CRUD + execution |
| `GET` | `/benchmark` | Model benchmarking engine |
| `GET` | `/skills` | Agent skill definitions |
| `GET` | `/settings` | User settings persistence |

### WebSocket

| Endpoint | Description |
|---|---|
| `/ws/chat` | Streaming chat |
| `/ws/text-to-audio` | Streaming TTS (binary audio frames) |
| `/ws/live` | Persistent bidirectional Live API (Gemini Live) |

### Admin (requires `x-admin-secret`)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/admin/requests` | Paginated request logs with filters |
| `GET` | `/admin/stats` | Aggregate stats (tokens, cost, latency) |
| `GET` | `/admin/stats/models` | Per-model breakdown |
| `GET` | `/admin/stats/timeline` | Hourly request/cost timeline |
| `GET` | `/admin/health` | System health, memory, DB stats |
| `POST` | `/admin/lm-studio/load` | Load/unload LM Studio models |

## Core Services

| Service | Purpose |
|---|---|
| **AgenticLoopService** | Server-side tool-use loop — up to 100 iterations with parallel execution and auto-approval |
| **ToolOrchestratorService** | Central tool dispatcher — routes to tools-api or 15+ local tools |
| **CoordinatorService** | Multi-agent orchestration — parallel workers in isolated git worktrees |
| **SystemPromptAssembler** | 9-section agent system prompt (identity, tools, guidelines, environment, skills, memory) |
| **MemoryService** | Agent-scoped memory with embedding search + dedup (cosine > 0.92) |
| **LocalProviderGateway** | Local model discovery, routing, capability detection, VRAM estimation |
| **MCPClientService** | Model Context Protocol client — connects to external MCP servers |

## Scripts

```bash
npm start                       # Start server
npm run dev                     # Start with auto-reload (nodemon)
npm run lint                    # Run ESLint
npm run lint:fix                # Auto-fix lint issues
npm run format                  # Format with Prettier
npm run format:check            # Check formatting
npm test                        # Run tests (Vitest)
npm run test:watch              # Run tests in watch mode
npm run test:live               # Run live integration tests
npm run test:lm-studio          # Run LM Studio live tests
npm run vram:bench              # Run full VRAM benchmark
npm run vram:quick              # Quick VRAM benchmark (4k, 8k contexts)
npm run vram:model              # VRAM benchmark for single model
npm run consolidate             # Consolidate agent memories
npm run consolidate:all         # Consolidate all agent memories
npm run consolidate:history     # Consolidate memory history
npm run consolidate:dry         # Dry-run memory consolidation
npm run deploy                  # Deploy to production
npm run deploy:dry              # Validate deployment without deploying
```


# Prism — AI Gateway

A centralized Node.js backend that routes AI requests to multiple providers through a unified REST + WebSocket API. Supports text generation, image generation, text-to-speech, speech-to-text, embeddings, and more — all behind a single gateway with built-in request logging, cost tracking, and an admin API.

## ⚙️ Prerequisites

- **Node.js** v20+ (ES Modules)
- **MongoDB** — used for conversation storage and request logging
- **MinIO** _(optional)_ — object storage for uploaded files. If not configured, files are stored inline in MongoDB

### 🔌 Optional Provider Dependencies

These are only needed if you plan to use the corresponding providers:

- **OpenAI API Key** — for GPT models, TTS, STT, embeddings, and image generation
- **Anthropic API Key** — for Claude models
- **Google GenAI API Key** — for Gemini models, TTS, and image generation
- **ElevenLabs API Key** — for ElevenLabs TTS
- **Inworld Credentials** — for Inworld TTS (Base64-encoded `apiKey:apiSecret`)
- **LM Studio** — for local LLM inference (runs on `localhost:1234` by default)

## 🌐 Supported Providers

| Provider         | Text Gen | Streaming | TTS | STT | Image Gen | Vision | Embeddings | Thinking | Web Search | Code Exec |
| ---------------- | -------- | --------- | --- | --- | --------- | ------ | ---------- | -------- | ---------- | --------- |
| **OpenAI**       | ✅       | ✅        | ✅  | ✅  | ✅        | ✅     | ✅         | ✅       | ✅         | —         |
| **Anthropic**    | ✅       | ✅        | —   | —   | —         | ✅     | —          | ✅       | ✅         | ✅        |
| **Google GenAI** | ✅       | ✅        | ✅  | ✅  | ✅        | ✅     | —          | ✅       | ✅         | ✅        |
| **ElevenLabs**   | —        | —         | ✅  | —   | —         | —      | —          | —        | —          | —         |
| **Inworld**      | —        | —         | ✅  | —   | —         | —      | —          | —        | —          | —         |
| **LM Studio**    | ✅       | ✅        | —   | —   | —         | ✅     | —          | —        | —          | —         |

## 📂 Directory Structure

```
prism/
├── src/
│   ├── index.js                         # Application entry point, route mounting, DB init
│   ├── config.js                        # Model catalog, pricing, capabilities, arena scores
│   ├── constants.js                     # Shared constants and enums
│   ├── arrays.js                        # Static arrays (model lists, etc.)
│   ├── middleware/
│   │   ├── AuthMiddleware.js            # API key + admin secret auth
│   │   └── RequestLoggerMiddleware.js   # Per-request logging to MongoDB
│   ├── providers/                       # AI provider SDK integrations
│   │   ├── index.js                     # Provider registry and factory
│   │   ├── instance-registry.js         # Singleton provider instance cache
│   │   ├── openai.js                    # OpenAI (GPT, DALL-E, Whisper, TTS, embeddings)
│   │   ├── anthropic.js                 # Anthropic (Claude models)
│   │   ├── google.js                    # Google GenAI (Gemini, Imagen, TTS)
│   │   ├── elevenlabs.js               # ElevenLabs TTS
│   │   ├── inworld.js                   # Inworld TTS
│   │   ├── lm-studio.js                # LM Studio local inference
│   │   ├── ollama.js                    # Ollama local models
│   │   ├── llama-cpp.js                 # llama.cpp direct inference
│   │   └── vllm.js                      # vLLM server inference
│   ├── routes/                          # Express route handlers
│   │   ├── chat.js                      # /chat — text generation (REST + streaming)
│   │   ├── agent.js                     # /agent — agentic loop orchestration
│   │   ├── agent-sessions.js            # /agent-sessions — agent session CRUD
│   │   ├── agent-memories.js            # /agent-memories — agent memory management
│   │   ├── audio.js                     # /text-to-audio, /audio-to-text
│   │   ├── text.js                      # /text — plain text generation
│   │   ├── media.js                     # /media — image generation and vision
│   │   ├── embed.js                     # /embed — text embeddings
│   │   ├── conversations.js             # /conversations — conversation CRUD
│   │   ├── memory.js                    # /memory — memory management
│   │   ├── files.js                     # /files — file upload and retrieval
│   │   ├── config.js                    # /config — model catalog endpoint
│   │   ├── admin.js                     # /admin — analytics, stats, request logs
│   │   ├── stats.js                     # /stats — aggregate usage statistics
│   │   ├── workflows.js                 # /workflows — multi-step workflow management
│   │   ├── benchmark.js                 # /benchmark — model benchmarking
│   │   ├── synthesis.js                 # /synthesis — synthesis session management
│   │   ├── vram-benchmarks.js           # /vram-benchmarks — VRAM usage benchmarks
│   │   ├── coordinator.js               # /coordinator — multi-agent coordination
│   │   ├── lm-studio.js                # /lm-studio — local model management
│   │   ├── custom-tools.js             # /custom-tools — custom tool CRUD
│   │   ├── skills.js                    # /skills — agent skill definitions
│   │   ├── mcp-servers.js              # /mcp-servers — MCP server management
│   │   ├── favorites.js                 # /favorites — user favorites
│   │   └── settings.js                  # /settings — user settings management
│   ├── services/                        # Core business logic
│   │   ├── AgenticLoopService.js        # Agentic tool-use loop orchestrator
│   │   ├── ToolOrchestratorService.js   # Tool execution dispatcher
│   │   ├── CoordinatorService.js        # Multi-agent coordination engine
│   │   ├── CoordinatorPrompt.js         # System prompts for coordinator
│   │   ├── PlanningModeService.js       # Planning mode for agent sessions
│   │   ├── AgentPersonaRegistry.js      # Agent persona definitions registry
│   │   ├── AgentHooks.js                # Pre/post hooks for agent actions
│   │   ├── AutoApprovalEngine.js        # Auto-approve matching tool calls
│   │   ├── ConversationService.js       # Conversation CRUD and query
│   │   ├── MemoryService.js             # Legacy memory store
│   │   ├── MemoryExtractor.js           # Extracts memories from conversations
│   │   ├── MemoryConsolidationService.js # Scheduled memory consolidation
│   │   ├── EpisodicMemoryService.js     # Episodic memory (events, conversations)
│   │   ├── SemanticMemoryService.js     # Semantic memory (facts, knowledge)
│   │   ├── ProceduralMemoryService.js   # Procedural memory (how-to, skills)
│   │   ├── ProspectiveMemoryService.js  # Prospective memory (reminders, intentions)
│   │   ├── WorkingMemoryService.js      # Working memory (session context)
│   │   ├── SystemPromptAssembler.js     # Composes system prompts from context
│   │   ├── WorkflowAssembler.js         # Multi-step workflow assembly
│   │   ├── EmbeddingService.js          # Text embedding generation
│   │   ├── FileService.js               # File storage abstraction (MinIO/Mongo)
│   │   ├── RequestLogger.js             # Request log persistence
│   │   ├── SettingsService.js           # User settings persistence
│   │   ├── RateLimitStore.js            # Rate limit tracking
│   │   ├── BenchmarkService.js          # Model benchmarking engine
│   │   ├── LocalModelQueue.js           # FIFO queue for local model requests
│   │   ├── MCPClientService.js          # Model Context Protocol client
│   │   ├── ChangeStreamService.js       # MongoDB change stream for real-time updates
│   │   ├── ActiveGenerationTracker.js   # Tracks in-flight generation requests
│   │   └── MutationQueue.js             # Queued DB mutation processor
│   ├── utils/                           # Shared utilities
│   │   ├── utilities.js                 # General helpers
│   │   ├── errors.js                    # Error handler middleware
│   │   ├── logger.js                    # Styled console logger
│   │   ├── math.js                      # Math helpers
│   │   ├── media.js                     # Media processing helpers
│   │   ├── CostCalculator.js            # Per-model cost estimation
│   │   ├── ContextWindowManager.js      # Token budget and context trimming
│   │   ├── ConversationUtilities.js     # Conversation formatting helpers
│   │   ├── FunctionCallingUtilities.js  # Tool/function call formatting
│   │   ├── RequestContext.js            # Per-request context propagation
│   │   ├── SseUtilities.js              # Server-Sent Events helpers
│   │   ├── StreamChunkDispatcher.js     # Streaming chunk routing
│   │   ├── ThinkTagParser.js            # Parses <think> tags from model output
│   │   ├── openai-compat.js             # OpenAI compatibility layer
│   │   ├── gguf-arch.js                 # GGUF model architecture parser
│   │   └── rateLimits.js                # Rate limit utilities
│   ├── websocket/
│   │   └── index.js                     # WebSocket server setup (streaming)
│   └── wrappers/
│       ├── MongoWrapper.js              # MongoDB connection and DB accessor
│       └── MinioWrapper.js              # MinIO S3-compatible client wrapper
├── tests/                               # Vitest test suites
│   ├── setup.js                         # Test setup and fixtures
│   ├── auth.test.js                     # Auth middleware tests
│   ├── config.test.js                   # Config endpoint tests
│   ├── health.test.js                   # Health check tests
│   ├── textToText.test.js              # Text generation tests
│   ├── textToImage.test.js             # Image generation tests
│   ├── imageToText.test.js             # Vision tests
│   ├── textToSpeech.test.js            # TTS tests
│   ├── costCalculation.test.js         # Cost calculation tests
│   ├── contextWindowManager.test.js    # Context window tests
│   ├── configUtils.test.js             # Config utility tests
│   ├── modalityToEmbedding.test.js     # Embedding tests
│   ├── tokenCostAccuracy.test.js       # Token cost accuracy tests
│   ├── autoApprovalEngine.test.js      # Auto-approval engine tests
│   └── live/                            # Live integration tests (require running services)
├── scripts/                             # Utility and migration scripts
│   ├── backfill-session-ids.js          # Backfill session IDs migration
│   ├── migrate-fix-endpoint-operation.js # Fix endpoint operation field migration
│   ├── migrate-memories.js             # Memory schema migration
│   ├── migrate-operation-field.js       # Operation field migration
│   ├── vllm-serve.sh                   # vLLM server launch script
│   ├── vram-bench.js                   # VRAM benchmarking script
│   └── vram-chart.html                 # VRAM benchmark visualization
├── docs/                                # Design documentation
├── secrets.example.js                   # Template for secrets.js
├── eslint.config.js                     # ESLint flat config
├── vitest.config.js                     # Vitest config
├── vitest.live.config.js               # Vitest config for live tests
├── .prettierrc                          # Prettier config
└── package.json                         # Dependencies and npm scripts
```

## 🛠️ Tech Stack

| Dependency | Purpose |
| --- | --- |
| Node.js | Runtime |
| Express | HTTP framework |
| MongoDB | Database driver |
| MinIO | S3-compatible object storage |
| ws | WebSockets for streaming |
| Vitest | Testing framework |
| Auth Providers | OpenAI, Anthropic, Google GenAI SDKs |

## 🚀 Setup

### 1️⃣ Install dependencies

```bash
npm install
```

### 2️⃣ Configure secrets

```bash
cp secrets.example.js secrets.js
```

Edit `secrets.js` and fill in your API keys and configuration:

| Secret              | Required | Description                                            |
| ------------------- | -------- | ------------------------------------------------------ |
| `PORT`              | Yes      | Server port (default: `3000`)                          |
| `GATEWAY_SECRET`    | Yes      | API auth secret — clients send via `x-api-secret`     |
| `ADMIN_SECRET`      | Yes      | Admin auth secret — sent via `x-admin-secret`         |
| `OPENAI_API_KEY`    | No       | OpenAI API key                                         |
| `ANTHROPIC_API_KEY` | No       | Anthropic API key                                      |
| `GOOGLE_API_KEY`    | No       | Google GenAI API key                                   |
| `ELEVENLABS_API_KEY`| No       | ElevenLabs API key                                     |
| `INWORLD_BASIC`     | No       | Base64-encoded Inworld credentials                     |
| `LM_STUDIO_BASE_URL`| No      | LM Studio URL (default: `http://localhost:1234`)       |
| `MONGO_URI`         | Yes      | MongoDB connection string                              |
| `MONGO_DB_NAME`     | Yes      | MongoDB database name                                  |
| `MINIO_ENDPOINT`    | No       | MinIO endpoint                                         |
| `MINIO_ACCESS_KEY`  | No       | MinIO access key                                       |
| `MINIO_SECRET_KEY`  | No       | MinIO secret key                                       |
| `MINIO_BUCKET_NAME` | No       | MinIO bucket name                                      |

### 3️⃣ Start the server

```bash
npm run dev        # Development (auto-reload with nodemon)
npm start          # Production
```

## 📡 API Endpoints

All endpoints except `/` and `/admin/*` require the `x-api-secret` header.

### REST

| Method | Endpoint            | Description                       |
| ------ | ------------------- | --------------------------------- |
| GET    | `/`                 | Health check — server info        |
| GET    | `/config`           | Full model catalog and options    |
| POST   | `/text-to-text`     | Text/chat generation              |
| POST   | `/text-to-image`    | Image generation                  |
| POST   | `/image-to-text`    | Vision / image description        |
| POST   | `/text-to-speech`   | Text-to-speech (returns audio)    |
| POST   | `/audio-to-text`    | Speech-to-text transcription      |
| POST   | `/text-to-embedding`| Text embeddings                   |
| GET    | `/conversations`    | List saved conversations          |
| POST   | `/conversations`    | Save a conversation               |
| GET    | `/conversations/:id`| Get a conversation by ID          |
| DELETE | `/conversations/:id`| Delete a conversation             |
| GET    | `/files/:key`       | Retrieve a file from storage      |

### WebSocket

| Endpoint                     | Description                       |
| ---------------------------- | --------------------------------- |
| `/text-to-text/stream`       | Streaming text generation         |
| `/text-to-speech/stream`     | Streaming TTS (ElevenLabs)        |

### Admin (requires `x-admin-secret`)

| Method | Endpoint                      | Description                               |
| ------ | ----------------------------- | ----------------------------------------- |
| GET    | `/admin/requests`             | Paginated request logs with filters       |
| GET    | `/admin/requests/:id`         | Single request detail                     |
| GET    | `/admin/stats`                | Aggregate stats (tokens, cost, latency)   |
| GET    | `/admin/stats/projects`       | Per-project breakdown                     |
| GET    | `/admin/stats/models`         | Per-model breakdown                       |
| GET    | `/admin/stats/endpoints`      | Per-endpoint breakdown                    |
| GET    | `/admin/stats/timeline`       | Hourly request/cost timeline              |
| GET    | `/admin/conversations`        | Cross-project conversation list           |
| GET    | `/admin/conversations/:id`    | Full conversation with messages           |
| GET    | `/admin/live`                 | Live activity — recent conversations      |
| GET    | `/admin/health`               | System health, memory, and DB stats       |
| GET    | `/admin/lm-studio/models`     | List LM Studio models                     |
| POST   | `/admin/lm-studio/load`       | Load a model in LM Studio                 |
| POST   | `/admin/lm-studio/unload`     | Unload a model from LM Studio             |

## ✨ Features

- **Unified Gateway** — single API for 6 AI providers
- **WebSocket Streaming** — real-time text generation and TTS
- **Request Logging** — every request is logged to MongoDB with tokens, cost, and latency
- **Cost Tracking** — per-model pricing with automatic cost estimation
- **Conversation Persistence** — save/load chat history in MongoDB
- **File Storage** — MinIO object storage with MongoDB fallback
- **Admin API** — analytics, stats, request inspection, and LM Studio management
- **Auth Middleware** — separate secrets for client API and admin access
- **Model Catalog** — centralized model definitions with pricing, capabilities, and arena scores

## 📜 Scripts

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

## ☀️ Part of [Sun](https://github.com/rodrigo-barraza)

Prism is one service in the Sun ecosystem — a collection of composable backend services and frontends designed to be mixed and matched.

// ============================================================
// Prism the AI Gateway — Secrets Template
// ============================================================
// Prism resolves secrets from (in priority order):
//   1. process.env (manual env vars, Docker --env)
//   2. Vault service (via src/boot.js → VAULT_URL + VAULT_TOKEN)
//   3. Fallback .env file (../vault/.env)
//
// All secrets are read from process.env — configure them via
// your Vault master .env, or set them as environment variables.
//
// See vault/.env.example for the full list of variables.
// ============================================================
// This file (secrets.js) is a process.env shim and does NOT
// need to be edited for normal operation. The values below are
// the env var names and their defaults.
// ============================================================

// Server
// PRISM_PORT=7777

// OpenAI
// OPENAI_API_KEY=

// Anthropic
// ANTHROPIC_API_KEY=

// Google GenAI
// GOOGLE_API_KEY=

// ElevenLabs
// ELEVENLABS_API_KEY=

// Inworld (Base64-encoded apiKey:apiSecret)
// INWORLD_BASIC=

// Local Providers (indexed env vars)
// Each instance is defined with indexed keys: _<N>_URL, _<N>_CONCURRENCY, _<N>_NICKNAME
//
// LM Studio
// PROVIDER_LM_STUDIO_1_URL=http://localhost:1234
// PROVIDER_LM_STUDIO_1_CONCURRENCY=1
// PROVIDER_LM_STUDIO_1_NICKNAME=
//
// vLLM
// PROVIDER_VLLM_1_URL=
// PROVIDER_VLLM_1_CONCURRENCY=
//
// Ollama
// PROVIDER_OLLAMA_1_URL=http://localhost:11434
// PROVIDER_OLLAMA_1_CONCURRENCY=1
//
// llama.cpp (llama-server)
// PROVIDER_LLAMA_CPP_1_URL=http://localhost:8080
// PROVIDER_LLAMA_CPP_1_CONCURRENCY=1

// Mongo
// MONGO_URI=mongodb://user:password@<host>:27017/?directConnection=true&replicaSet=rs0&authSource=admin
// PRISM_MONGO_DB_NAME=prism

// MinIO (Optional — files stored inline in MongoDB if not set)
// MINIO_ENDPOINT=
// MINIO_ACCESS_KEY=
// MINIO_SECRET_KEY=
// PRISM_MINIO_BUCKET_NAME=prism

// Tools API (workspace config is fetched from tools-api at startup)
// TOOLS_API_URL=http://localhost:5590

// Vault
// VAULT_URL=http://192.168.86.2:5599
// VAULT_TOKEN=

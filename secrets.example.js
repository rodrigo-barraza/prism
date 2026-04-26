// ============================================================
// Prism the AI Gateway — Secrets Template
// ============================================================
// Copy this file to secrets.js and fill in your real values.
//   cp src/secrets.example.js src/secrets.js
// ============================================================

// Server
export const PRISM_PORT = 3000;



// OpenAI
export const OPENAI_API_KEY = '';

// Anthropic
export const ANTHROPIC_API_KEY = '';

// Google GenAI
export const GOOGLE_API_KEY = '';

// ElevenLabs
export const ELEVENLABS_API_KEY = '';

// Inworld (Base64-encoded apiKey:apiSecret)
export const INWORLD_BASIC = '';

// Local Providers
// Each entry is an instance: { url, concurrency, nickname? }
// Multiple entries = multiple instances (auto-numbered #1, #2, ...)
// nickname (optional) = display label shown in UI, e.g. "Desktop" → "LM Studio (Desktop)"
// Empty array = provider not configured

// LM Studio
export const PROVIDER_LM_STUDIO = [
  { url: 'http://localhost:1234', concurrency: 1, nickname: '' },
];

// vLLM
export const PROVIDER_VLLM = [];

// Ollama
export const PROVIDER_OLLAMA = [
  { url: 'http://localhost:11434', concurrency: 1 },
];

// llama.cpp (llama-server)
export const PROVIDER_LLAMA_CPP = [
  { url: 'http://localhost:8080', concurrency: 1 },
];

// Mongo
export const MONGO_URI = 'mongodb://user:password@<host>:27017/?directConnection=true&replicaSet=rs0&authSource=admin';
export const MONGO_DB_NAME = '';

// MinIO (Optional — files stored inline in MongoDB if not set)
export const MINIO_ENDPOINT = '';
export const MINIO_ACCESS_KEY = '';
export const MINIO_SECRET_KEY = '';
export const MINIO_BUCKET_NAME = '';

// Tools API (workspace config is fetched from tools-api at startup)
export const TOOLS_API_URL = 'http://localhost:5590';

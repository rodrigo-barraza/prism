// ============================================================
// Prism the AI Gateway — Secrets Template
// ============================================================
// Copy this file to secrets.js and fill in your real values.
//   cp src/secrets.example.js src/secrets.js
// ============================================================

// Server
export const PORT = 3000;



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

// LM Studio (Local LLM Server)
export const LM_STUDIO_BASE_URL = 'http://localhost:1234';

// vLLM (Local LLM Server)
export const VLLM_BASE_URL = '';

// Ollama (Local LLM Server)
export const OLLAMA_BASE_URL = 'http://localhost:11434';

// llama.cpp (Local LLM Server — llama-server default port 8080)
export const LLAMA_CPP_BASE_URL = 'http://localhost:8080';

// Local Model Concurrency (default for instances that don't specify their own)
export const LOCAL_MODEL_CONCURRENCY = 1;

// Additional Local Provider Instances (optional)
// Each entry creates a new provider instance at a different URL.
// type: lm-studio | ollama | vllm | llama-cpp
// Instances are auto-numbered: the default (above) is #1, first extra = #2, etc.
// concurrency: max simultaneous GPU inference requests (defaults to LOCAL_MODEL_CONCURRENCY)
export const LOCAL_PROVIDER_INSTANCES = [
  // { type: 'lm-studio', baseUrl: 'http://192.168.86.100:1234', concurrency: 1 },
  // { type: 'ollama', baseUrl: 'http://192.168.86.100:11434', concurrency: 2 },
];

// Mongo
export const MONGO_URI = 'mongodb://192.168.86.2:27017/?directConnection=true&replicaSet=rs0';
export const MONGO_DB_NAME = '';

// MinIO (Optional — files stored inline in MongoDB if not set)
export const MINIO_ENDPOINT = '';
export const MINIO_ACCESS_KEY = '';
export const MINIO_SECRET_KEY = '';
export const MINIO_BUCKET_NAME = '';

// Tools API (workspace config is fetched from tools-api at startup)
export const TOOLS_API_URL = 'http://localhost:5590';

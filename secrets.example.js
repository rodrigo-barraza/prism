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

// Mongo
export const MONGO_URI = 'mongodb://127.0.0.1:27017';
export const MONGO_DB_NAME = '';

// MinIO (Optional — files stored inline in MongoDB if not set)
export const MINIO_ENDPOINT = '';
export const MINIO_ACCESS_KEY = '';
export const MINIO_SECRET_KEY = '';
export const MINIO_BUCKET_NAME = '';

// Tools API
export const TOOLS_API_URL = 'http://localhost:5590';

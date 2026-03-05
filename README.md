# Prism the AI Gateway

A centralized Node.js backend that routes AI requests to multiple providers through a unified API.

## Supported Providers

| Provider              | Text Gen | Streaming | TTS | Image Gen | Vision | Embeddings |
| --------------------- | -------- | --------- | --- | --------- | ------ | ---------- |
| **OpenAI**            | ✅       | ✅        | ✅  | —         | ✅     | ✅         |
| **Anthropic**         | ✅       | ✅        | —   | —         | —      | —          |
| **Google GenAI**      | ✅       | ✅        | ✅  | ✅        | ✅     | —          |
| **ElevenLabs**        | —        | —         | ✅  | —         | —      | —          |
| **OpenAI-Compatible** | ✅       | —         | —   | —         | ✅     | —          |

## Setup

```bash
npm install
cp .env.example .env
# Add your API keys to .env
npm start
```

## API Endpoints

### REST

#### `GET /`

Health check — returns server info, available providers, and endpoints.

#### `POST /text-to-text`

```json
{
  "provider": "openai",
  "model": "gpt-4o-mini",
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

#### `POST /text-to-image`

```json
{ "provider": "google", "prompt": "A sunset over mountains" }
```

#### `POST /image-to-text`

```json
{
  "provider": "openai",
  "image": "https://example.com/photo.jpg",
  "prompt": "Describe this image"
}
```

#### `POST /text-to-speech`

```json
{ "provider": "openai", "text": "Hello world", "voice": "echo" }
```

Returns binary audio stream.

#### `POST /text-to-embedding`

```json
{ "provider": "openai", "text": "Hello world" }
```

### WebSocket

#### `ws://localhost:3000/text-to-text/stream`

Send: `{ "provider": "openai", "model": "gpt-4o-mini", "messages": [...] }`  
Receive: `{ "type": "chunk", "content": "..." }` → `{ "type": "done" }`

#### `ws://localhost:3000/text-to-speech/stream`

1. Send config: `{ "provider": "elevenlabs", "voiceId": "..." }`
2. Receive: `{ "type": "ready" }`
3. Send text strings as chunks
4. Send `__END__` to finish
5. Receive binary audio frames → `{ "type": "done" }`

## Scripts

```bash
npm start          # Start server
npm run dev        # Start with --watch
npm run lint       # Run ESLint
npm run lint:fix   # Auto-fix lint issues
npm run format     # Format with Prettier
npm run format:check  # Check formatting
```

# Provider Message Format Comparison

> [!NOTE]
> All examples below are at the **raw REST API / JSON level** — the canonical wire format. SDK wrappers abstract these, but this is what actually hits the API.

---

## 1. Top-Level Request Structure

| Aspect | OpenAI (Chat Completions) | Anthropic (Messages) | Google Gemini (GenerateContent) |
|---|---|---|---|
| **Endpoint** | `POST /v1/chat/completions` | `POST /v1/messages` | `POST /v1beta/models/{model}:generateContent` |
| **System prompt** | Inside `messages[]` as `role: "system"` | Top-level `system` field (string or content blocks) | Top-level `system_instruction` object with `parts[]` |
| **Conversation** | `messages[]` array | `messages[]` array | `contents[]` array |
| **Tools** | Top-level `tools[]` array | Top-level `tools[]` array | Top-level `tools[]` array (wraps `functionDeclarations`) |
| **Role vocabulary** | `system`, `user`, `assistant`, `tool` | `user`, `assistant` (system is separate) | `user`, `model` (system is separate) |

---

## 2. System Prompt

### OpenAI
```json
{
  "model": "gpt-4o",
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant."
    },
    {
      "role": "user",
      "content": "Hello"
    }
  ]
}
```
> System prompt lives **inside** the `messages[]` array as `role: "system"`. Can also use `role: "developer"` for developer-level instructions.

### Anthropic
```json
{
  "model": "claude-opus-4-6",
  "max_tokens": 1024,
  "system": "You are a helpful assistant.",
  "messages": [
    {
      "role": "user",
      "content": "Hello"
    }
  ]
}
```
> System prompt is a **top-level `system` field**, separate from `messages[]`. Can be a string or an array of content blocks:
> ```json
> "system": [
>   { "type": "text", "text": "You are a helpful assistant." }
> ]
> ```
> Also supports `cache_control` for prompt caching:
> ```json
> "system": [
>   { "type": "text", "text": "...", "cache_control": { "type": "ephemeral" } }
> ]
> ```

### Google Gemini
```json
{
  "system_instruction": {
    "parts": [
      { "text": "You are a helpful assistant." }
    ]
  },
  "contents": [
    {
      "role": "user",
      "parts": [{ "text": "Hello" }]
    }
  ]
}
```
> System prompt is a **top-level `system_instruction` object** with the same `parts[]` structure as messages. Passed via `config.systemInstruction` in SDKs.

---

## 3. User & Assistant Messages

### OpenAI
```json
{
  "messages": [
    { "role": "user", "content": "What's the weather?" },
    { "role": "assistant", "content": "Let me check that for you." },
    { "role": "user", "content": "Thanks!" }
  ]
}
```
> Content can be a **string** or an **array of content parts** (for multimodal):
> ```json
> { "role": "user", "content": [
>   { "type": "text", "text": "What's in this image?" },
>   { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
> ]}
> ```

### Anthropic
```json
{
  "messages": [
    { "role": "user", "content": "What's the weather?" },
    { "role": "assistant", "content": "Let me check that for you." },
    { "role": "user", "content": "Thanks!" }
  ]
}
```
> Content can be a **string** or an **array of content blocks**:
> ```json
> { "role": "user", "content": [
>   { "type": "text", "text": "What's in this image?" },
>   { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } }
> ]}
> ```
> Messages **must alternate** between `user` and `assistant`. First message must be `user`.

### Google Gemini
```json
{
  "contents": [
    { "role": "user", "parts": [{ "text": "What's the weather?" }] },
    { "role": "model", "parts": [{ "text": "Let me check that for you." }] },
    { "role": "user", "parts": [{ "text": "Thanks!" }] }
  ]
}
```
> Uses **`role: "model"`** instead of `"assistant"`. Each message has `parts[]` array which can contain `text`, `inlineData`, `functionCall`, `functionResponse`, etc.

---

## 4. Tool Definitions

### OpenAI
```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather for a location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": { "type": "string", "description": "City name" },
            "unit": { "type": "string", "enum": ["celsius", "fahrenheit"] }
          },
          "required": ["location"]
        }
      }
    }
  ]
}
```
> Wrapped in `type: "function"` → `function: { ... }`. Parameters use **JSON Schema**.

### Anthropic
```json
{
  "tools": [
    {
      "name": "get_weather",
      "description": "Get the current weather for a location",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": { "type": "string", "description": "City name" },
          "unit": { "type": "string", "enum": ["celsius", "fahrenheit"] }
        },
        "required": ["location"]
      }
    }
  ]
}
```
> Flat structure — `name`, `description`, `input_schema`. Schema goes in **`input_schema`** (not `parameters`). Uses JSON Schema.

### Google Gemini
```json
{
  "tools": [
    {
      "functionDeclarations": [
        {
          "name": "get_weather",
          "description": "Get the current weather for a location",
          "parameters": {
            "type": "object",
            "properties": {
              "location": { "type": "string", "description": "City name" },
              "unit": { "type": "string", "enum": ["celsius", "fahrenheit"] }
            },
            "required": ["location"]
          }
        }
      ]
    }
  ]
}
```
> Tools contain **`functionDeclarations[]`** array. Each declaration has `name`, `description`, `parameters`. Uses OpenAPI schema subset.

---

## 5. Tool Calls (Model Response)

### OpenAI
The assistant message contains a **`tool_calls[]`** array:
```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": "{\"location\": \"San Francisco\", \"unit\": \"celsius\"}"
      }
    }
  ]
}
```
> - `tool_calls[].id` — unique ID to correlate with the result
> - `function.arguments` — **stringified JSON** (not a parsed object!)
> - `content` is typically `null` when tool calls are present (but can include text)
> - `stop_reason` / `finish_reason` = `"tool_calls"`

### Anthropic
The assistant message's `content[]` contains **`tool_use` blocks**:
```json
{
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "Let me check the weather for you."
    },
    {
      "type": "tool_use",
      "id": "toolu_01A09q90qw90lq917835lks09",
      "name": "get_weather",
      "input": {
        "location": "San Francisco",
        "unit": "celsius"
      }
    }
  ],
  "stop_reason": "tool_use"
}
```
> - Tool calls are **content blocks** with `type: "tool_use"` inside the regular `content[]` array
> - `id` — unique ID for correlation
> - `input` — **parsed object** (not stringified!)
> - Can mix `text` and `tool_use` blocks in same response
> - `stop_reason` = `"tool_use"`

### Google Gemini
The model response `content.parts[]` contains **`functionCall` parts**:
```json
{
  "candidates": [{
    "content": {
      "role": "model",
      "parts": [
        {
          "functionCall": {
            "name": "get_weather",
            "args": { "location": "San Francisco", "unit": "celsius" },
            "id": "8f2b1a3c"
          }
        }
      ]
    },
    "finishReason": "STOP"
  }]
}
```
> - Tool calls are **parts** with a `functionCall` object
> - `id` — unique identifier (Gemini 2.0+ always returns this)
> - `args` — **parsed object**
> - Multiple function calls = multiple parts in the same response

---

## 6. Tool Results (Sending Back to Model)

### OpenAI
Add a **`role: "tool"`** message with matching `tool_call_id`:
```json
{
  "messages": [
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        { "id": "call_abc123", "type": "function", "function": { "name": "get_weather", "arguments": "{\"location\":\"SF\"}" } }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_abc123",
      "content": "{\"temperature\": 18, \"unit\": \"celsius\", \"condition\": \"foggy\"}"
    }
  ]
}
```
> - Dedicated `role: "tool"` message type
> - `tool_call_id` matches the `id` from the assistant's `tool_calls[]`
> - `content` is a **string** (typically stringified JSON)

### Anthropic
Add a **`user` message** containing a **`tool_result` block**:
```json
{
  "messages": [
    {
      "role": "assistant",
      "content": [
        { "type": "tool_use", "id": "toolu_01A09q90qw90lq917835lks09", "name": "get_weather", "input": { "location": "SF" } }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_01A09q90qw90lq917835lks09",
          "content": "Temperature is 18°C and foggy."
        }
      ]
    }
  ]
}
```
> - Tool results go inside a **`user` role** message (maintains alternation!)
> - `type: "tool_result"` block with `tool_use_id` matching the `id` from `tool_use`
> - `content` can be a string or an array of content blocks (text, image, etc.)
> - Can also include `is_error: true` to signal failure

### Google Gemini
Append the model's response, then add a **`user` content** with a **`functionResponse` part**:
```json
{
  "contents": [
    {
      "role": "model",
      "parts": [
        { "functionCall": { "name": "get_weather", "args": { "location": "SF" }, "id": "8f2b1a3c" } }
      ]
    },
    {
      "role": "user",
      "parts": [
        {
          "functionResponse": {
            "name": "get_weather",
            "response": { "temperature": 18, "unit": "celsius", "condition": "foggy" },
            "id": "8f2b1a3c"
          }
        }
      ]
    }
  ]
}
```
> - `functionResponse` part inside a `role: "user"` content
> - Must include matching `id` (Gemini 2.0+)
> - `response` is a **parsed object**
> - `name` must match the function that was called

---

## 7. Quick-Reference Comparison Table

| Feature | OpenAI | Anthropic | Google Gemini |
|---|---|---|---|
| **System prompt location** | `messages[{role:"system"}]` | Top-level `system` field | Top-level `system_instruction` |
| **Assistant role name** | `"assistant"` | `"assistant"` | `"model"` |
| **Tool call ID field** | `tool_calls[].id` | `content[].id` (tool_use block) | `parts[].functionCall.id` |
| **Tool call args format** | Stringified JSON string | Parsed object | Parsed object |
| **Tool result role** | `"tool"` (dedicated role) | `"user"` (with tool_result block) | `"user"` (with functionResponse part) |
| **Tool result ID field** | `tool_call_id` | `tool_use_id` | `id` (inside functionResponse) |
| **Schema field name** | `parameters` | `input_schema` | `parameters` |
| **Tool wrapper** | `{ type: "function", function: {...} }` | Flat `{ name, description, input_schema }` | `{ functionDeclarations: [{...}] }` |
| **Stop reason for tools** | `finish_reason: "tool_calls"` | `stop_reason: "tool_use"` | `finishReason: "STOP"` |
| **Parallel tool calls** | Multiple items in `tool_calls[]` | Multiple `tool_use` blocks in `content[]` | Multiple `functionCall` parts |
| **Message alternation** | No strict requirement | **Strict** user/assistant alternation | Recommended alternation |

---

## 8. Full Agentic Loop Example (Pseudocode)

```
1. Build messages array with system + user prompt + tools
2. Call API
3. Check stop reason:
   - If "tool_calls" / "tool_use" / has functionCall:
     a. Extract tool call(s) with ID, name, args
     b. Execute function locally
     c. Append assistant response to messages
     d. Append tool result (with matching ID) to messages
     e. GOTO 2
   - If "end_turn" / "stop" / normal finish:
     a. Return final text to user
```

> [!IMPORTANT]
> **OpenAI** returns tool args as a **stringified JSON string** that you must `JSON.parse()`. Both Anthropic and Google return args as already-parsed objects. This is the single biggest gotcha when building a multi-provider abstraction layer.

> [!TIP]
> **OpenAI's `role: "tool"`** is unique — it's a dedicated role. Both Anthropic and Google send tool results as `role: "user"` messages with special content blocks/parts. When normalizing, you need to handle this asymmetry.

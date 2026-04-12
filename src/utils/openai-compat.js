// ─────────────────────────────────────────────────────────────
// OpenAI-Compatible Provider Utilities
// ─────────────────────────────────────────────────────────────
// Shared helpers for providers that use the OpenAI Chat Completions
// API format: lm-studio, vllm, llama-cpp, and openai itself.

import { getDataUrlMimeType } from "./media.js";
import { ThinkTagParser, extractThinkTags } from "./ThinkTagParser.js";

// ── Tool Conversion ─────────────────────────────────────────

/**
 * Convert generic tool schemas to OpenAI Chat Completions format.
 * Input:  [{ name, description, parameters }]
 * Output: [{ type: "function", function: { name, description, parameters } }]
 */
export function convertToolsToOpenAI(tools) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return null;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.parameters || {},
    },
  }));
}

// ── Payload Parameter Building ──────────────────────────────

/**
 * Build the common sampling/generation parameters for an
 * OpenAI-compatible Chat Completions payload.
 *
 * Returns a plain object with only the non-undefined fields set.
 *
 * @param {object} options - The provider options
 * @param {object} [defaults] - Default values
 * @param {number} [defaults.temperature=0.7] - Default temperature
 * @param {number} [defaults.maxTokens=-1] - Default max_tokens
 * @returns {object} Payload fields to spread into the request body
 */
export function buildPayloadParams(options, { temperature = 0.7, maxTokens = -1 } = {}) {
  return {
    temperature: options.temperature !== undefined ? options.temperature : temperature,
    top_p: options.topP !== undefined ? options.topP : undefined,
    frequency_penalty: options.frequencyPenalty !== undefined ? options.frequencyPenalty : undefined,
    presence_penalty: options.presencePenalty !== undefined ? options.presencePenalty : undefined,
    stop: options.stopSequences !== undefined ? options.stopSequences : undefined,
    max_tokens: options.maxTokens || maxTokens,
    // Reproducibility seed — supported by OpenAI-compat servers (vLLM, LM Studio, llama.cpp)
    ...(options.seed !== undefined && options.seed !== "" && { seed: Number(options.seed) }),
  };
}

// ── Tool Call Extraction ────────────────────────────────────

/**
 * Extract tool calls from a non-streaming OpenAI-compatible message object.
 * Handles both nested OpenAI format ({ function: { name, arguments } })
 * and flat llama.cpp format ({ name, arguments }).
 *
 * @param {object} msg - The message object from choices[0].message
 * @returns {Array|null} Array of { id, name, args } or null if no tool calls
 */
export function extractToolCallsFromMessage(msg) {
  if (!msg?.tool_calls || msg.tool_calls.length === 0) return null;

  return msg.tool_calls.map((tc) => {
    const fnName = tc.function?.name || tc.name || "";
    const fnArgs = tc.function?.arguments || tc.arguments || "{}";
    let args = {};
    try {
      args = JSON.parse(fnArgs);
    } catch {
      /* ignore */
    }
    return {
      id: tc.id,
      name: fnName,
      args,
    };
  });
}

// ── Usage Normalization ─────────────────────────────────────

/**
 * Build a normalized usage object from OpenAI-compatible usage data.
 * @param {object} [rawUsage] - The usage object from the API response
 * @returns {{ inputTokens: number, outputTokens: number }}
 */
export function normalizeUsage(rawUsage) {
  return {
    inputTokens: rawUsage?.prompt_tokens ?? 0,
    outputTokens: rawUsage?.completion_tokens ?? 0,
  };
}

/**
 * The default empty usage object, used when no usage data is available.
 */
export const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0 };

// ── Message Preparation ─────────────────────────────────────

/**
 * Media handling strategies for prepareOpenAICompatMessages.
 * Controls how non-image media types are handled by different providers.
 */
export const MEDIA_STRATEGIES = {
  /** vLLM: supports video_url and input_audio natively */
  FULL_MULTIMODAL: "full_multimodal",
  /** llama-cpp: falls back to text descriptions for audio/video */
  TEXT_FALLBACK: "text_fallback",
  /** lm-studio: images only, ignore other media types */
  IMAGES_ONLY: "images_only",
};

/**
 * Pre-process messages to expand video attachments into image frames.
 *
 * For providers that don't support raw video data URLs (e.g. LM Studio),
 * this extracts frames from each video using ffmpeg and adds them to the
 * message's `images` array. The original `video` array is removed so
 * downstream processing never sees it.
 *
 * Call this BEFORE prepareOpenAICompatMessages() for providers that need
 * video-as-frames support.
 *
 * @param {Array} messages - The message array (mutated in-place)
 * @param {object} [options]
 * @param {number} [options.fps=1] - Frames per second to extract
 * @param {number} [options.maxFrames=30] - Maximum frames per video
 * @returns {Promise<Array>} The same messages array with videos expanded
 */
export async function expandVideoToFrames(messages, options = {}) {
  const { extractVideoFrames, getDataUrlMimeType } = await import("./media.js");

  for (const msg of messages) {
    // Collect video data URLs from both `video` and `images` arrays.
    // The frontend may place video files in `images` if it doesn't
    // categorize by MIME type (backwards compatibility).
    const videoUrls = [];
    const keptImages = [];

    // Check explicit video field
    if (msg.video && Array.isArray(msg.video)) {
      videoUrls.push(...msg.video);
      delete msg.video;
    }

    // Check images field for misclassified video data URLs
    if (msg.images && Array.isArray(msg.images)) {
      for (const dataUrl of msg.images) {
        const mime = getDataUrlMimeType(dataUrl);
        if (mime && mime.startsWith("video/")) {
          videoUrls.push(dataUrl);
        } else {
          keptImages.push(dataUrl);
        }
      }
      msg.images = keptImages;
    }

    if (videoUrls.length === 0) continue;

    const allFrames = [];
    for (const videoDataUrl of videoUrls) {
      const frames = await extractVideoFrames(videoDataUrl, options);
      allFrames.push(...frames);
    }

    if (allFrames.length > 0) {
      // Prepend frames to images array (model card recommends media before text)
      msg.images = [...allFrames, ...(msg.images || [])];
    }
  }

  return messages;
}


/**
 * Convert messages with media to OpenAI-compatible multipart content format.
 * Handles images, tool results, assistant tool calls, and optionally
 * audio/video/PDF based on the media strategy.
 *
 * @param {Array} messages - The message array
 * @param {object} [options]
 * @param {string} [options.mediaStrategy="images_only"] - How to handle non-image media
 * @returns {Array} OpenAI-compatible messages
 */
export function prepareOpenAICompatMessages(messages, { mediaStrategy = MEDIA_STRATEGIES.IMAGES_ONLY } = {}) {
  return messages.map((m) => {
    const base = { role: m.role };
    if (m.name) base.name = m.name;

    // Tool result messages — include tool_call_id for correlation
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.tool_call_id || m.id || "",
        content:
          typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      };
    }

    // Assistant messages with tool calls — include tool_calls in OpenAI format
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        ...base,
        // Per OpenAI spec, content must be null when tool_calls are present
        content: m.content?.trim() || null,
        tool_calls: m.toolCalls.map((tc, i) => ({
          id: tc.id || `call_${i}`,
          type: "function",
          function: {
            name: tc.name,
            arguments:
              typeof tc.args === "string"
                ? tc.args
                : JSON.stringify(tc.args || {}),
          },
        })),
      };
    }

    // Collect media content based on strategy
    const content = [];

    if (mediaStrategy === MEDIA_STRATEGIES.IMAGES_ONLY) {
      // Simple image-only handling (lm-studio)
      if (m.images && m.images.length > 0) {
        for (const dataUrl of m.images) {
          content.push({ type: "image_url", image_url: { url: dataUrl } });
        }
      }
    } else {
      // Full media handling (vllm, llama-cpp)
      for (const field of ["images", "audio", "video", "pdf"]) {
        const arr = m[field];
        if (!arr || !Array.isArray(arr) || arr.length === 0) continue;

        for (const dataUrl of arr) {
          const mime = getDataUrlMimeType(dataUrl);

          if (mime && mime.startsWith("image/")) {
            content.push({ type: "image_url", image_url: { url: dataUrl } });
          } else if (mime && mime.startsWith("video/")) {
            if (mediaStrategy === MEDIA_STRATEGIES.FULL_MULTIMODAL) {
              content.push({ type: "video_url", video_url: { url: dataUrl } });
            } else {
              content.push({
                type: "text",
                text: "[Attached video file — video input not supported by this model]",
              });
            }
          } else if (mime && mime.startsWith("audio/")) {
            if (mediaStrategy === MEDIA_STRATEGIES.FULL_MULTIMODAL) {
              const base64Data = dataUrl.split(";base64,")[1] || "";
              const audioFormat = mime.split("/")[1] || "wav";
              content.push({
                type: "input_audio",
                input_audio: { data: base64Data, format: audioFormat },
              });
            } else {
              content.push({
                type: "text",
                text: "[Attached audio file — audio input not supported by this model]",
              });
            }
          } else if (mime === "application/pdf") {
            content.push({
              type: "text",
              text: "[Attached PDF document — PDF input not supported by this model]",
            });
          } else if (
            mime &&
            (mime.startsWith("text/") || mime === "application/json")
          ) {
            try {
              const base64 = dataUrl.split(";base64,")[1];
              const decoded = Buffer.from(base64, "base64").toString("utf-8");
              content.push({
                type: "text",
                text: `[Attached file (${mime})]:\n${decoded}`,
              });
            } catch {
              content.push({
                type: "text",
                text: `[Attached file (${mime}): unable to decode]`,
              });
            }
          } else {
            // Fallback — try image_url passthrough for unknown types
            content.push({ type: "image_url", image_url: { url: dataUrl } });
          }
        }
      }
    }

    if (content.length > 0) {
      if (m.content) {
        content.push({ type: "text", text: m.content });
      }
      return { ...base, content };
    }

    return { ...base, content: m.content ?? "" };
  });
}

// ── Non-Streaming Response Processing ───────────────────────

/**
 * Process a non-streaming OpenAI-compatible chat completion response.
 * Extracts text, thinking (native + <think> tags), usage, and tool calls.
 *
 * When thinkingEnabled is false, thinking content is folded into the text
 * output and the `thinking` field is null.
 *
 * @param {object} data - The parsed JSON response body
 * @param {object} [options]
 * @param {boolean} [options.thinkingEnabled] - When false, suppress thinking separation
 * @returns {{ text: string, thinking: string|null, usage: object, toolCalls: Array|null }}
 */
export function processNonStreamingResponse(data, options = {}) {
  const msg = data.choices?.[0]?.message;
  const rawText = msg?.content || "";

  // When thinking is disabled, return raw text without parsing <think> tags
  if (options.thinkingEnabled === false) {
    const usage = normalizeUsage(data.usage);
    const toolCalls = extractToolCallsFromMessage(msg);
    return { text: rawText, thinking: null, usage, toolCalls };
  }

  // Check native reasoning fields first, fall back to <think> tag parsing
  const nativeThinking = msg?.reasoning_content || msg?.reasoning || null;
  const { thinking: tagThinking, text } = extractThinkTags(rawText);
  const thinking = nativeThinking || tagThinking;

  const usage = normalizeUsage(data.usage);
  const toolCalls = extractToolCallsFromMessage(msg);

  return { text, thinking, usage, toolCalls };
}

// ── SSE Stream Parsing ──────────────────────────────────────

/**
 * Parse an SSE stream from an OpenAI-compatible /v1/chat/completions endpoint.
 * Yields the same event types as the provider generateTextStream methods:
 *   - string (text content)
 *   - { type: "thinking", content } (reasoning content)
 *   - { type: "toolCall", id, name, args }
 *   - { type: "usage", usage }
 *
 * When thinkingEnabled is false, all thinking content (native reasoning_content
 * and <think> tag content) is yielded as plain text strings instead of
 * { type: "thinking" } events.
 *
 * @param {ReadableStreamDefaultReader} reader - The response body reader
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - Abort signal
 * @param {boolean} [options.thinkingEnabled] - When false, emit thinking as text
 * @param {function} [options.onUsage] - Called with raw usage JSON for provider-specific extensions (e.g. llama.cpp timings)
 * @param {function} [options.onChunkJson] - Called with each parsed SSE JSON object for provider-specific processing
 */
export async function* parseSSEStream(reader, options = {}) {
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = null;
  const suppressThinking = options.thinkingEnabled === false;
  // Skip ThinkTagParser entirely when thinking is disabled — no overhead
  const thinkParser = suppressThinking ? null : new ThinkTagParser();
  const pendingToolCalls = {};

  try {
    while (true) {
      if (options.signal?.aborted) {
        reader.cancel();
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue; // skip empty lines / comments
        if (trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;

        try {
          const json = JSON.parse(trimmed.slice(6));

          // Extract usage if present (some servers send it on the last chunk)
          if (json.usage) {
            usage = normalizeUsage(json.usage);
            // Let provider handle extensions (e.g. llama.cpp timings)
            if (options.onUsage) options.onUsage(json, usage);
          }

          // Let provider handle custom fields
          if (options.onChunkJson) options.onChunkJson(json);

          const delta = json.choices?.[0]?.delta;

          // Native reasoning fields (Qwen3.5, DeepSeek, etc.)
          const reasoning = delta?.reasoning_content || delta?.reasoning || "";
          if (reasoning) {
            if (suppressThinking) {
              yield reasoning; // Emit as plain text
            } else {
              yield { type: "thinking", content: reasoning };
            }
          }

          const content = delta?.content || "";
          if (content) {
            if (suppressThinking) {
              // Pass through raw content without <think> tag parsing
              yield content;
            } else {
              // Parse <think> tags from the streamed content
              const parts = thinkParser.feed(content);
              for (const part of parts) {
                if (part.type === "thinking") {
                  yield { type: "thinking", content: part.content };
                } else {
                  yield part.content;
                }
              }
            }
          }

          // Accumulate tool call deltas
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!pendingToolCalls[idx]) {
                pendingToolCalls[idx] = {
                  id: tc.id || "",
                  name: tc.function?.name || tc.name || "",
                  args: "",
                };
              }
              if (tc.id) pendingToolCalls[idx].id = tc.id;
              const chunkName = tc.function?.name || tc.name;
              if (chunkName) pendingToolCalls[idx].name = chunkName;
              const chunkArgs = tc.function?.arguments || tc.arguments;
              if (chunkArgs) pendingToolCalls[idx].args += chunkArgs;
            }
          }

          // If finish_reason indicates tool calls, yield accumulated tool calls
          const finishReason = json.choices?.[0]?.finish_reason;
          if (finishReason === "tool_calls" || finishReason === "tool") {
            for (const tc of Object.values(pendingToolCalls)) {
              let args = {};
              try {
                args = JSON.parse(tc.args || "{}");
              } catch {
                /* ignore */
              }
              yield {
                type: "toolCall",
                id: tc.id,
                name: tc.name,
                args,
              };
            }
          }
        } catch {
          // skip malformed JSON lines
        }
      }
    }

    // Flush any remaining buffered content from the think parser
    if (thinkParser) {
      const remaining = thinkParser.flush();
      for (const part of remaining) {
        if (part.type === "thinking") {
          yield { type: "thinking", content: part.content };
        } else {
          yield part.content;
        }
      }
    }

    // Yield final usage
    if (usage) {
      yield { type: "usage", usage };
    } else {
      yield { type: "usage", usage: EMPTY_USAGE };
    }
  } finally {
    // Ensure reader is released
  }
}

// ── Fetch + Error Handling ──────────────────────────────────

/**
 * Make a fetch request to an OpenAI-compatible endpoint and handle
 * error responses consistently.
 *
 * @param {string} url - The endpoint URL
 * @param {object} payload - The request body
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - Abort signal
 * @returns {Promise<Response>} The fetch response (guaranteed to be ok)
 * @throws {Error} With a parsed error message from the API
 */
export async function fetchOpenAICompat(url, payload, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    ...(options.signal && { signal: options.signal }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMsg = `API error: ${response.status} ${errorText}`;
    try {
      const parsed = JSON.parse(errorText);
      if (parsed?.error?.message) errorMsg = parsed.error.message;
      else if (parsed?.message) errorMsg = parsed.message;
    } catch { /* raw text fallback */ }
    throw new Error(errorMsg);
  }

  return response;
}

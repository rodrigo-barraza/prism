import { ProviderError } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { VLLM_BASE_URL } from "../../secrets.js";
import { TYPES, getDefaultModels } from "../config.js";

// ── Helpers ──────────────────────────────────────────────────

function getBaseUrl() {
  return VLLM_BASE_URL;
}

/**
 * Convert generic tool schemas to OpenAI Chat Completions format.
 * Input:  [{ name, description, parameters }]
 * Output: [{ type: "function", function: { name, description, parameters } }]
 */
function convertToolsToOpenAI(tools) {
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

/**
 * Extract <think>…</think> blocks from a complete response string.
 * Returns { thinking, text } where thinking is the concatenated think content
 * and text is the remaining content with think tags removed.
 */
function extractThinkTags(raw) {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  const thinkParts = [];
  let match;
  while ((match = thinkRegex.exec(raw)) !== null) {
    thinkParts.push(match[1].trim());
  }
  const text = raw.replace(thinkRegex, "").trim();
  return {
    thinking: thinkParts.length > 0 ? thinkParts.join("\n\n") : null,
    text,
  };
}

/**
 * Stateful parser for streaming <think> tag detection.
 * Handles tags that arrive split across chunk boundaries.
 *
 * feed(chunk) returns an array of items:
 *   - { type: "thinking", content: string }
 *   - { type: "text", content: string }
 */
class ThinkTagParser {
  constructor() {
    this.insideThink = false;
    this.buffer = "";
  }

  feed(chunk) {
    this.buffer += chunk;
    const results = [];

    while (this.buffer.length > 0) {
      if (this.insideThink) {
        const closeIdx = this.buffer.indexOf("</think>");
        if (closeIdx !== -1) {
          const thinkContent = this.buffer.slice(0, closeIdx);
          if (thinkContent) {
            results.push({ type: "thinking", content: thinkContent });
          }
          this.buffer = this.buffer.slice(closeIdx + "</think>".length);
          this.insideThink = false;
        } else {
          const partialMatch = this._partialEndTag(this.buffer);
          if (partialMatch > 0) {
            const safe = this.buffer.slice(
              0,
              this.buffer.length - partialMatch,
            );
            if (safe) {
              results.push({ type: "thinking", content: safe });
            }
            this.buffer = this.buffer.slice(this.buffer.length - partialMatch);
          } else {
            results.push({ type: "thinking", content: this.buffer });
            this.buffer = "";
          }
          break;
        }
      } else {
        const openIdx = this.buffer.indexOf("<think>");
        if (openIdx !== -1) {
          const textBefore = this.buffer.slice(0, openIdx);
          if (textBefore) {
            results.push({ type: "text", content: textBefore });
          }
          this.buffer = this.buffer.slice(openIdx + "<think>".length);
          this.insideThink = true;
        } else {
          const partialMatch = this._partialStartTag(this.buffer);
          if (partialMatch > 0) {
            const safe = this.buffer.slice(
              0,
              this.buffer.length - partialMatch,
            );
            if (safe) {
              results.push({ type: "text", content: safe });
            }
            this.buffer = this.buffer.slice(this.buffer.length - partialMatch);
          } else {
            results.push({ type: "text", content: this.buffer });
            this.buffer = "";
          }
          break;
        }
      }
    }
    return results;
  }

  /** Check if the end of str is a partial match for "<think>" */
  _partialStartTag(str) {
    const tag = "<think>";
    for (let len = Math.min(tag.length - 1, str.length); len >= 1; len--) {
      if (str.endsWith(tag.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }

  /** Check if the end of str is a partial match for "</think>" */
  _partialEndTag(str) {
    const tag = "</think>";
    for (let len = Math.min(tag.length - 1, str.length); len >= 1; len--) {
      if (str.endsWith(tag.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }

  /** Flush any remaining buffered content. */
  flush() {
    if (!this.buffer) return [];
    const type = this.insideThink ? "thinking" : "text";
    const result = [{ type, content: this.buffer }];
    this.buffer = "";
    return result;
  }
}

/**
 * Convert messages with images to OpenAI-compatible multipart content format.
 * Also handles tool result messages and assistant messages with toolCalls.
 */
function prepareMessages(messages) {
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
      const msg = {
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
      return msg;
    }

    if (m.images && m.images.length > 0) {
      const content = [];
      for (const dataUrl of m.images) {
        content.push({ type: "image_url", image_url: { url: dataUrl } });
      }
      if (m.content) {
        content.push({ type: "text", text: m.content });
      }
      return { ...base, content };
    }
    return { ...base, content: m.content };
  });
}

// ── Provider ─────────────────────────────────────────────────

const vllmProvider = {
  name: "vllm",

  async generateText(
    messages,
    model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["vllm"],
    options = {},
  ) {
    const baseUrl = getBaseUrl();
    logger.provider("vLLM", `generateText model=${model} baseUrl=${baseUrl}`);
    try {
      const prepared = prepareMessages(messages);

      const payload = {
        messages: prepared,
        model,
        temperature:
          options.temperature !== undefined ? options.temperature : 0.7,
        top_p: options.topP !== undefined ? options.topP : undefined,
        frequency_penalty:
          options.frequencyPenalty !== undefined
            ? options.frequencyPenalty
            : undefined,
        presence_penalty:
          options.presencePenalty !== undefined
            ? options.presencePenalty
            : undefined,
        stop:
          options.stopSequences !== undefined
            ? options.stopSequences
            : undefined,
        max_tokens: options.maxTokens || -1,
        stream: false,
      };

      // Function calling tools
      const tools = convertToolsToOpenAI(options.tools);
      if (tools) payload.tools = tools;

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      const message = data.choices?.[0]?.message;
      const rawText = message?.content || "";

      // Check native reasoning fields first, fall back to <think> tag parsing
      const nativeThinking =
        message?.reasoning_content || message?.reasoning || null;
      const { thinking: tagThinking, text } = extractThinkTags(rawText);
      const thinking = nativeThinking || tagThinking;

      const result = {
        text,
        thinking,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        },
      };

      // Extract tool calls if present
      if (message?.tool_calls && message.tool_calls.length > 0) {
        result.toolCalls = message.tool_calls.map((tc) => {
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            /* ignore */
          }
          return {
            id: tc.id,
            name: tc.function.name,
            args,
          };
        });
      }

      return result;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("vllm", error.message, 500, error);
    }
  },

  // ── Streaming Text Generation (SSE) ──────────────────────

  async *generateTextStream(
    messages,
    model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["vllm"],
    options = {},
  ) {
    const baseUrl = getBaseUrl();
    logger.provider(
      "vLLM",
      `generateTextStream model=${model} baseUrl=${baseUrl}`,
    );
    try {
      const prepared = prepareMessages(messages);

      const payload = {
        messages: prepared,
        model,
        temperature:
          options.temperature !== undefined ? options.temperature : 0.7,
        top_p: options.topP !== undefined ? options.topP : undefined,
        frequency_penalty:
          options.frequencyPenalty !== undefined
            ? options.frequencyPenalty
            : undefined,
        presence_penalty:
          options.presencePenalty !== undefined
            ? options.presencePenalty
            : undefined,
        stop:
          options.stopSequences !== undefined
            ? options.stopSequences
            : undefined,
        max_tokens: options.maxTokens || -1,
        stream: true,
        stream_options: { include_usage: true },
      };

      // Function calling tools
      const tools = convertToolsToOpenAI(options.tools);
      if (tools) payload.tools = tools;

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        ...(options.signal && { signal: options.signal }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} ${errorText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let usage = null;
      const thinkParser = new ThinkTagParser();
      // Accumulate tool calls across chunks
      const pendingToolCalls = {};

      while (true) {
        if (options.signal?.aborted) {
          reader.cancel();
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;
          if (trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;

          try {
            const json = JSON.parse(trimmed.slice(6));

            if (json.usage) {
              usage = {
                inputTokens: json.usage.prompt_tokens ?? 0,
                outputTokens: json.usage.completion_tokens ?? 0,
              };
            }

            const delta = json.choices?.[0]?.delta;

            // Native reasoning fields (Qwen3, DeepSeek, etc.)
            const reasoning =
              delta?.reasoning_content || delta?.reasoning || "";
            if (reasoning) {
              yield { type: "thinking", content: reasoning };
            }

            const content = delta?.content || "";
            if (content) {
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

            // Accumulate tool call deltas
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!pendingToolCalls[idx]) {
                  pendingToolCalls[idx] = {
                    id: tc.id || "",
                    name: tc.function?.name || "",
                    args: "",
                  };
                }
                if (tc.id) pendingToolCalls[idx].id = tc.id;
                if (tc.function?.name)
                  pendingToolCalls[idx].name = tc.function.name;
                if (tc.function?.arguments)
                  pendingToolCalls[idx].args += tc.function.arguments;
              }
            }

            // If finish_reason is "tool_calls", yield accumulated tool calls
            if (json.choices?.[0]?.finish_reason === "tool_calls") {
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
      const remaining = thinkParser.flush();
      for (const part of remaining) {
        if (part.type === "thinking") {
          yield { type: "thinking", content: part.content };
        } else {
          yield part.content;
        }
      }

      if (usage) {
        yield { type: "usage", usage };
      } else {
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
      }
    } catch (error) {
      if (error.name === "AbortError") return; // Client disconnected
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("vllm", error.message, 500, error);
    }
  },

  async captionImage(
    images,
    prompt = "Describe this image.",
    model = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["vllm"],
    systemPrompt,
  ) {
    const baseUrl = getBaseUrl();
    logger.provider("vLLM", `captionImage model=${model} baseUrl=${baseUrl}`);
    try {
      const content = [
        { type: "text", text: prompt },
        ...images.map((img) => ({
          type: "image_url",
          image_url: { url: img },
        })),
      ];
      const messages = [];
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
      }
      messages.push({ role: "user", content });

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          model,
          temperature: 0.7,
          max_tokens: -1,
          stream: false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content || "";
      const usage = {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      };
      return { text, usage };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("vllm", error.message, 500, error);
    }
  },

  // ── Model Listing ────────────────────────────────────────

  /**
   * List all models available from the vLLM server.
   * Uses the OpenAI-standard GET /v1/models endpoint.
   * Returns { models: [...] } normalized format.
   */
  async listModels() {
    const baseUrl = getBaseUrl();
    logger.provider("vLLM", "listModels");
    try {
      const response = await fetch(`${baseUrl}/v1/models`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} ${errorText}`);
      }
      const data = await response.json();
      const models = (data.data || []).map((m) => ({
        key: m.id,
        display_name: m.id,
        type: "llm",
        loaded_instances: [{ id: m.id }], // vLLM models are always loaded
      }));
      return { models };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("vllm", error.message, 500, error);
    }
  },
};

export default vllmProvider;

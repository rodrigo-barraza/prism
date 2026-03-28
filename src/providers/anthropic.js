import Anthropic from "@anthropic-ai/sdk";
import { ProviderError } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { ANTHROPIC_API_KEY } from "../../secrets.js";
import { TYPES, getDefaultModels } from "../config.js";

// Default budget tokens mapped from effort level (for non-adaptive models)
const EFFORT_BUDGET_MAP = {
  low: 1024,
  medium: 4096,
  high: 10000,
};

let client = null;

function getClient() {
  if (!client) {
    if (!ANTHROPIC_API_KEY) {
      throw new ProviderError("anthropic", "ANTHROPIC_API_KEY is not set", 401);
    }
    client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return client;
}

/**
 * Anthropic requires alternating user/assistant roles and handles system messages separately.
 * This helper extracts the system message and merges consecutive same-role messages.
 */
function prepareMessages(messages) {
  let systemMessage;

  // Extract system message
  const conversation = messages.map((m) => ({ ...m }));
  if (conversation.length > 0 && conversation[0].role === "system") {
    systemMessage = conversation.shift().content;
  }

  // Remove unsupported properties and convert media content
  const cleaned = conversation
    .filter(
      (m) => m.role === "user" || m.role === "assistant" || m.role === "tool",
    )
    .map((m) => {
      const { name: _name, id: _id, tool_call_id: _tcId, images, ...rest } = m;

      // Convert tool role messages to tool_result user messages for Anthropic
      if (m.role === "tool") {
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m.tool_call_id || m.id || m.name || "unknown",
              content:
                typeof m.content === "string"
                  ? m.content
                  : JSON.stringify(m.content),
            },
          ],
        };
      }

      // Convert assistant messages with toolCalls to multi-part content
      if (m.role === "assistant" && m.toolCalls?.length > 0) {
        const contentBlocks = [];
        if (rest.content?.trim()) {
          contentBlocks.push({ type: "text", text: rest.content });
        }
        for (const tc of m.toolCalls) {
          contentBlocks.push({
            type: "tool_use",
            id: tc.id || tc.name || `tc-${Date.now()}`,
            name: tc.name,
            input: tc.args || {},
          });
        }
        return {
          role: "assistant",
          content: contentBlocks,
        };
      }

      // Convert messages with media to Anthropic content block format
      if (images && images.length > 0) {
        const contentBlocks = [];
        for (const dataUrl of images) {
          const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (!match) continue;
          const mimeType = match[1];
          const data = match[2];

          if (mimeType.startsWith("image/")) {
            // Image content block
            let mediaType = mimeType;
            if (data.startsWith("/9j/")) mediaType = "image/jpeg";
            else if (data.startsWith("iVBOR")) mediaType = "image/png";
            else if (data.startsWith("R0lG")) mediaType = "image/gif";
            else if (data.startsWith("UklG")) mediaType = "image/webp";

            contentBlocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data,
              },
            });
          } else if (mimeType === "application/pdf") {
            // PDF document content block
            contentBlocks.push({
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data,
              },
            });
          } else if (
            mimeType.startsWith("text/") ||
            mimeType === "application/json"
          ) {
            // Text-based files — decode and inline as text
            try {
              const decoded = Buffer.from(data, "base64").toString("utf-8");
              contentBlocks.push({
                type: "text",
                text: `[Attached file (${mimeType})]:\n${decoded}`,
              });
            } catch {
              // Skip if decoding fails
            }
          }
          // Other MIME types (audio, video) are not supported by Anthropic — skip
        }
        if (rest.content) {
          contentBlocks.push({ type: "text", text: rest.content });
        }
        return {
          role: rest.role,
          content: contentBlocks.length > 0 ? contentBlocks : rest.content,
        };
      }

      // Ensure assistant messages never have empty content
      if (
        rest.role === "assistant" &&
        (!rest.content || !rest.content.trim())
      ) {
        return { ...rest, content: " " };
      }
      return rest;
    });

  // Merge consecutive same-role messages
  const merged = cleaned.reduce((acc, cur) => {
    if (acc.length && acc[acc.length - 1].role === cur.role) {
      const prev = acc[acc.length - 1];
      // Handle merging when content might be string or array
      if (typeof prev.content === "string" && typeof cur.content === "string") {
        prev.content += `\n\n${cur.content}`;
      } else {
        // Convert both to arrays and concat
        const prevBlocks =
          typeof prev.content === "string"
            ? [{ type: "text", text: prev.content }]
            : prev.content;
        const curBlocks =
          typeof cur.content === "string"
            ? [{ type: "text", text: cur.content }]
            : cur.content;
        prev.content = [...prevBlocks, ...curBlocks];
      }
    } else {
      acc.push({ ...cur });
    }
    return acc;
  }, []);

  // Deduplicate tool_result blocks within merged user messages.
  // Anthropic requires exactly one tool_result per tool_use_id.
  // The frontend may send both inline results (from assistant.toolCalls
  // expansion) and standalone tool-role messages with the same ID,
  // which after merging creates duplicate tool_result blocks.
  for (const msg of merged) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    const seenToolResultIds = new Set();
    msg.content = msg.content.filter((block) => {
      if (block.type !== "tool_result") return true;
      if (seenToolResultIds.has(block.tool_use_id)) return false;
      seenToolResultIds.add(block.tool_use_id);
      return true;
    });
  }

  // Ensure conversation starts with a user message
  if (merged.length > 0 && merged[0].role === "assistant") {
    merged.shift();
  }

  // Strip orphaned tool_use blocks: if an assistant message has tool_use
  // content blocks but the next message is NOT a tool_result, remove them.
  // This handles stale conversation history loaded from the database.
  for (let i = 0; i < merged.length; i++) {
    const msg = merged[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    const hasToolUse = msg.content.some((b) => b.type === "tool_use");
    if (!hasToolUse) continue;

    const next = merged[i + 1];
    const nextHasToolResult =
      next?.role === "user" &&
      Array.isArray(next.content) &&
      next.content.some((b) => b.type === "tool_result");

    if (!nextHasToolResult) {
      // Strip tool_use blocks, keep only text
      msg.content = msg.content.filter((b) => b.type !== "tool_use");
      if (msg.content.length === 0) {
        msg.content = " ";
      }
    }
  }

  return { systemMessage, messages: merged };
}

/**
 * Build the tools array based on options.
 */
function buildTools(options) {
  const tools = [];
  if (options.webSearch) {
    tools.push({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
    });
  }
  if (options.webFetch) {
    tools.push({
      type: "web_fetch_20250910",
      name: "web_fetch",
      max_uses: 10,
    });
  }
  if (options.codeExecution) {
    tools.push({
      type: "code_execution_20250825",
      name: "code_execution",
    });
  }
  // Custom function calling tools
  if (options.tools && Array.isArray(options.tools)) {
    for (const t of options.tools) {
      tools.push({
        name: t.name,
        description: t.description || "",
        input_schema: t.parameters || { type: "object", properties: {} },
      });
    }
  }
  return tools.length > 0 ? tools : undefined;
}

/**
 * Extract text, thinking, citations, and code results from a multi-block response.
 */
function extractResponseContent(contentBlocks) {
  let text = "";
  let thinking = null;
  const citations = [];
  const toolCalls = [];

  for (const block of contentBlocks || []) {
    if (block.type === "text") {
      text += block.text || "";
      // Collect inline citations from this text block
      if (block.citations) {
        for (const cite of block.citations) {
          if (cite.type === "web_search_result_location") {
            citations.push({
              url: cite.url,
              title: cite.title,
              citedText: cite.cited_text,
            });
          }
        }
      }
    } else if (block.type === "thinking") {
      thinking = block.thinking;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        args: block.input || {},
      });
    }
    // server_tool_use and *_tool_result blocks are informational — skip
  }

  return { text, thinking, citations, toolCalls };
}

/**
 * Build the common usage object from an Anthropic response.
 */
function buildUsage(responseUsage) {
  return {
    inputTokens: responseUsage?.input_tokens ?? 0,
    outputTokens: responseUsage?.output_tokens ?? 0,
    cacheReadInputTokens: responseUsage?.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: responseUsage?.cache_creation_input_tokens ?? 0,
  };
}

const anthropicProvider = {
  name: "anthropic",

  async generateText(
    messages,
    model = getDefaultModels(TYPES.TEXT, TYPES.TEXT).anthropic,
    options = {},
  ) {
    logger.provider("Anthropic", `generateText model=${model}`);
    try {
      const prepared = prepareMessages(messages);
      const payload = {
        cache_control: { type: "ephemeral" },
        system: prepared.systemMessage,
        model,
        messages: prepared.messages,
        max_tokens: options.maxTokens || 1000,
        temperature:
          options.temperature !== undefined ? options.temperature : undefined,
        top_p:
          options.temperature === undefined && options.topP !== undefined
            ? options.topP
            : undefined,
        top_k: options.topK !== undefined ? options.topK : undefined,
        stop_sequences:
          options.stopSequences !== undefined
            ? options.stopSequences
            : undefined,
      };

      // Server tools
      const tools = buildTools(options);
      if (tools) payload.tools = tools;

      if (options.thinkingBudget || options.reasoningEffort) {
        const budget = options.thinkingBudget
          ? parseInt(options.thinkingBudget)
          : EFFORT_BUDGET_MAP[options.reasoningEffort] ||
            EFFORT_BUDGET_MAP.high;
        payload.thinking = { type: "enabled", budget_tokens: budget };
        if (payload.max_tokens <= budget) {
          payload.max_tokens = budget + 1024;
        }
        // Anthropic requires temperature=1 and top_p/top_k unset when thinking is enabled
        payload.temperature = 1;
        delete payload.top_p;
        delete payload.top_k;
      }

      const response = await getClient().messages.create(payload);

      const { text, thinking, citations, toolCalls } = extractResponseContent(
        response.content,
      );
      const result = {
        text,
        usage: buildUsage(response.usage),
      };
      if (thinking) result.thinking = thinking;
      if (citations.length > 0) result.citations = citations;
      if (toolCalls.length > 0) result.toolCalls = toolCalls;
      return result;
    } catch (error) {
      throw new ProviderError(
        "anthropic",
        error.message,
        error.status || 500,
        error,
      );
    }
  },

  /**
   * Caption / describe images (image-to-text).
   * @param {string[]} images - Array of image URLs or base64 data URLs
   * @param {string} prompt - Caption prompt
   * @param {string} model - Model name
   * @returns {Promise<{ text: string, usage: object }>}
   */
  async captionImage(
    images,
    prompt = "Describe this image.",
    model = getDefaultModels(TYPES.TEXT, TYPES.TEXT).anthropic,
    systemPrompt,
  ) {
    logger.provider("Anthropic", `captionImage model=${model}`);
    try {
      const contentBlocks = [];

      for (const imageUrlOrBase64 of images) {
        const match = imageUrlOrBase64.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          let mediaType = match[1];
          const data = match[2];
          // Auto-detect media type from data prefix
          if (data.startsWith("/9j/")) mediaType = "image/jpeg";
          else if (data.startsWith("iVBOR")) mediaType = "image/png";
          else if (data.startsWith("R0lG")) mediaType = "image/gif";
          else if (data.startsWith("UklG")) mediaType = "image/webp";

          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data,
            },
          });
        } else if (imageUrlOrBase64.startsWith("http")) {
          // URL-based image
          contentBlocks.push({
            type: "image",
            source: {
              type: "url",
              url: imageUrlOrBase64,
            },
          });
        }
      }

      contentBlocks.push({ type: "text", text: prompt });

      const payload = {
        model,
        messages: [{ role: "user", content: contentBlocks }],
        max_tokens: 1000,
      };
      if (systemPrompt) {
        payload.system = systemPrompt;
      }

      const response = await getClient().messages.create(payload);

      const { text } = extractResponseContent(response.content);
      return {
        text,
        usage: buildUsage(response.usage),
      };
    } catch (error) {
      throw new ProviderError(
        "anthropic",
        error.message,
        error.status || 500,
        error,
      );
    }
  },

  async *generateTextStream(
    messages,
    model = getDefaultModels(TYPES.TEXT, TYPES.TEXT).anthropic,
    options = {},
  ) {
    logger.provider("Anthropic", `generateTextStream model=${model}`);
    try {
      const prepared = prepareMessages(messages);
      const streamPayload = {
        cache_control: { type: "ephemeral" },
        system: prepared.systemMessage,
        model,
        messages: prepared.messages,
        max_tokens: options.maxTokens || 1000,
        temperature:
          options.temperature !== undefined ? options.temperature : undefined,
        top_p:
          options.temperature === undefined && options.topP !== undefined
            ? options.topP
            : undefined,
        top_k: options.topK !== undefined ? options.topK : undefined,
        stop_sequences:
          options.stopSequences !== undefined
            ? options.stopSequences
            : undefined,
      };

      // Server tools
      const tools = buildTools(options);
      if (tools) streamPayload.tools = tools;

      if (options.thinkingBudget || options.reasoningEffort) {
        const budget = options.thinkingBudget
          ? parseInt(options.thinkingBudget)
          : EFFORT_BUDGET_MAP[options.reasoningEffort] ||
            EFFORT_BUDGET_MAP.high;
        streamPayload.thinking = { type: "enabled", budget_tokens: budget };
        if (streamPayload.max_tokens <= budget) {
          streamPayload.max_tokens = budget + 1024;
        }
        // Anthropic requires temperature=1 and top_p/top_k unset when thinking is enabled
        streamPayload.temperature = 1;
        delete streamPayload.top_p;
        delete streamPayload.top_k;
      }

      const stream = getClient().messages.stream(streamPayload, {
        ...(options.signal && { signal: options.signal }),
      });

      // Track current content block type for server tool response processing
      let currentBlockType = null;
      let currentBlockName = null;
      let currentToolUseId = null;
      let codeInput = "";
      let usage = null;
      let messageStartUsage = null;

      for await (const chunk of stream) {
        if (options.signal?.aborted) {
          stream.abort();
          break;
        }
        // Capture input token counts from message_start (sent once at stream start).
        // Anthropic sends input_tokens, cache_read_input_tokens, and
        // cache_creation_input_tokens here — message_delta only has output_tokens.
        if (chunk.type === "message_start" && chunk.message?.usage) {
          messageStartUsage = chunk.message.usage;
          continue;
        }
        // Content block start — track what kind of block we're in
        if (chunk.type === "content_block_start") {
          const block = chunk.content_block;
          currentBlockType = block?.type || null;
          currentBlockName = block?.name || null;
          currentToolUseId = block?.id || null;
          codeInput = "";

          // Server tool use start — yield the tool name being invoked
          if (
            block?.type === "server_tool_use" &&
            block?.name === "code_execution"
          ) {
            // Code execution starting — we'll accumulate the input
          }
          continue;
        }

        // Content block stop
        if (chunk.type === "content_block_stop") {
          // Server code execution — yield code
          if (
            currentBlockType === "server_tool_use" &&
            currentBlockName === "code_execution" &&
            codeInput
          ) {
            try {
              const parsed = JSON.parse(codeInput);
              if (parsed.code) {
                yield {
                  type: "executableCode",
                  code: parsed.code,
                  language: parsed.language || "bash",
                };
              }
            } catch {
              // Not valid JSON, skip
            }
          }
          // Custom tool_use block ended — emit toolCall
          if (currentBlockType === "tool_use") {
            let args = {};
            if (codeInput) {
              try {
                args = JSON.parse(codeInput);
              } catch {
                // Not valid JSON, use empty
              }
            }
            yield {
              type: "toolCall",
              id: currentToolUseId,
              name: currentBlockName,
              args,
            };
          }
          currentBlockType = null;
          currentBlockName = null;
          currentToolUseId = null;
          codeInput = "";
          continue;
        }

        // Content block deltas
        if (chunk.type === "content_block_delta") {
          // Thinking delta
          if (chunk.delta.type === "thinking_delta") {
            yield { type: "thinking", content: chunk.delta.thinking };
            continue;
          }
          // Text delta
          if (chunk.delta.type === "text_delta") {
            yield chunk.delta.text;
            continue;
          }
          // Input JSON delta for server tool use or custom tool_use (accumulate)
          if (
            chunk.delta.type === "input_json_delta" &&
            (currentBlockType === "server_tool_use" ||
              currentBlockType === "tool_use")
          ) {
            codeInput += chunk.delta.partial_json || "";
            continue;
          }
        }

        // Code execution tool result
        if (
          chunk.type === "content_block_start" &&
          chunk.content_block?.type === "code_execution_tool_result"
        ) {
          const result = chunk.content_block.content;
          if (result) {
            yield {
              type: "codeExecutionResult",
              output: result.stdout || result.stderr || "",
              outcome: result.return_code === 0 ? "OK" : "ERROR",
            };
          }
          continue;
        }

        // Web search / web fetch tool result — extract citations
        if (
          chunk.type === "content_block_start" &&
          (chunk.content_block?.type === "web_search_tool_result" ||
            chunk.content_block?.type === "web_fetch_tool_result")
        ) {
          const content = chunk.content_block.content;
          if (Array.isArray(content)) {
            const results = content
              .filter(
                (r) =>
                  r.type === "web_search_result" ||
                  r.type === "web_fetch_result",
              )
              .map((r) => ({
                url: r.url,
                title: r.title,
                pageAge: r.page_age,
              }));
            if (results.length > 0) {
              yield { type: "webSearchResult", results };
            }
          }
          continue;
        }

        // Message delta (final usage) — carries output_tokens only
        if (chunk.type === "message_delta" && chunk.usage) {
          usage = {
            inputTokens: messageStartUsage?.input_tokens ?? 0,
            outputTokens: chunk.usage.output_tokens ?? 0,
            cacheReadInputTokens:
              messageStartUsage?.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens:
              messageStartUsage?.cache_creation_input_tokens ?? 0,
          };
        }
      }

      // Get full usage from the finalized message
      try {
        const finalMessage = await stream.finalMessage();
        if (finalMessage?.usage) {
          usage = buildUsage(finalMessage.usage);
        }
      } catch {
        // finalMessage() can throw for tool_use stop reasons — use message_delta usage
      }
      if (usage) {
        yield { type: "usage", usage };
      } else {
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
      }
    } catch (error) {
      if (error.name === "AbortError") return;
      throw new ProviderError(
        "anthropic",
        error.message,
        error.status || 500,
        error,
      );
    }
  },
};

export default anthropicProvider;

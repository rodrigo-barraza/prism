import { GoogleGenAI, Modality } from "@google/genai";
import crypto from "crypto";
import { Readable } from "stream";
import { ProviderError } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { GOOGLE_API_KEY } from "../../secrets.js";
import { TYPES, MODELS, DEFAULT_VOICES, getDefaultModels } from "../config.js";

let client = null;

function getClient() {
  if (!client) {
    if (!GOOGLE_API_KEY) {
      throw new ProviderError("google", "GOOGLE_API_KEY is not set", 401);
    }
    client = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
  }
  return client;
}

/**
 * Detect content safety block errors from the Google GenAI SDK.
 * These occur when Gemini refuses to generate content due to content policy.
 * Returns true for errors that should be handled gracefully (empty result)
 * rather than propagated as 500 server errors.
 */
function isSafetyBlockError(error) {
  const msg = (error?.message || "").toLowerCase();
  return (
    msg.includes("prohibited_content") ||
    msg.includes("image_safety") ||
    msg.includes("safety") ||
    msg.includes("blocked") ||
    msg.includes("content filter") ||
    msg.includes("response was blocked")
  );
}

/**
 * Add a WAV header to raw PCM audio data.
 */
function addWavHeader(buffer, sampleRate = 24000, numChannels = 1) {
  const headerLength = 44;
  const dataLength = buffer.length;
  const fileSize = dataLength + headerLength - 8;
  const header = Buffer.alloc(headerLength);

  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * numChannels * 2, 28);
  header.writeUInt16LE(numChannels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);

  return Buffer.concat([header, buffer]);
}

/**
 * Convert OpenAI-style messages to Google GenAI content format.
 * Handles image content from base64 data URLs.
 * Note: Images on assistant/model messages are stripped to avoid
 * Gemini's thought_signature requirement for model-generated images.
 */
/**
 * Recursively sanitize a JSON Schema object for Google's restricted format.
 * Gemini's functionDeclarations only support a subset of JSON Schema —
 * unsupported keywords like `const`, `$schema`, `$id`, `$ref`, `examples`,
 * `default`, `additionalProperties` etc. cause 400 INVALID_ARGUMENT errors.
 *
 * Strategy:
 *   - `const: "value"` → `enum: ["value"]` (semantically equivalent)
 *   - Other unsupported keys → stripped entirely
 */
const GOOGLE_UNSUPPORTED_KEYS = new Set([
  "$schema", "$id", "$ref", "examples", "default",
  "additionalProperties", "patternProperties", "if", "then", "else",
  "allOf", "anyOf", "oneOf", "not", "title",
]);

function sanitizeSchemaForGoogle(schema, isPropertyMap = false) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map((item) => sanitizeSchemaForGoogle(item, false));

  const cleaned = {};
  for (const [key, value] of Object.entries(schema)) {
    // Convert `const` → single-value `enum`
    if (key === "const" && !isPropertyMap) {
      cleaned.enum = [value];
      continue;
    }
    // Strip unsupported schema keywords — but NOT when we're iterating
    // over a `properties` map, where keys are user-defined field names
    // (e.g. properties.title is a field called "title", not the JSON Schema title keyword)
    if (!isPropertyMap && GOOGLE_UNSUPPORTED_KEYS.has(key)) continue;
    // When we hit a "properties" key, its children are a map of field names → schemas
    cleaned[key] = sanitizeSchemaForGoogle(value, key === "properties");
  }
  return cleaned;
}

/**
 * Convert generic tool schemas to Google's functionDeclarations format.
 * Input:  [{ name, description, parameters: { type, properties, required } }]
 * Output: [{ functionDeclarations: [...] }]
 */
export function convertToolsToGoogle(tools) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return null;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description || "",
        parameters: sanitizeSchemaForGoogle(t.parameters || {}),
      })),
    },
  ];
}

function convertMessages(messages) {
  const result = [];

  for (let i = 0; i < messages.length; i++) {
    const item = messages[i];
    const parts = [];

    // ── Consecutive tool result messages → single user turn ──
    // Gemini requires ALL functionResponse parts for a model turn
    // to be grouped in one user message.
    if (item.role === "tool") {
      const responseParts = [];
      let j = i;
      while (j < messages.length && messages[j].role === "tool") {
        const toolMsg = messages[j];
        responseParts.push({
          functionResponse: {
            name: toolMsg.name || "unknown",
            response: {
              result:
                typeof toolMsg.content === "string"
                  ? toolMsg.content
                  : JSON.stringify(toolMsg.content),
            },
          },
        });
        j++;
      }
      result.push({ role: "user", parts: responseParts });
      i = j - 1; // skip merged messages (loop will i++)
      continue;
    }

    // Only include media for user messages — model-generated media
    // require a thought_signature when sent back, so we skip them.
    if (item.role !== "assistant") {
      // All media fields are arrays of data URLs
      for (const field of ["images", "audio", "video", "pdf"]) {
        const arr = item[field];
        if (arr && Array.isArray(arr)) {
          for (const dataUrl of arr) {
            const match = dataUrl.match(
              /^data:([\w-]+\/[\w.+-]+);base64,(.+)$/,
            );
            if (match) {
              parts.push({
                inlineData: { mimeType: match[1], data: match[2] },
              });
            }
          }
        }
      }
    }

    // Assistant messages with tool calls — include functionCall parts
    if (item.role === "assistant" && item.toolCalls) {
      for (const tc of item.toolCalls) {
        const fcPart = { functionCall: { name: tc.name, args: tc.args || {} } };
        // Preserve thoughtSignature (sibling of functionCall, required by Gemini)
        if (tc.thoughtSignature) {
          fcPart.thoughtSignature = tc.thoughtSignature;
        }
        parts.push(fcPart);
      }
    }

    if (item.content) {
      parts.push({ text: item.content });
    }
    result.push({
      role: item.role === "assistant" ? "model" : "user",
      parts,
    });
  }

  return result;
}

const googleProvider = {
  name: "google",

  async generateText(
    messages,
    model = getDefaultModels(TYPES.TEXT, TYPES.TEXT).google,
    options = {},
  ) {
    logger.provider("Google", `generateText model=${model}`);
    try {
      const contents = convertMessages(messages);
      const config = {};
      if (options.temperature !== undefined) {
        config.temperature = options.temperature;
      }
      if (options.topP !== undefined) {
        config.topP = options.topP;
      }
      if (options.topK !== undefined) {
        config.topK = options.topK;
      }
      if (options.presencePenalty !== undefined) {
        config.presencePenalty = options.presencePenalty;
      }
      if (options.frequencyPenalty !== undefined) {
        config.frequencyPenalty = options.frequencyPenalty;
      }
      if (options.stopSequences !== undefined) {
        config.stopSequences = options.stopSequences;
      }
      if (options.maxTokens !== undefined) {
        config.maxOutputTokens = options.maxTokens;
      }

      // Resolve model definition early — needed for thinking and image checks
      const modelDef = Object.values(MODELS).find((m) => m.name === model);

      if (options.thinkingEnabled !== false && (options.thinkingLevel || options.thinkingBudget !== undefined)) {
        config.thinkingConfig = {
          includeThoughts: true,
        };
        // Only send thinkingLevel if the model explicitly supports it
        // (image models support thinking but reject thinkingLevel)
        if (options.thinkingLevel && modelDef?.thinkingLevels) {
          config.thinkingConfig.thinkingLevel = options.thinkingLevel;
        }
        if (
          options.thinkingBudget !== undefined &&
          options.thinkingBudget !== ""
        ) {
          config.thinkingConfig.thinkingBudgetTokens = parseInt(
            options.thinkingBudget,
          );
        }
      }
      if (options.webSearch) {
        config.tools = [{ googleSearch: {} }];
      }

      // Custom function calling tools
      const customTools = convertToolsToGoogle(options.tools);
      if (customTools) {
        config.tools = [...(config.tools || []), ...customTools];
      }

      // For models that output images, set responseModalities explicitly.
      // These models REQUIRE ["TEXT", "IMAGE"] — ["TEXT"] alone returns 0 tokens.
      if (modelDef?.outputTypes?.includes(TYPES.IMAGE)) {
        config.responseModalities = options.forceImageGeneration
          ? ["IMAGE"]
          : ["TEXT", "IMAGE"];
      }

      const response = await getClient().models.generateContent({
        model,
        contents,
        config,
      });

      // Check for function calls, images, and text in the response
      const toolCalls = [];
      const textParts = [];
      const images = [];
      const maxImages = options.imageCount || 1;
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.functionCall) {
          toolCalls.push({
            id: `google-tc-${crypto.randomUUID()}`,
            name: part.functionCall.name,
            args: part.functionCall.args || {},
            thoughtSignature: part.thoughtSignature || undefined,
          });
        } else if (part.text) {
          textParts.push(part.text);
        } else if (part.inlineData && images.length < maxImages) {
          images.push({
            data: part.inlineData.data,
            mimeType: part.inlineData.mimeType || "image/png",
          });
        }
      }

      const result = {
        text: textParts.join("") || response.text || "",
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
      if (toolCalls.length > 0) result.toolCalls = toolCalls;
      if (images.length > 0) result.images = images;
      return result;
    } catch (error) {
      // Content safety blocks (PROHIBITED_CONTENT, SAFETY, IMAGE_SAFETY)
      // should return an empty result, not a 500. This lets consumers
      // handle "no image generated" gracefully and preserves the conversation.
      if (isSafetyBlockError(error)) {
        logger.error(`[Google] Content safety block: ${error.message}`);
        return {
          text: "",
          usage: { inputTokens: 0, outputTokens: 0 },
          safetyBlock: true,
        };
      }
      throw new ProviderError("google", error.message, 500, error);
    }
  },

  async *generateTextStream(
    messages,
    model = getDefaultModels(TYPES.TEXT, TYPES.TEXT).google,
    options = {},
  ) {
    logger.provider("Google", `generateTextStream model=${model}`);
    try {
      const contents = convertMessages(messages);
      const config = {};
      if (options.temperature !== undefined) {
        config.temperature = options.temperature;
      }
      if (options.topP !== undefined) {
        config.topP = options.topP;
      }
      if (options.topK !== undefined) {
        config.topK = options.topK;
      }
      if (options.presencePenalty !== undefined) {
        config.presencePenalty = options.presencePenalty;
      }
      if (options.frequencyPenalty !== undefined) {
        config.frequencyPenalty = options.frequencyPenalty;
      }
      if (options.stopSequences !== undefined) {
        config.stopSequences = options.stopSequences;
      }
      if (options.maxTokens !== undefined) {
        config.maxOutputTokens = options.maxTokens;
      }

      // Resolve model definition early — needed for thinking and image checks
      const modelDef = Object.values(MODELS).find((m) => m.name === model);

      if (options.thinkingEnabled !== false && (options.thinkingLevel || options.thinkingBudget !== undefined)) {
        config.thinkingConfig = {
          includeThoughts: true,
        };
        // Only send thinkingLevel if the model explicitly supports it
        if (options.thinkingLevel && modelDef?.thinkingLevels) {
          config.thinkingConfig.thinkingLevel = options.thinkingLevel;
        }
        if (
          options.thinkingBudget !== undefined &&
          options.thinkingBudget !== ""
        ) {
          config.thinkingConfig.thinkingBudgetTokens = parseInt(
            options.thinkingBudget,
          );
        }
      }
      // Build tools array based on enabled options
      const tools = [];
      if (options.webSearch) tools.push({ googleSearch: {} });
      if (options.codeExecution) tools.push({ codeExecution: {} });
      if (options.urlContext) tools.push({ urlContext: {} });

      // Custom function calling tools
      const customTools = convertToolsToGoogle(options.tools);
      if (customTools) tools.push(...customTools);

      if (tools.length > 0) config.tools = tools;

      // For models that output images, set responseModalities explicitly.
      // These models REQUIRE ["TEXT", "IMAGE"] — ["TEXT"] alone returns 0 tokens.
      if (modelDef?.outputTypes?.includes(TYPES.IMAGE)) {
        config.responseModalities = options.forceImageGeneration
          ? ["IMAGE"]
          : ["TEXT", "IMAGE"];
      }

      const streamConfig = { ...config };
      if (options.signal) {
        streamConfig.httpOptions = { signal: options.signal };
      }
      const responseStream = await getClient().models.generateContentStream({
        model,
        contents,
        config: streamConfig,
      });
      let usage = null;
      const maxImages = options.imageCount || 1;
      let imageCount = 0;
      for await (const chunk of responseStream) {
        if (options.signal?.aborted) break;
        // Process all parts in the chunk
        if (chunk.candidates?.[0]?.content?.parts) {
          for (const part of chunk.candidates[0].content.parts) {
            if (part.functionCall) {
              yield {
                type: "toolCall",
                id: `google-tc-${crypto.randomUUID()}`,
                name: part.functionCall.name,
                args: part.functionCall.args || {},
                thoughtSignature: part.thoughtSignature || undefined,
              };
            } else if (part.thought && part.text) {
              yield { type: "thinking", content: part.text };
            } else if (part.text) {
              yield part.text;
            } else if (part.inlineData && imageCount < maxImages) {
              imageCount++;
              yield {
                type: "image",
                data: part.inlineData.data,
                mimeType: part.inlineData.mimeType || "image/png",
              };
            } else if (part.executableCode?.code) {
              yield {
                type: "executableCode",
                code: part.executableCode.code,
                language: part.executableCode.language || "python",
              };
            } else if (part.codeExecutionResult) {
              yield {
                type: "codeExecutionResult",
                output: part.codeExecutionResult.output || "",
                outcome: part.codeExecutionResult.outcome || "OK",
              };
            }
          }
        } else if (chunk.text) {
          yield chunk.text;
        }
        if (chunk.usageMetadata) {
          usage = {
            inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
            outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
          };
        }
      }
      if (usage) {
        yield { type: "usage", usage };
      } else {
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
      }
    } catch (error) {
      if (error.name === "AbortError") return;
      if (isSafetyBlockError(error)) {
        logger.error(`[Google] Content safety block (stream): ${error.message}`);
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 }, safetyBlock: true };
        return;
      }
      throw new ProviderError("google", error.message, 500, error);
    }
  },

  /**
   * Live API streaming — for models that only support the bidirectional
   * WebSocket-based BidiGenerateContent method (e.g. gemini-3.1-flash-live-preview).
   *
   * Bridges the event-driven Live API into an async generator matching
   * the same interface as generateTextStream().
   */
  async *generateTextStreamLive(messages, model, options = {}) {
    logger.provider(
      "Google",
      `generateTextStreamLive (Live API) model=${model}`,
    );
    let session = null;
    try {
      // ── Build Live API config ────────────────────────────────────
      // This model ONLY supports AUDIO output modality.
      // Text responses come via outputTranscription, not responseModalities.
      const liveConfig = {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
      };

      if (options.temperature !== undefined) {
        liveConfig.temperature = options.temperature;
      }
      if (options.topP !== undefined) {
        liveConfig.topP = options.topP;
      }
      if (options.topK !== undefined) {
        liveConfig.topK = options.topK;
      }
      if (options.maxTokens !== undefined) {
        liveConfig.maxOutputTokens = options.maxTokens;
      }
      if (options.thinkingEnabled !== false && (options.thinkingLevel || options.thinkingBudget !== undefined)) {
        liveConfig.thinkingConfig = { includeThoughts: true };
        if (options.thinkingLevel) {
          liveConfig.thinkingConfig.thinkingLevel = options.thinkingLevel;
        }
        if (
          options.thinkingBudget !== undefined &&
          options.thinkingBudget !== ""
        ) {
          liveConfig.thinkingConfig.thinkingBudgetTokens = parseInt(
            options.thinkingBudget,
          );
        }
      }

      // Tools
      const tools = [];
      if (options.webSearch) tools.push({ googleSearch: {} });
      const customTools = convertToolsToGoogle(options.tools);
      if (customTools) tools.push(...customTools);
      if (tools.length > 0) liveConfig.tools = tools;

      // System instruction from messages[0] if role === "system"
      const systemMsg = messages.find((m) => m.role === "system");
      if (systemMsg?.content) {
        liveConfig.systemInstruction = systemMsg.content;
      }

      // ── Async queue to bridge callbacks → async generator ─────────
      const queue = [];
      let resolver = null;
      let done = false;
      let setupComplete = false;

      function enqueue(item) {
        if (resolver) {
          const r = resolver;
          resolver = null;
          r(item);
        } else {
          queue.push(item);
        }
      }

      function dequeue() {
        if (queue.length > 0) {
          return Promise.resolve(queue.shift());
        }
        return new Promise((resolve) => {
          resolver = resolve;
        });
      }

      // ── Connect to Live API ───────────────────────────────────────
      session = await getClient().live.connect({
        model,
        config: liveConfig,
        callbacks: {
          onopen: () => {
            logger.provider("Google", `Live API session opened for ${model}`);
          },
          onmessage: (msg) => {
            // Setup complete — signal we can send messages
            if (msg.setupComplete !== undefined) {
              setupComplete = true;
              enqueue({ type: "setupComplete" });
              return;
            }

            // Audio data from model turn (inlineData)
            if (msg.serverContent?.modelTurn?.parts) {
              for (const part of msg.serverContent.modelTurn.parts) {
                if (part.thought && part.text) {
                  enqueue({ type: "thinking", content: part.text });
                } else if (part.inlineData) {
                  // Audio chunks from the model — forward for playback
                  enqueue({
                    type: "audio",
                    data: part.inlineData.data,
                    mimeType: part.inlineData.mimeType,
                  });
                } else if (part.text) {
                  enqueue({ type: "text", content: part.text });
                } else if (part.functionCall) {
                  enqueue({
                    type: "toolCall",
                    id: `google-tc-${crypto.randomUUID()}`,
                    name: part.functionCall.name,
                    args: part.functionCall.args || {},
                    thoughtSignature: part.thoughtSignature || undefined,
                  });
                }
              }
            }

            // Output transcription — TEXT transcript of the audio output.
            // This is the primary text content for the SSE chat flow.
            if (msg.serverContent?.outputTranscription?.text) {
              enqueue({
                type: "text",
                content: msg.serverContent.outputTranscription.text,
              });
            }

            // Tool calls from the server
            if (msg.toolCall?.functionCalls) {
              for (const fc of msg.toolCall.functionCalls) {
                enqueue({
                  type: "toolCall",
                  id: `google-tc-${crypto.randomUUID()}`,
                  name: fc.name,
                  args: fc.args || {},
                });
              }
            }

            // Usage metadata
            if (msg.usageMetadata) {
              const u = msg.usageMetadata;
              if (u.promptTokenCount || u.candidatesTokenCount) {
                enqueue({
                  type: "usage",
                  usage: {
                    inputTokens: u.promptTokenCount ?? 0,
                    outputTokens: u.candidatesTokenCount ?? 0,
                  },
                });
              }
            }

            // Turn complete — signal we're done
            if (msg.serverContent?.turnComplete) {
              done = true;
              enqueue({ type: "done" });
            }
          },
          onerror: (e) => {
            logger.error(
              `[Google Live API] Error: ${e?.error?.message || e?.message || "unknown"}`,
            );
            done = true;
            enqueue({
              type: "error",
              message: e?.error?.message || e?.message || "Live API error",
            });
          },
          onclose: () => {
            logger.provider("Google", "Live API session closed");
            done = true;
            enqueue({ type: "done" });
          },
        },
      });

      // ── Wait for setupComplete before sending ─────────────────────
      while (!setupComplete) {
        const item = await dequeue();
        if (item?.type === "setupComplete") break;
        if (item?.type === "error")
          throw new ProviderError("google", item.message, 500);
        if (item?.type === "done") return;
      }

      // ── Seed conversation history & send user message ─────────────
      // sendClientContent works for seeding prior turns (turnComplete: false)
      // but causes "invalid argument" when used as the final turn.
      // So we seed history with sendClientContent, then send the last
      // user message via sendRealtimeInput.
      const nonSystemMessages = messages.filter((m) => m.role !== "system");
      const lastUserMsg = nonSystemMessages[nonSystemMessages.length - 1];
      const priorMessages = nonSystemMessages.slice(0, -1);

      // Build Content objects for prior history turns
      if (priorMessages.length > 0) {
        const historyTurns = [];
        for (const msg of priorMessages) {
          const parts = [];

          if (msg.content) {
            parts.push({ text: msg.content });
          }

          if (parts.length > 0) {
            historyTurns.push({
              role: msg.role === "assistant" ? "model" : "user",
              parts,
            });
          }
        }

        if (historyTurns.length > 0) {
          session.sendClientContent({
            turns: historyTurns,
            turnComplete: false,
          });
        }
      }

      // Send the final user message via sendRealtimeInput
      if (lastUserMsg?.content) {
        session.sendRealtimeInput({ text: lastUserMsg.content });
      }

      // ── Yield chunks from the queue ───────────────────────────────
      while (!done || queue.length > 0) {
        if (options.signal?.aborted) break;

        const item = await dequeue();
        if (!item || item.type === "done") break;

        if (item.type === "error") {
          throw new ProviderError("google", item.message, 500);
        }

        if (item.type === "text") {
          yield item.content;
        } else if (item.type === "thinking") {
          yield { type: "thinking", content: item.content };
        } else if (item.type === "toolCall") {
          yield {
            type: "toolCall",
            id: item.id,
            name: item.name,
            args: item.args,
            thoughtSignature: item.thoughtSignature,
          };
        } else if (item.type === "usage") {
          yield { type: "usage", usage: item.usage };
        } else if (item.type === "audio") {
          yield { type: "audio", data: item.data, mimeType: item.mimeType };
        }
      }
    } catch (error) {
      if (error.name === "AbortError") return;
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("google", error.message, 500, error);
    } finally {
      if (session) {
        try {
          session.close();
        } catch {
          /* already closed */
        }
      }
    }
  },

  async captionImage(
    images,
    prompt = "Describe this image.",
    model = getDefaultModels(TYPES.IMAGE, TYPES.TEXT).google,
    systemPrompt,
  ) {
    logger.provider("Google", `captionImage model=${model}`);
    try {
      // Process each image into inline data parts
      const imageParts = [];
      for (const imageUrlOrBase64 of images) {
        let imageData = imageUrlOrBase64;
        let mimeType = "image/jpeg";

        if (imageUrlOrBase64.startsWith("http")) {
          const response = await fetch(imageUrlOrBase64);
          if (!response.ok) {
            throw new Error(
              `Failed to fetch image from URL: ${imageUrlOrBase64}`,
            );
          }
          const arrayBuffer = await response.arrayBuffer();
          imageData = Buffer.from(arrayBuffer).toString("base64");
          mimeType = response.headers.get("content-type") || "image/jpeg";
        } else if (imageUrlOrBase64.includes(";base64,")) {
          const parts = imageUrlOrBase64.split(";base64,");
          mimeType = parts[0].split(":")[1];
          imageData = parts[1];
        }

        imageParts.push({ inlineData: { data: imageData, mimeType } });
      }

      const contents = [
        {
          role: "user",
          parts: [...imageParts, { text: prompt }],
        },
      ];

      const config = {};
      if (systemPrompt) {
        config.systemInstruction = systemPrompt;
      }

      const response = await getClient().models.generateContent({
        model,
        contents,
        config: Object.keys(config).length > 0 ? config : undefined,
      });
      const usage = {
        inputTokens: response.usageMetadata?.promptTokenCount || 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
      };
      return { text: response.text, usage };
    } catch (error) {
      throw new ProviderError("google", error.message, 500, error);
    }
  },

  async generateImage(
    prompt,
    images = [],
    model = MODELS.GEMINI_3_PRO_IMAGE.name,
    systemPrompt,
  ) {
    logger.provider("Google", `generateImage model=${model}`);
    try {
      const config = {
        responseModalities: ["IMAGE"],
        imageConfig: { imageSize: "1K" },
      };

      if (systemPrompt) {
        config.systemInstruction = systemPrompt;
      }

      const parts = [{ text: prompt }];
      if (images.length) {
        for (const image of images) {
          // Support both data URL strings and { imageData, mimeType } objects
          if (typeof image === "string") {
            const match = image.match(/^data:([\w-]+\/[\w.+-]+);base64,(.+)$/);
            if (match) {
              parts.push({
                inlineData: { mimeType: match[1], data: match[2] },
              });
            }
          } else {
            parts.push({
              inlineData: {
                data: image.imageData,
                mimeType: image.mimeType || "image/jpeg",
              },
            });
          }
        }
      }

      const contents = [{ role: "user", parts }];
      const response = await getClient().models.generateContentStream({
        model,
        config,
        contents,
      });

      let combinedText = "";
      for await (const chunk of response) {
        if (!chunk.candidates?.[0]?.content?.parts) continue;
        if (chunk.candidates?.[0]?.finishReason === "PROHIBITED_CONTENT") {
          throw new Error("Content was flagged as prohibited by Google AI");
        }
        const part = chunk.candidates[0].content.parts[0];
        if (part.inlineData) {
          return {
            imageData: part.inlineData.data,
            mimeType: part.inlineData.mimeType || "image/png",
            text: combinedText,
          };
        } else if (chunk.text) {
          combinedText += chunk.text;
        }
      }
      throw new Error("No image data received from Google AI");
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("google", error.message, 500, error);
    }
  },

  async generateSpeech(text, voice = DEFAULT_VOICES.google, options = {}) {
    logger.provider("Google", `generateSpeech voice=${voice}`);
    try {
      const config = {
        temperature: 1,
        responseModalities: ["audio"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice,
            },
          },
        },
      };

      const response = await getClient().models.generateContent({
        model:
          options.model || getDefaultModels(TYPES.TEXT, TYPES.AUDIO).google,
        contents: [
          {
            role: "user",
            parts: [
              { text: options.prompt ? `${options.prompt}\n\n${text}` : text },
            ],
          },
        ],
        config,
      });

      const candidates = response.candidates;
      if (candidates?.[0]?.content?.parts?.[0]?.inlineData) {
        const inlineData = candidates[0].content.parts[0].inlineData;
        const audioBuffer = Buffer.from(inlineData.data || "", "base64");

        if (
          inlineData.mimeType === "audio/mpeg" ||
          inlineData.mimeType === "audio/mp3"
        ) {
          return {
            stream: Readable.from(audioBuffer),
            contentType: "audio/mpeg",
          };
        } else {
          const wavBuffer = addWavHeader(audioBuffer);
          return { stream: Readable.from(wavBuffer), contentType: "audio/wav" };
        }
      } else {
        throw new Error("No audio content received from Google GenAI");
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("google", error.message, 500, error);
    }
  },

  async transcribeAudio(
    audioBuffer,
    mimeType,
    model = "gemini-3-flash-preview",
    options = {},
  ) {
    logger.provider("Google", `transcribeAudio model=${model}`);
    try {
      const audioBase64 = audioBuffer.toString("base64");
      const prompt =
        options.prompt ||
        "Transcribe the following audio accurately. Return only the transcription text, nothing else.";

      const contents = [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: audioBase64 } },
            { text: prompt },
          ],
        },
      ];

      const config = {};
      if (options.language) {
        config.systemInstruction = `Transcribe in ${options.language}.`;
      }

      const response = await getClient().models.generateContent({
        model,
        contents,
        config,
      });

      return {
        text: response.text || "",
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    } catch (error) {
      throw new ProviderError("google", error.message, 500, error);
    }
  },

  async generateEmbedding(content, model, options = {}) {
    model =
      model ||
      getDefaultModels(TYPES.TEXT, TYPES.EMBEDDING)?.google ||
      "gemini-embedding-2-preview";
    logger.provider("Google", `generateEmbedding model=${model}`);
    try {
      const params = { model };
      const config = {};

      // Build the contents for the embedding request
      if (typeof content === "string") {
        // Simple text-only input
        params.contents = content;
      } else if (Array.isArray(content)) {
        // Multimodal: wrap all parts in a single Content object.
        // The SDK maps each top-level array item to a separate batch request,
        // so we must bundle parts into one Content to get a single embedding.
        params.contents = { role: "user", parts: content };
      } else {
        params.contents = content;
      }

      if (options.taskType) {
        config.taskType = options.taskType;
      }
      if (options.dimensions) {
        config.outputDimensionality = options.dimensions;
      }

      if (Object.keys(config).length > 0) {
        params.config = config;
      }

      const response = await getClient().models.embedContent(params);

      // embedContent returns { embeddings: [{ values: [...] }] } for batch/multimodal,
      // or { embedding: { values: [...] } } for single text
      let values;
      if (response.embedding?.values) {
        values = response.embedding.values;
      } else if (response.embeddings?.[0]?.values) {
        values = response.embeddings[0].values;
      } else {
        throw new Error("No embedding data in response");
      }

      return {
        embedding: values,
        dimensions: values.length,
      };
    } catch (error) {
      throw new ProviderError(
        "google",
        error.message,
        error.status || 500,
        error,
      );
    }
  },
};

export default googleProvider;

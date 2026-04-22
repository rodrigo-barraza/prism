// ─────────────────────────────────────────────────────────────
// StreamChunkDispatcher — Shared stream chunk processing
// ─────────────────────────────────────────────────────────────
// Centralises the chunk-type dispatching logic used by
// handleStreamingText (chat.js) and AgenticLoopService.
// ─────────────────────────────────────────────────────────────

import FileService from "../services/FileService.js";
import logger from "./logger.js";

/**
 * Process a provider image chunk: upload to MinIO and track the ref.
 *
 * @param {object} chunk - Image chunk from the provider stream
 * @param {string} project
 * @param {string} username
 * @param {string} [logPrefix="stream"] - Prefix for error logs
 * @returns {Promise<string|null>} MinIO ref, or null on failure
 */
export async function uploadImageChunk(chunk, project, username, logPrefix = "stream") {
  if (!chunk.data) return null;
  try {
    const mimeType = chunk.mimeType || "image/png";
    const dataUrl = `data:${mimeType};base64,${chunk.data}`;
    const { ref } = await FileService.uploadFile(dataUrl, "generations", project, username);
    return ref;
  } catch (err) {
    logger.error(`[${logPrefix}] MinIO upload failed: ${err.message}`);
    return null;
  }
}

/**
 * Create an image ref string, preferring MinIO ref over inline base64.
 *
 * @param {string|null} minioRef
 * @param {string} data - Base64 image data
 * @param {string} [mimeType="image/png"]
 * @returns {string}
 */
export function imageRefOrInline(minioRef, data, mimeType = "image/png") {
  return minioRef || `data:${mimeType};base64,${data}`;
}

/**
 * Dispatch a single typed chunk to an accumulator state object and emit function.
 *
 * This is the single source of truth for the chunk type → handler mapping that was
 * previously duplicated across chat.js (handleStreamingText) and AgenticLoopService.
 *
 * @param {object} chunk - A chunk from the provider's async generator
 * @param {object} state - Mutable accumulator for generation state
 * @param {string|null} state.thinking - Accumulated thinking text
 * @param {string} state.thinkingSignature - Anthropic thinking signature
 * @param {Array} state.images - Accumulated MinIO image refs
 * @param {Array} state.toolCalls - Accumulated tool call entries
 * @param {Array} state.audioChunks - Base64-encoded PCM audio chunks
 * @param {number} state.audioSampleRate - Detected audio sample rate
 * @param {number} state.outputCharacters - Total output character count
 * @param {string} state.text - Accumulated text output
 * @param {number|null} state.firstTokenTime - First text token timestamp
 * @param {number|null} state.generationEnd - Last token timestamp
 * @param {object|null} state.usage - Usage object from provider
 * @param {object} ctx - Request context
 * @param {Function} ctx.emit - SSE emit function
 * @param {string} ctx.project
 * @param {string} ctx.username
 * @param {object} [options]
 * @param {Function} [options.onUsage] - Custom usage handler (for merging across iterations)
 * @param {string} [options.logPrefix] - Prefix for error logs
 * @returns {Promise<boolean>} true if chunk was handled, false if unrecognised
 */
export async function dispatchChunk(chunk, state, ctx, options = {}) {
  const { emit, project, username } = ctx;
  const logPrefix = options.logPrefix || "stream";

  // Non-object chunks are treated as text (raw string from provider)
  if (!chunk || typeof chunk !== "object") {
    if (!state.firstTokenTime) {
      state.firstTokenTime = performance.now();
      if (state.requestStart) {
        emit({ type: "status", message: "generation_started", timeToFirstToken: (state.firstTokenTime - state.requestStart) / 1000 });
      }
    }
    state.generationEnd = performance.now();
    const chunkStr = typeof chunk === "string" ? chunk : "";
    state.outputCharacters += chunkStr.length;
    state.text += chunkStr;
    // Estimate tokens from content length (~4 chars/token). Cloud providers
    // (Anthropic, OpenAI, Google) emit multi-token text per chunk, so counting
    // 1 per chunk massively underestimates the live token count.
    state.outputTokenCount += Math.max(1, Math.ceil(chunkStr.length / 4));
    emit({ type: "chunk", content: chunkStr, outputTokens: state.outputTokenCount });
    return true;
  }

  switch (chunk.type) {
    case "usage":
      if (options.onUsage) {
        options.onUsage(chunk.usage);
      } else {
        state.usage = chunk.usage;
      }
      return true;

    case "rateLimits":
      state.rateLimits = chunk.rateLimits;
      return true;

    case "thinking":
      if (!state.firstTokenTime) {
        state.firstTokenTime = performance.now();
        if (state.requestStart) {
          emit({ type: "status", message: "generation_started", timeToFirstToken: (state.firstTokenTime - state.requestStart) / 1000 });
        }
      }
      state.generationEnd = performance.now();
      state.thinking += chunk.content;
      // Estimate tokens from content length (~4 chars/token) — thinking deltas
      // from cloud providers are multi-token, same as text chunks.
      state.outputTokenCount += Math.max(1, Math.ceil((chunk.content || "").length / 4));
      emit({ type: "thinking", content: chunk.content, outputTokens: state.outputTokenCount });
      return true;

    case "thinking_signature":
      state.thinkingSignature = chunk.signature;
      return true;

    case "image": {
      const minioRef = await uploadImageChunk(chunk, project, username, logPrefix);
      if (chunk.data) {
        state.images.push(imageRefOrInline(minioRef, chunk.data, chunk.mimeType));
      }
      emit({
        type: "image",
        data: chunk.data,
        mimeType: chunk.mimeType,
        minioRef,
      });
      return true;
    }

    case "executableCode":
      emit({ type: "executableCode", code: chunk.code, language: chunk.language });
      return true;

    case "codeExecutionResult":
      emit({ type: "codeExecutionResult", output: chunk.output, outcome: chunk.outcome });
      return true;

    case "webSearchResult":
      emit({ type: "webSearchResult", results: chunk.results });
      return true;

    case "audio":
      emit({ type: "audio", data: chunk.data, mimeType: chunk.mimeType });
      if (chunk.data) state.audioChunks.push(chunk.data);
      if (chunk.mimeType) {
        const rateMatch = chunk.mimeType.match(/rate=(\d+)/);
        if (rateMatch) state.audioSampleRate = parseInt(rateMatch[1], 10);
      }
      return true;

    case "toolCall":
      // Tool call chunks indicate model output — track generation timing
      if (!state.firstTokenTime) {
        state.firstTokenTime = performance.now();
        if (state.requestStart) {
          emit({ type: "status", message: "generation_started", timeToFirstToken: (state.firstTokenTime - state.requestStart) / 1000 });
        }
      }
      state.generationEnd = performance.now();

      if (chunk.status === "done" || chunk.status === "error") {
        const existing = state.toolCalls.find(
          (tc) =>
            (chunk.id && tc.id === chunk.id) ||
            (!chunk.id && tc.name === chunk.name && !tc.result),
        );
        if (existing) {
          existing.result = chunk.result || undefined;
          existing.status = chunk.status;
          if (chunk.args && Object.keys(chunk.args).length > 0) {
            existing.args = chunk.args;
          }
        }
      } else {
        state.toolCalls.push({
          id: chunk.id || null,
          name: chunk.name,
          args: chunk.args || {},
          result: chunk.result || undefined,
          status: chunk.status || undefined,
          thoughtSignature: chunk.thoughtSignature || undefined,
        });
      }
      emit({
        type: "toolCall",
        id: chunk.id || null,
        name: chunk.name,
        args: chunk.args || {},
        result: chunk.result || undefined,
        status: chunk.status || undefined,
        thoughtSignature: chunk.thoughtSignature || undefined,
      });
      return true;

    case "status":
      emit({ type: "status", message: chunk.message, phase: chunk.phase, ...(chunk.progress != null && { progress: chunk.progress }) });
      return true;

    default: {
      // Unknown typed chunk — treat as text
      if (!state.firstTokenTime) {
        state.firstTokenTime = performance.now();
        if (state.requestStart) {
          emit({ type: "status", message: "generation_started", timeToFirstToken: (state.firstTokenTime - state.requestStart) / 1000 });
        }
      }
      state.generationEnd = performance.now();
      const chunkStr = typeof chunk === "string" ? chunk : "";
      state.outputCharacters += chunkStr.length;
      state.text += chunkStr;
      state.outputTokenCount += Math.max(1, Math.ceil(chunkStr.length / 4));
      emit({ type: "chunk", content: chunkStr, outputTokens: state.outputTokenCount });
      return true;
    }
  }
}

/**
 * Create a fresh state accumulator for stream chunk dispatching.
 * @returns {object}
 */
export function createStreamState() {
  return {
    usage: null,
    firstTokenTime: null,
    generationEnd: null,
    requestStart: null,  // Set by caller to enable server-computed TTFT
    outputCharacters: 0,
    text: "",
    thinking: "",
    thinkingSignature: "",
    images: [],
    toolCalls: [],
    audioChunks: [],
    audioSampleRate: 24000,
    outputTokenCount: 0,  // Running output token counter for live client updates
    rateLimits: null,
  };
}

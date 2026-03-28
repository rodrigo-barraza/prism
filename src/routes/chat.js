import express from "express";
import crypto from "crypto";
import { getProvider } from "../providers/index.js";
import { ProviderError } from "../utils/errors.js";
import {
  TYPES,
  getDefaultModels,
  getPricing,
  getModelByName,
} from "../config.js";
import {
  calculateTextCost,
  calculateImageCost,
} from "../utils/CostCalculator.js";
import logger from "../utils/logger.js";
import RequestLogger from "../services/RequestLogger.js";
import ConversationService from "../services/ConversationService.js";
import FileService from "../services/FileService.js";

const router = express.Router();

// ============================================================
// Image reference resolution — converts refs for providers & storage
// ============================================================

/**
 * Resolve image references in messages for both provider use and storage.
 *
 * Returns a deep copy of messages where all images are base64 data URLs
 * (ready for providers). The ORIGINAL messages array is mutated in-place
 * so that images are stored as minio:// refs (for conversation storage).
 *
 * Handles:
 *  - data:... base64  → upload to MinIO (original gets minio ref), provider gets data URL
 *  - minio://...       → download from MinIO (original unchanged), provider gets data URL
 *  - http(s)://...     → fetch (original unchanged), provider gets data URL
 */
async function resolveImageRefs(messages, project, username) {
  // Deep copy for the provider — images will be data URLs
  const providerMessages = messages.map((m) => ({ ...m }));

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // ── Resolve media array fields: images, audio, video, pdf ──
    for (const field of ["images", "audio", "video", "pdf"]) {
      const arr = msg[field];
      if (arr && Array.isArray(arr) && arr.length > 0) {
        const providerArr = [];
        const storageArr = [];

        await Promise.all(
          arr.map(async (ref, j) => {
            const resolved = await resolveMediaRef(ref, project, username);
            providerArr[j] = resolved.providerRef;
            storageArr[j] = resolved.storageRef;
          }),
        );

        providerMessages[i][field] = providerArr;
        messages[i][field] = storageArr;
      }
    }
  }

  return providerMessages;
}

/**
 * Resolve a single media reference for both provider and storage use.
 * @returns {{ providerRef: string, storageRef: string }}
 */
async function resolveMediaRef(ref, project, username) {
  // Already a base64 data URL — upload to MinIO for storage, keep data URL for provider
  if (ref.startsWith("data:")) {
    let storageRef = ref;
    try {
      const { ref: minioRef } = await FileService.uploadFile(
        ref, "uploads", project, username,
      );
      storageRef = minioRef;
    } catch (err) {
      logger.error(`[chat] Failed to upload media to MinIO: ${err.message}`);
    }
    return { providerRef: ref, storageRef };
  }

  // MinIO reference — download for provider, keep ref for storage
  if (FileService.isMinioRef(ref)) {
    try {
      const key = FileService.extractKey(ref);
      const file = await FileService.getFile(key);
      if (!file) {
        logger.warn(`[chat] Could not resolve MinIO ref: ${ref}`);
        return { providerRef: ref, storageRef: ref };
      }
      const chunks = [];
      for await (const chunk of file.stream) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      const base64 = buffer.toString("base64");
      return {
        providerRef: `data:${file.contentType};base64,${base64}`,
        storageRef: ref,
      };
    } catch (err) {
      logger.error(`[chat] Failed to resolve MinIO ref ${ref}: ${err.message}`);
      return { providerRef: ref, storageRef: ref };
    }
  }

  // HTTP(S) URL — fetch for provider, keep URL for storage
  if (ref.startsWith("http://") || ref.startsWith("https://")) {
    try {
      const response = await fetch(ref);
      if (!response.ok) {
        logger.warn(`[chat] Failed to fetch media URL (${response.status}): ${ref}`);
        return { providerRef: ref, storageRef: ref };
      }
      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      return {
        providerRef: `data:${contentType};base64,${base64}`,
        storageRef: ref,
      };
    } catch (err) {
      logger.error(`[chat] Failed to fetch media URL ${ref}: ${err.message}`);
      return { providerRef: ref, storageRef: ref };
    }
  }

  // Unknown — pass through
  return { providerRef: ref, storageRef: ref };
}

// ============================================================
// Shared core logic — used by both REST (SSE) and WebSocket
// ============================================================

/**
 * Handle a chat request: text generation, image generation (for image-output
 * models), vision/captioning, and audio transcription — all via a unified
 * messages-based API.
 *
 * Payload follows a flat structure inspired by the OpenAI Chat Completions API:
 *   { provider, model, messages, tools?, temperature?, maxTokens?, ... }
 *
 * @param {Object}   params              Request parameters
 * @param {string}   params.provider     Provider name (required)
 * @param {string}   [params.model]      Model name (optional, uses default)
 * @param {Array}    params.messages     Messages array (required)
 * @param {Array}    [params.tools]      Tool/function definitions
 * @param {number}   [params.temperature]
 * @param {number}   [params.maxTokens]
 * @param {number}   [params.topP]
 * @param {number}   [params.topK]
 * @param {number}   [params.frequencyPenalty]
 * @param {number}   [params.presencePenalty]
 * @param {Array}    [params.stopSequences]
 * @param {string}   [params.conversationId]  Auto-append to conversation
 * @param {Object}   [params.conversationMeta] Title + systemPrompt for storage
 * @param {string}   params.project      Project identifier
 * @param {string}   params.username     Username identifier
 * @param {Function} emit                Callback to emit events: emit({ type, ...data })
 */
export async function handleChat(params, emit, { signal } = {}) {
  const requestStart = performance.now();
  const requestId = crypto.randomUUID();
  const {
    provider: providerName,
    model: requestedModel,
    messages,
    conversationId,
    conversationMeta,
    project = "unknown",
    username = "unknown",
    clientIp = null,
    // Generation options — flat at top-level (OpenAI-style)
    tools,
    temperature,
    maxTokens,
    topP,
    topK,
    frequencyPenalty,
    presencePenalty,
    stopSequences,
    thinkingEnabled,
    reasoningEffort,
    thinkingLevel,
    thinkingBudget,
    webSearch,
    webFetch,
    codeExecution,
    urlContext,
    verbosity,
    reasoningSummary,
    // systemPrompt arrives in two places by design:
    //  - messages[0] with role:"system" → what the LLM actually sees
    //  - conversationMeta.systemPrompt → stored as top-level DB field for quick UI access
    // The top-level param is ignored; only the messages array matters for generation.
    systemPrompt: _unusedSystemPrompt,
    ...extraParams
  } = params;

  // Build the internal options object that providers expect
  const options = {
    ...(tools && { tools }),
    ...(temperature !== undefined && { temperature }),
    ...(maxTokens !== undefined && { maxTokens }),
    ...(topP !== undefined && { topP }),
    ...(topK !== undefined && { topK }),
    ...(frequencyPenalty !== undefined && { frequencyPenalty }),
    ...(presencePenalty !== undefined && { presencePenalty }),
    ...(stopSequences && { stopSequences }),
    ...(thinkingEnabled !== undefined && { thinkingEnabled }),
    ...(reasoningEffort && { reasoningEffort }),
    ...(thinkingLevel && { thinkingLevel }),
    ...(thinkingBudget && { thinkingBudget }),
    ...(webSearch && { webSearch }),
    ...(webFetch && { webFetch }),
    ...(codeExecution && { codeExecution }),
    ...(urlContext && { urlContext }),
    ...(verbosity && { verbosity }),
    ...(reasoningSummary && { reasoningSummary }),
    ...(extraParams.systemPrompt && { systemPrompt: extraParams.systemPrompt }),
  };

  // LM Studio models inherently produce thinking tokens — always enable
  if (providerName === "lm-studio") {
    options.thinkingEnabled = true;
  }

  // Derive userMessage from the last user message in the messages array
  const userMessage = messages?.filter((m) => m.role === "user").pop() || null;

  let resolvedModel = null;

  try {
    // ── Validation ──────────────────────────────────────────────
    if (!providerName) {
      throw new ProviderError(
        "server",
        "Missing required field: provider",
        400,
      );
    }
    if (!messages || !Array.isArray(messages)) {
      throw new ProviderError(
        "server",
        "Missing or invalid field: messages (must be an array)",
        400,
      );
    }

    // ── Strip soft-deleted messages ──────────────────────────────
    // Deleted messages are kept in the DB for audit / undo, but must
    // not enter the LLM context window.
    const activeMessages = messages.filter((m) => !m.deleted);

    // ── Resolve image refs ─────────────────────────────────────
    // providerMessages has data URLs (for API calls)
    // messages is mutated to have minio refs (for conversation storage)
    const providerMessages = await resolveImageRefs(activeMessages, project, username);

    const provider = getProvider(providerName);

    // ── Resolve model and determine dispatch path ───────────────
    resolvedModel = requestedModel || getDefaultModels(TYPES.TEXT, TYPES.TEXT)[providerName];
    const modelDef = getModelByName(resolvedModel);

    // Determine what kind of generation to perform:
    //  1. imageAPI models (e.g. GPT Image 1.5) → provider.generateImage()
    //  2. Standard text/multimodal → provider.generateTextStream() or generateText()
    const isImageAPIModel = modelDef?.imageAPI && provider.generateImage;

    if (isImageAPIModel) {
      await handleImageAPIModel({
        provider,
        providerName,
        resolvedModel,
        modelDef,
        messages: providerMessages,
        options,
        conversationId,
        userMessage,
        conversationMeta,
        project,
        username,
        clientIp,
        requestId,
        requestStart,
        emit,
      });
      return;
    }

    // ── Standard text/multimodal streaming ───────────────────────
    if (!provider.generateTextStream && !provider.generateText) {
      throw new ProviderError(
        providerName,
        `Provider "${providerName}" does not support text generation`,
        400,
      );
    }

    // Prefer streaming; fall back to non-streaming
    if (provider.generateTextStream) {
      await handleStreamingText({
        provider,
        providerName,
        resolvedModel,
        modelDef,
        messages: providerMessages,
        options,
        conversationId,
        userMessage,
        conversationMeta,
        project,
        username,
        clientIp,
        requestId,
        requestStart,
        emit,
        signal,
      });
    } else {
      await handleNonStreamingText({
        provider,
        providerName,
        resolvedModel,
        messages: providerMessages,
        options,
        conversationId,
        userMessage,
        conversationMeta,
        project,
        username,
        clientIp,
        requestId,
        requestStart,
        emit,
      });
    }
  } catch (error) {
    // Clear generating flag on error
    if (conversationId) {
      ConversationService.setGenerating(conversationId, project, username, false)
        .catch((err) => logger.error(`Failed to clear isGenerating on error: ${err.message}`));
    }
    const totalSec = (performance.now() - requestStart) / 1000;
    RequestLogger.log({
      requestId,
      endpoint: "chat",
      project,
      username,
      clientIp,
      provider: providerName,
      model: resolvedModel,
      success: false,
      errorMessage: error.message,
      messageCount: messages ? messages.length : 0,
      totalTime: totalSec,
    });
    emit({ type: "error", message: error.message });
  }
}

// ============================================================
// Dispatch: Image API models (e.g. GPT Image 1.5, OpenAI images)
// ============================================================

async function handleImageAPIModel(ctx) {
  const {
    provider, providerName, resolvedModel, modelDef, messages, options,
    conversationId, userMessage, conversationMeta, project, username, clientIp,
    requestId, requestStart, emit,
  } = ctx;

  // Mark conversation as generating
  if (conversationId) {
    ConversationService.setGenerating(conversationId, project, username, true)
      .catch((err) => logger.error(`Failed to set isGenerating: ${err.message}`));
  }
  const lastUserMsg = messages.filter((m) => m.role === "user").pop();
  const prompt = lastUserMsg?.content || "";

  // Collect all images from the conversation
  const allImages = [];
  for (const msg of messages) {
    if (msg.images && msg.images.length > 0) {
      allImages.push(...msg.images);
    }
  }

  const result = await provider.generateImage(
    prompt,
    allImages,
    resolvedModel,
    options?.systemPrompt,
  );
  const totalSec = (performance.now() - requestStart) / 1000;

  // Cost calculation
  const imgPricing = getPricing(TYPES.TEXT, TYPES.IMAGE)[resolvedModel]
    || modelDef?.pricing;
  const outputImgTokens = providerName === "openai" ? 1056 : 258;
  const estimatedCost = calculateImageCost(
    prompt, imgPricing, allImages.length, outputImgTokens,
  );

  logger.request(
    project, username, clientIp,
    `[chat/image-api] ${providerName} ${resolvedModel} — ` +
    `total: ${totalSec.toFixed(2)}s` +
    (estimatedCost !== null ? `, cost: $${estimatedCost.toFixed(6)}` : ""),
  );

  // Upload generated image to MinIO
  let minioRef = null;
  if (result.imageData) {
    try {
      const mimeType = result.mimeType || "image/png";
      const dataUrl = `data:${mimeType};base64,${result.imageData}`;
      const { ref } = await FileService.uploadFile(
        dataUrl, "generations", project, username,
      );
      minioRef = ref;
    } catch (uploadErr) {
      logger.error(`[chat/image-api] MinIO upload failed: ${uploadErr.message}`);
    }
  }

  // Estimate token counts for tracking
  const estimatedInputTokens = Math.ceil(prompt.length / 4) +
    allImages.length * 258;

  RequestLogger.log({
    requestId,
    endpoint: "chat",
    project,
    username,
    clientIp,
    provider: providerName,
    model: resolvedModel,
    conversationId: conversationId || null,
    success: true,
    inputTokens: estimatedInputTokens,
    outputTokens: outputImgTokens,
    inputCharacters: prompt.length,
    outputCharacters: result.text ? result.text.length : 0,
    estimatedCost,
    totalTime: parseFloat(totalSec.toFixed(3)),
  });

  // Emit events
  if (result.text) {
    emit({ type: "chunk", content: result.text });
  }
  emit({
    type: "image",
    ...(minioRef ? {} : { data: result.imageData }),
    mimeType: result.mimeType || "image/png",
    minioRef,
  });
  emit({
    type: "done",
    usage: result.usage || null,
    estimatedCost,
    totalTime: totalSec,
  });

  // Auto-append to conversation
  if (conversationId) {
    const messagesToAppend = [];
    // Only append the user message on the first call for this turn
    // (indicated by conversationMeta). Follow-up tool iterations reuse
    // the same conversationId but omit conversationMeta, so the user
    // message is already persisted from the first call.
    if (userMessage && conversationMeta) {
      messagesToAppend.push({
        role: "user",
        ...userMessage,
        timestamp: userMessage.timestamp || new Date().toISOString(),
      });
    }

    const assistantImages = minioRef ? [minioRef] : [];
    messagesToAppend.push({
      role: "assistant",
      content: result.text || "",
      ...(assistantImages.length > 0 && { images: assistantImages }),
      model: resolvedModel,
      provider: providerName,
      timestamp: new Date().toISOString(),
      totalTime: parseFloat(totalSec.toFixed(3)),
      estimatedCost,
    });

    const meta = conversationMeta
      ? { ...conversationMeta, settings: { provider: providerName, model: resolvedModel } }
      : undefined;

    ConversationService.appendMessages(
      conversationId, project, username, messagesToAppend, meta,
    ).then(() =>
      ConversationService.setGenerating(conversationId, project, username, false),
    ).catch((err) =>
      logger.error(
        `Failed to append messages to conversation ${conversationId}: ${err.message}`,
      ),
    );
  }
}

// ============================================================
// Dispatch: Streaming text/multimodal generation
// ============================================================

async function handleStreamingText(ctx) {
  const {
    provider, providerName, resolvedModel, modelDef, messages, options,
    conversationId, userMessage, conversationMeta, project, username, clientIp,
    requestId, requestStart, emit, signal,
  } = ctx;

  // Mark conversation as generating
  if (conversationId) {
    ConversationService.setGenerating(conversationId, project, username, true)
      .catch((err) => logger.error(`Failed to set isGenerating: ${err.message}`));
  }

  const stream = modelDef?.liveAPI && provider.generateTextStreamLive
    ? provider.generateTextStreamLive(messages, resolvedModel, { ...options, signal })
    : provider.generateTextStream(messages, resolvedModel, { ...options, signal });
  let usage = null;
  let firstOutputTime = null;
  let firstTokenTime = null;
  let generationEnd = null;
  let outputCharacters = 0;
  let fullStreamedText = "";
  let streamedThinking = "";
  const streamedImages = [];
  const streamedToolCalls = [];
  /** @type {string[]} base64-encoded PCM audio chunks from Live API */
  const streamedAudioChunks = [];
  let audioSampleRate = 24000;

  for await (const chunk of stream) {
    // Client disconnected — abort the upstream provider stream
    if (signal?.aborted) {
      if (typeof stream.return === "function") stream.return();
      logger.info(`[chat] Client disconnected, aborting stream for ${providerName} ${resolvedModel}`);
      break;
    }
    // Usage object (final item from provider)
    if (chunk && typeof chunk === "object" && chunk.type === "usage") {
      usage = chunk.usage;
      continue;
    }
    // Thinking chunks
    if (chunk && typeof chunk === "object" && chunk.type === "thinking") {
      if (!firstOutputTime) firstOutputTime = performance.now();
      generationEnd = performance.now();
      streamedThinking += chunk.content;
      emit({ type: "thinking", content: chunk.content });
      continue;
    }
    // Image chunks from multimodal models
    if (chunk && typeof chunk === "object" && chunk.type === "image") {
      let minioRef = null;
      if (chunk.data) {
        // Upload to MinIO (same pattern as handleImageAPIModel)
        try {
          const mimeType = chunk.mimeType || "image/png";
          const dataUrl = `data:${mimeType};base64,${chunk.data}`;
          const { ref } = await FileService.uploadFile(
            dataUrl, "generations", project, username,
          );
          minioRef = ref;
        } catch (uploadErr) {
          logger.error(`[chat/stream] MinIO upload failed: ${uploadErr.message}`);
        }
        streamedImages.push(
          minioRef || `data:${chunk.mimeType || "image/png"};base64,${chunk.data}`,
        );
      }
      emit({
        type: "image",
        ...(minioRef ? {} : { data: chunk.data }),
        mimeType: chunk.mimeType,
        minioRef,
      });
      continue;
    }
    // Code execution chunks
    if (chunk && typeof chunk === "object" && chunk.type === "executableCode") {
      emit({
        type: "executableCode",
        code: chunk.code,
        language: chunk.language,
      });
      continue;
    }
    if (chunk && typeof chunk === "object" && chunk.type === "codeExecutionResult") {
      emit({
        type: "codeExecutionResult",
        output: chunk.output,
        outcome: chunk.outcome,
      });
      continue;
    }
    // Web search result chunks
    if (chunk && typeof chunk === "object" && chunk.type === "webSearchResult") {
      emit({ type: "webSearchResult", results: chunk.results });
      continue;
    }
    // Audio chunks (Live API — streamed PCM for client playback)
    if (chunk && typeof chunk === "object" && chunk.type === "audio") {
      emit({ type: "audio", data: chunk.data, mimeType: chunk.mimeType });
      // Accumulate for WAV building after streaming
      if (chunk.data) streamedAudioChunks.push(chunk.data);
      if (chunk.mimeType) {
        const rateMatch = chunk.mimeType.match(/rate=(\d+)/);
        if (rateMatch) audioSampleRate = parseInt(rateMatch[1], 10);
      }
      continue;
    }
    // Tool call chunks (custom function calling)
    if (chunk && typeof chunk === "object" && chunk.type === "toolCall") {
      streamedToolCalls.push({
        id: chunk.id || null,
        name: chunk.name,
        args: chunk.args || {},
        thoughtSignature: chunk.thoughtSignature || undefined,
      });
      emit({
        type: "toolCall",
        id: chunk.id || null,
        name: chunk.name,
        args: chunk.args || {},
        thoughtSignature: chunk.thoughtSignature || undefined,
      });
      continue;
    }
    // Status messages (e.g. "Loading model…")
    if (chunk && typeof chunk === "object" && chunk.type === "status") {
      emit({ type: "status", message: chunk.message });
      continue;
    }
    // Text chunk
    if (!firstOutputTime) firstOutputTime = performance.now();
    if (!firstTokenTime) {
      firstTokenTime = performance.now();
    }
    generationEnd = performance.now();
    const chunkStr = typeof chunk === "string" ? chunk : "";
    outputCharacters += chunkStr.length;
    fullStreamedText += chunkStr;
    emit({ type: "chunk", content: chunk });
  }

  // ── Timing ───────────────────────────────────────────────────
  const now = performance.now();
  const timeToGenerationSec = firstTokenTime
    ? (firstTokenTime - requestStart) / 1000
    : null;
  // Text-only generation time (from first text token to last)
  const generationSec =
    firstTokenTime && generationEnd
      ? (generationEnd - firstTokenTime) / 1000
      : null;
  const totalSec = (now - requestStart) / 1000;

  // ── Cost + logging ───────────────────────────────────────────
  let estimatedCost = null;
  let tokensPerSec = null;

  if (usage) {
    const imageCount = streamedImages.length;
    if (imageCount > 0) {
      const imgPricing = getPricing(TYPES.TEXT, TYPES.IMAGE)[resolvedModel]
        || modelDef?.pricing;
      if (imgPricing?.imageOutputPerMillion) {
        const imageTokens = imageCount * 258;
        const textOutputTokens = Math.max(0, usage.outputTokens - imageTokens);
        const inputCost = (usage.inputTokens / 1_000_000) * (imgPricing.inputPerMillion || 0);
        const textOutCost = (textOutputTokens / 1_000_000) * (imgPricing.outputPerMillion || 0);
        const imageOutCost = (imageTokens / 1_000_000) * imgPricing.imageOutputPerMillion;
        estimatedCost = parseFloat((inputCost + textOutCost + imageOutCost).toFixed(8));
      } else {
        const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
        estimatedCost = calculateTextCost(usage, pricing);
      }
    } else {
      const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
      estimatedCost = calculateTextCost(usage, pricing);
    }

    const effectiveGenSec = (generationSec && generationSec > 0.001)
      ? generationSec
      : totalSec;

    tokensPerSec = usage.tokensPerSec
      ? parseFloat(usage.tokensPerSec.toFixed(1))
      : effectiveGenSec > 0 && usage.outputTokens > 0
        ? parseFloat((usage.outputTokens / effectiveGenSec).toFixed(1))
        : null;

    // Cap at 10k tok/s — anything higher is a measurement artifact
    // (e.g. image gen where timing is unreliable)
    if (tokensPerSec !== null && tokensPerSec > 10000) {
      tokensPerSec = null;
    }
  }

  // ── Always log — even when usage is unavailable ─────────────
  const inputTokens = usage?.inputTokens || 0;
  const outputTokens = usage?.outputTokens || 0;
  const tokensPerSecStr = tokensPerSec !== null ? tokensPerSec.toFixed(1) : "N/A";

  logger.request(
    project, username, clientIp,
    `[chat] ${providerName} ${resolvedModel} — ` +
    `in: ${inputTokens} tokens, out: ${outputTokens} tokens, ` +
    `speed: ${tokensPerSecStr} tok/s, ` +
    `ttg: ${timeToGenerationSec !== null ? timeToGenerationSec.toFixed(2) + "s" : "N/A"}, ` +
    `generation: ${generationSec !== null ? generationSec.toFixed(2) + "s" : "N/A"}, ` +
    `total: ${totalSec.toFixed(2)}s` +
    (estimatedCost !== null ? `, cost: $${estimatedCost.toFixed(6)}` : ""),
  );

  RequestLogger.log({
    requestId,
    endpoint: "chat",
    project,
    username,
    clientIp,
    provider: providerName,
    model: resolvedModel,
    conversationId: conversationId || null,
    toolsUsed: streamedToolCalls.length > 0,
    success: true,
    inputTokens,
    outputTokens,
    estimatedCost,
    tokensPerSec,
    temperature: options?.temperature ?? null,
    maxTokens: options?.maxTokens ?? null,
    messageCount: messages.length,
    inputCharacters: messages.reduce(
      (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
      0,
    ),
    outputCharacters,
    timeToGeneration:
      timeToGenerationSec !== null
        ? parseFloat(timeToGenerationSec.toFixed(3))
        : null,
    generationTime:
      generationSec !== null
        ? parseFloat(generationSec.toFixed(3))
        : null,
    totalTime: parseFloat(totalSec.toFixed(3)),
  });

  // Build WAV from accumulated PCM audio chunks and upload to MinIO
  let audioRef = null;
  if (streamedAudioChunks.length > 0) {
    try {
      // Concatenate all base64 PCM chunks → single Buffer
      const pcmBuffers = streamedAudioChunks.map((b64) => Buffer.from(b64, "base64"));
      const pcmData = Buffer.concat(pcmBuffers);

      // Build WAV header (44 bytes)
      const numChannels = 1;
      const bitsPerSample = 16;
      const byteRate = audioSampleRate * numChannels * (bitsPerSample / 8);
      const blockAlign = numChannels * (bitsPerSample / 8);
      const wavHeader = Buffer.alloc(44);
      wavHeader.write("RIFF", 0);
      wavHeader.writeUInt32LE(36 + pcmData.length, 4);
      wavHeader.write("WAVE", 8);
      wavHeader.write("fmt ", 12);
      wavHeader.writeUInt32LE(16, 16); // PCM
      wavHeader.writeUInt16LE(1, 20);  // AudioFormat
      wavHeader.writeUInt16LE(numChannels, 22);
      wavHeader.writeUInt32LE(audioSampleRate, 24);
      wavHeader.writeUInt32LE(byteRate, 28);
      wavHeader.writeUInt16LE(blockAlign, 32);
      wavHeader.writeUInt16LE(bitsPerSample, 34);
      wavHeader.write("data", 36);
      wavHeader.writeUInt32LE(pcmData.length, 40);

      const wavBuffer = Buffer.concat([wavHeader, pcmData]);
      const dataUrl = `data:audio/wav;base64,${wavBuffer.toString("base64")}`;
      const { ref } = await FileService.uploadFile(dataUrl, "generations", project, username);
      audioRef = ref;
    } catch (err) {
      logger.error(`[chat] Failed to build/upload Live API audio WAV: ${err.message}`);
    }
  }

  // If client disconnected, skip the done emit but still persist partial content
  if (!signal?.aborted) {
    emit({
      type: "done",
      usage: usage || null,
      estimatedCost,
      tokensPerSec,
      ...(audioRef ? { audioRef } : {}),
      timeToGeneration:
        timeToGenerationSec !== null
          ? parseFloat(timeToGenerationSec.toFixed(3))
          : null,
      generationTime:
        generationSec !== null
          ? parseFloat(generationSec.toFixed(3))
          : null,
      totalTime: parseFloat(totalSec.toFixed(3)),
    });
  }

  // Auto-append to conversation (always, regardless of usage availability)
  if (conversationId) {
    const messagesToAppend = [];
    // Only append the user message on the first call for this turn
    // (indicated by conversationMeta). Follow-up tool iterations reuse
    // the same conversationId but omit conversationMeta, so the user
    // message is already persisted from the first call.
    if (userMessage && conversationMeta) {
      messagesToAppend.push({
        role: "user",
        ...userMessage,
        timestamp: userMessage.timestamp || new Date().toISOString(),
      });
    }
    messagesToAppend.push({
      role: "assistant",
      content: fullStreamedText,
      ...(streamedThinking && { thinking: streamedThinking }),
      ...(streamedImages.length > 0 && { images: streamedImages }),
      ...(audioRef && { audio: audioRef }),
      ...(streamedToolCalls.length > 0 && { toolCalls: streamedToolCalls }),
      model: resolvedModel,
      provider: providerName,
      timestamp: new Date().toISOString(),
      usage: usage || null,
      totalTime: parseFloat(totalSec.toFixed(3)),
      tokensPerSec,
      estimatedCost,
    });

    const meta = conversationMeta
      ? { ...conversationMeta, settings: { provider: providerName, model: resolvedModel } }
      : undefined;

    ConversationService.appendMessages(
      conversationId, project, username, messagesToAppend, meta,
    ).then(() =>
      ConversationService.setGenerating(conversationId, project, username, false),
    ).catch((err) =>
      logger.error(
        `Failed to append messages to conversation ${conversationId}: ${err.message}`,
      ),
    );
  }
}

// ============================================================
// Dispatch: Non-streaming text generation (fallback)
// ============================================================

async function handleNonStreamingText(ctx) {
  const {
    provider, providerName, resolvedModel, messages, options,
    conversationId, userMessage, conversationMeta, project, username, clientIp,
    requestId, requestStart, emit,
  } = ctx;

  // Mark conversation as generating
  if (conversationId) {
    ConversationService.setGenerating(conversationId, project, username, true)
      .catch((err) => logger.error(`Failed to set isGenerating: ${err.message}`));
  }

  const generationStart = performance.now();
  const result = await provider.generateText(messages, resolvedModel, options);
  const now = performance.now();
  const timeToGenerationSec = (generationStart - requestStart) / 1000;
  const generationSec = (now - generationStart) / 1000;
  const totalSec = (now - requestStart) / 1000;

  const usage = result.usage || { inputTokens: 0, outputTokens: 0 };
  const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
  const estimatedCost = calculateTextCost(usage, pricing);
  const tokensPerSec =
    generationSec > 0
      ? (usage.outputTokens / generationSec).toFixed(1)
      : "N/A";

  logger.request(
    project, username, clientIp,
    `[chat] ${providerName} ${resolvedModel} — ` +
    `in: ${usage.inputTokens} tokens, out: ${usage.outputTokens} tokens, ` +
    `speed: ${tokensPerSec} tok/s, ` +
    `ttg: ${timeToGenerationSec.toFixed(2)}s, ` +
    `generation: ${generationSec.toFixed(2)}s, ` +
    `total: ${totalSec.toFixed(2)}s` +
    (estimatedCost !== null ? `, cost: $${estimatedCost.toFixed(6)}` : ""),
  );

  RequestLogger.log({
    requestId,
    endpoint: "chat",
    project,
    username,
    clientIp,
    provider: providerName,
    model: resolvedModel,
    conversationId: conversationId || null,
    toolsUsed: !!(result.toolCalls && result.toolCalls.length > 0),
    success: true,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCost,
    tokensPerSec: parseFloat(tokensPerSec) || null,
    temperature: options?.temperature ?? null,
    maxTokens: options?.maxTokens ?? null,
    topP: options?.topP ?? null,
    topK: options?.topK ?? null,
    frequencyPenalty: options?.frequencyPenalty ?? null,
    presencePenalty: options?.presencePenalty ?? null,
    stopSequences: options?.stopSequences ?? null,
    messageCount: messages.length,
    inputCharacters: messages.reduce(
      (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
      0,
    ),
    outputCharacters: result.text ? result.text.length : 0,
    timeToGeneration: parseFloat(timeToGenerationSec.toFixed(3)),
    generationTime: parseFloat(generationSec.toFixed(3)),
    totalTime: parseFloat(totalSec.toFixed(3)),
  });

  // Emit the full text as a single chunk, then done
  if (result.text) {
    emit({ type: "chunk", content: result.text });
  }
  if (result.thinking) {
    emit({ type: "thinking", content: result.thinking });
  }
  // Forward tool calls (custom function calling)
  if (result.toolCalls && result.toolCalls.length > 0) {
    for (const tc of result.toolCalls) {
      emit({
        type: "toolCall",
        id: tc.id || null,
        name: tc.name,
        args: tc.args || {},
        thoughtSignature: tc.thoughtSignature || undefined,
      });
    }
  }
  emit({
    type: "done",
    provider: providerName,
    model: resolvedModel,
    usage,
    estimatedCost,
  });

  // Auto-append to conversation
  if (conversationId) {
    const messagesToAppend = [];
    // Only append the user message on the first call for this turn
    // (indicated by conversationMeta). Follow-up tool iterations reuse
    // the same conversationId but omit conversationMeta, so the user
    // message is already persisted from the first call.
    if (userMessage && conversationMeta) {
      messagesToAppend.push({
        role: "user",
        ...userMessage,
        timestamp: userMessage.timestamp || new Date().toISOString(),
      });
    }
    messagesToAppend.push({
      role: "assistant",
      content: result.text,
      thinking: result.thinking || undefined,
      ...(result.toolCalls?.length > 0 && { toolCalls: result.toolCalls }),
      model: resolvedModel,
      provider: providerName,
      timestamp: new Date().toISOString(),
      usage,
      totalTime: parseFloat(totalSec.toFixed(3)),
      estimatedCost,
    });

    const meta = conversationMeta
      ? { ...conversationMeta, settings: { provider: providerName, model: resolvedModel } }
      : undefined;

    ConversationService.appendMessages(
      conversationId, project, username, messagesToAppend, meta,
    ).then(() =>
      ConversationService.setGenerating(conversationId, project, username, false),
    ).catch((err) =>
      logger.error(
        `Failed to append messages to conversation ${conversationId}: ${err.message}`,
      ),
    );
  }
}

// ============================================================
// REST endpoint — SSE streaming or JSON fallback
// ============================================================

/**
 * POST /chat
 *
 * Default:       SSE streaming (text/event-stream)
 * ?stream=false: Plain JSON response (for server-to-server callers)
 *
 * Body (flat, OpenAI-style):
 *   { provider, model?, messages, tools?, temperature?, maxTokens?, ... }
 */
router.post("/", async (req, res, next) => {
  const wantsStream = req.query.stream !== "false";

  if (wantsStream) {
    // SSE streaming response
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Abort upstream provider when client disconnects (not on normal completion)
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    await handleChat(
      {
        ...req.body,
        project: req.project,
        username: req.username,
        clientIp: req.clientIp,
      },
      (event) => {
        if (!controller.signal.aborted) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      },
      { signal: controller.signal },
    );
    if (!controller.signal.aborted) res.end();
  } else {
    // Non-streaming JSON response (for lupos and other server callers)
    const events = [];
    await handleChat(
      {
        ...req.body,
        project: req.project,
        username: req.username,
        clientIp: req.clientIp,
      },
      (event) => events.push(event),
    );

    // Build a flat response from collected events
    const errorEvent = events.find((e) => e.type === "error");
    if (errorEvent) {
      return next(new ProviderError("server", errorEvent.message, 500));
    }

    const doneEvent = events.find((e) => e.type === "done") || {};
    const text = events
      .filter((e) => e.type === "chunk")
      .map((e) => e.content)
      .join("");
    const thinking = events
      .filter((e) => e.type === "thinking")
      .map((e) => e.content)
      .join("");
    const images = events
      .filter((e) => e.type === "image")
      .map((e) => ({
        data: e.data,
        mimeType: e.mimeType,
        minioRef: e.minioRef || null,
      }));

    res.json({
      text: text || null,
      thinking: thinking || null,
      images: images.length > 0 ? images : undefined,
      // provider/model echoed back — useful when Prism resolves a default model
      provider: doneEvent.provider || req.body.provider,
      model: doneEvent.model || req.body.model,
      usage: doneEvent.usage || null,
      estimatedCost: doneEvent.estimatedCost ?? null,
    });
  }
});

export default router;

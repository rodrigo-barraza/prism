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
  getTotalInputTokens,
} from "../utils/CostCalculator.js";
import logger from "../utils/logger.js";
import RequestLogger from "../services/RequestLogger.js";
import ConversationService from "../services/ConversationService.js";
import FileService from "../services/FileService.js";
import AgenticLoopService from "../services/AgenticLoopService.js";
import ToolOrchestratorService from "../services/ToolOrchestratorService.js";
import localModelQueue from "../services/LocalModelQueue.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";

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
        ref,
        "uploads",
        project,
        username,
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
        logger.warn(
          `[chat] Failed to fetch media URL (${response.status}): ${ref}`,
        );
        return { providerRef: ref, storageRef: ref };
      }
      const contentType =
        response.headers.get("content-type") || "application/octet-stream";
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
    conversationId: incomingConversationId,
    conversationMeta: incomingConversationMeta,
    sessionId: incomingSessionId,
    createSession: incomingCreateSession,
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
    functionCallingEnabled,
    enabledTools,
    forceImageGeneration,
    textOnly,
    skipConversation,
    // systemPrompt arrives in two places by design:
    //  - messages[0] with role:"system" → what the LLM actually sees
    //  - conversationMeta.systemPrompt → stored as top-level DB field for quick UI access
    // The top-level param is ignored; only the messages array matters for generation.
    systemPrompt: _unusedSystemPrompt,
    ...extraParams
  } = params;

  // ── Auto-conversation: every AI request gets tracked ────────────
  // If the caller didn't provide a conversationId, auto-generate one
  // so that all projects (Stickers, Lupos, etc.) get conversations
  // persisted without needing to explicitly manage IDs.
  // When skipConversation is set, skip all conversation persistence
  // (used by synthesis user-simulation turns that only need generation).
  let conversationId = skipConversation ? null : incomingConversationId;
  let conversationMeta = skipConversation ? null : incomingConversationMeta;
  if (!skipConversation && !conversationId) {
    conversationId = crypto.randomUUID();
    const firstUserMsg = messages?.filter((m) => m.role === "user").pop();
    const titleSnippet =
      (firstUserMsg?.content || "").slice(0, 100).trim() || "New Conversation";
    conversationMeta = conversationMeta || { title: titleSnippet };
  }

  // ── Session: create or reuse ────────────────────────────────
  // Pass createSession: true on the first call → Prism creates a
  // minimal session doc and returns the sessionId.
  // Subsequent calls pass the returned sessionId to join the session.
  // Sessions group conversations — skip creation when skipConversation
  // is set, since there will be no conversation to link.
  let sessionId = incomingSessionId || null;
  if (!skipConversation && !sessionId && incomingCreateSession) {
    sessionId = crypto.randomUUID();
    try {
      const sessionDb = MongoWrapper.getClient(MONGO_DB_NAME)?.db(MONGO_DB_NAME);
      if (sessionDb) {
        const now = new Date().toISOString();
        await sessionDb.collection("sessions").insertOne({
          id: sessionId,
          conversationIds: [],
          createdAt: now,
          updatedAt: now,
        });
      }
    } catch (err) {
      logger.error(`Failed to create session: ${err.message}`);
    }
  }

  // Inject sessionId into conversationMeta for storage on the conversation doc
  if (sessionId && conversationMeta) {
    conversationMeta.sessionId = sessionId;
  } else if (sessionId) {
    conversationMeta = { sessionId };
  }

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
    ...(functionCallingEnabled !== undefined && { functionCallingEnabled }),
    ...(enabledTools && { enabledTools }),
    ...(forceImageGeneration && { forceImageGeneration }),
    ...(textOnly && { textOnly }),
    ...(extraParams.systemPrompt && { systemPrompt: extraParams.systemPrompt }),
  };

  // When thinking is explicitly disabled, strip all thinking sub-params
  // so providers don't inadvertently enable thinking by detecting them.
  if (thinkingEnabled === false) {
    delete options.reasoningEffort;
    delete options.thinkingLevel;
    delete options.thinkingBudget;
  }

  // LM Studio models emit thinking tokens by default. Default thinkingEnabled
  // ON only when the client didn't send a value (undefined). When the client
  // explicitly sends false (thinking toggle off), respect it — models can
  // use tools without thinking.
  if (providerName === "lm-studio" && thinkingEnabled === undefined) {
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
    const providerMessages = await resolveImageRefs(
      activeMessages,
      project,
      username,
    );

    const provider = getProvider(providerName);

    // ── Resolve model and determine dispatch path ───────────────
    resolvedModel =
      requestedModel || getDefaultModels(TYPES.TEXT, TYPES.TEXT)[providerName];
    const modelDef = getModelByName(resolvedModel);

    // Determine what kind of generation to perform:
    //  1. imageAPI models (e.g. GPT Image 1.5) → provider.generateImage()
    //  2. Standard text/multimodal → provider.generateTextStream() or generateText()
    const isImageAPIModel = modelDef?.imageAPI && provider.generateImage;

    // ── Local GPU mutex: serialize local model requests ─────────
    // Acquire the process-level lock if this is a local provider so
    // concurrent chat + benchmark requests don't collide on the GPU.
    let localRelease;
    if (localModelQueue.isLocal(providerName)) {
      localRelease = await localModelQueue.acquire();
      logger.info(
        `[chat] 🔒 Acquired local GPU lock for ${resolvedModel}` +
        (localModelQueue.pending > 0 ? ` (${localModelQueue.pending} queued)` : ""),
      );
    }

    try {
      if (isImageAPIModel) {
        await handleImageAPIModel({
          provider,
          providerName,
          resolvedModel,
          modelDef,
          messages: providerMessages,
          originalMessages: activeMessages,
          options,
          conversationId,
          userMessage,
          conversationMeta,
          sessionId,
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

      // Prefer streaming; fall back to non-streaming.
      // Models with streaming: false (e.g. Gemini image models) should use
      // non-streaming generateText to get a clean single-response result.
      const useStreaming =
        provider.generateTextStream &&
        modelDef?.streaming !== false;

      if (useStreaming) {
        // LM Studio's native API handles tool calling via MCP internally —
        // no need for Prism's AgenticLoopService. Tool events are part of
        // the SSE stream and get forwarded directly to the client.
        const useLmStudioNativeMcp = providerName === "lm-studio";

        // For LM Studio MCP: populate options.tools with the allowed tool names
        // so the provider can pass them as `allowed_tools` in the MCP integration.
        // The MCP server discovers full schemas — Prism only supplies the filter list.
        if (useLmStudioNativeMcp && options.functionCallingEnabled) {
          const builtInTools = ToolOrchestratorService.getToolSchemas();
          let tools = builtInTools;
          if (options.enabledTools && Array.isArray(options.enabledTools)) {
            const enabledSet = new Set(options.enabledTools);
            tools = tools.filter((t) => enabledSet.has(t.name));
          }
          options.tools = tools;
          // Pass model context for provider-side tool cap
          if (modelDef?.contextLength) {
            options.contextLength = modelDef.contextLength;
          }
        }

        if (options.functionCallingEnabled && !useLmStudioNativeMcp) {
          await AgenticLoopService.runAgenticLoop({
            provider,
            providerName,
            resolvedModel,
            modelDef,
            messages: providerMessages,
            originalMessages: activeMessages,
            options,
            conversationId,
            userMessage,
            conversationMeta,
            sessionId,
            project,
            username,
            clientIp,
            requestId,
            requestStart,
            emit,
            signal,
          });
        } else {
          await handleStreamingText({
            provider,
            providerName,
            resolvedModel,
            modelDef,
            messages: providerMessages,
            originalMessages: activeMessages,
            options,
            conversationId,
            userMessage,
            conversationMeta,
            sessionId,
            project,
            username,
            clientIp,
            requestId,
            requestStart,
            emit,
            signal,
          });
        }
      } else {
        await handleNonStreamingText({
          provider,
          providerName,
          resolvedModel,
          modelDef,
          messages: providerMessages,
          originalMessages: activeMessages,
          options,
          conversationId,
          userMessage,
          conversationMeta,
          sessionId,
          project,
          username,
          clientIp,
          requestId,
          requestStart,
          emit,
        });
      }
    } finally {
      if (localRelease) {
        localRelease();
        logger.info(`[chat] 🔓 Released local GPU lock for ${resolvedModel}`);
      }
    }
  } catch (error) {
    // Clear generating flag on error
    if (conversationId) {
      ConversationService.setGenerating(
        conversationId,
        project,
        username,
        false,
      ).catch((err) =>
        logger.error(`Failed to clear isGenerating on error: ${err.message}`),
      );
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
    provider,
    providerName,
    resolvedModel,
    modelDef,
    messages,
    options,
    conversationId,
    userMessage,
    conversationMeta,
    sessionId,
    project,
    username,
    clientIp,
    requestId,
    requestStart,
    emit,
  } = ctx;

  // Mark conversation as generating
  if (conversationId) {
    ConversationService.setGenerating(
      conversationId,
      project,
      username,
      true,
    ).catch((err) =>
      logger.error(`Failed to set isGenerating: ${err.message}`),
    );
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
  const imgPricing =
    getPricing(TYPES.TEXT, TYPES.IMAGE)[resolvedModel] || modelDef?.pricing;
  const outputImgTokens = modelDef?.imageTokensPerImage || (providerName === "openai" ? 1056 : 1120);
  const estimatedCost = calculateImageCost(
    prompt,
    imgPricing,
    allImages.length,
    outputImgTokens,
  );

  logger.request(
    project,
    username,
    clientIp,
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
        dataUrl,
        "generations",
        project,
        username,
      );
      minioRef = ref;
    } catch (uploadErr) {
      logger.error(
        `[chat/image-api] MinIO upload failed: ${uploadErr.message}`,
      );
    }
  }

  // Estimate token counts for tracking
  const estimatedInputTokens =
    Math.ceil(prompt.length / 4) + allImages.length * (modelDef?.imageTokensPerImage || 1120);

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
    data: result.imageData,
    mimeType: result.mimeType || "image/png",
    minioRef,
  });
  emit({
    type: "done",
    usage: result.usage || null,
    estimatedCost,
    totalTime: totalSec,
    ...(sessionId && { sessionId }),
    ...(conversationId && { conversationId }),
  });

  // Link conversation to session
  if (sessionId && conversationId) {
    try {
      const sessionDb = MongoWrapper.getClient(MONGO_DB_NAME)?.db(MONGO_DB_NAME);
      if (sessionDb) {
        sessionDb.collection("sessions").updateOne(
          { id: sessionId },
          {
            $addToSet: { conversationIds: conversationId },
            $set: { updatedAt: new Date().toISOString() },
          },
        ).catch((err) =>
          logger.error(`Failed to link conversation to session: ${err.message}`),
        );
      }
    } catch (err) {
      logger.error(`Failed to link conversation to session: ${err.message}`);
    }
  }

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
      ? {
          ...conversationMeta,
          settings: { provider: providerName, model: resolvedModel },
        }
      : undefined;

    ConversationService.appendMessages(
      conversationId,
      project,
      username,
      messagesToAppend,
      meta,
    )
      .then(() =>
        ConversationService.setGenerating(
          conversationId,
          project,
          username,
          false,
        ),
      )
      .catch((err) =>
        logger.error(
          `Failed to append messages to conversation ${conversationId}: ${err.message}`,
        ),
      );
  }
}

// ============================================================
// Shared: Post-generation finalization
// ── cost, logging, payloads, WAV, done event, persistence ──
// ============================================================

export async function finalizeTextGeneration(
  ctx,
  {
    text,
    thinking,
    images,
    toolCalls,
    audioChunks,
    audioSampleRate,
    usage,
    outputCharacters,
    timeToGenerationSec,
    generationSec,
    totalSec,
  },
  overrideMessagesToAppend = null,
  skipRequestLog = false
) {
  const {
    providerName,
    resolvedModel,
    modelDef,
    messages,
    originalMessages,
    options,
    conversationId,
    userMessage,
    conversationMeta,
    sessionId,
    project,
    username,
    clientIp,
    requestId,
    emit,
    signal,
  } = ctx;

  // ── Cost calculation ──────────────────────────────────────────
  let estimatedCost = null;
  let tokensPerSec = null;

  if (usage) {
    const imageCount = images.length;
    if (imageCount > 0) {
      const imgPricing =
        getPricing(TYPES.TEXT, TYPES.IMAGE)[resolvedModel] || modelDef?.pricing;
      if (imgPricing?.imageOutputPerMillion) {
        // Derive image tokens dynamically from the API-reported total.
        // The API's outputTokens already includes both text and image tokens,
        // so we estimate text tokens from the generated text length (~4 chars/token)
        // and attribute the remainder to images. This adapts to any resolution
        // (512px≈747tok, 1024px≈1120tok, 2048px≈1680tok, 4096px≈2520tok).
        const estimatedTextOutputTokens = Math.ceil((text?.length || 0) / 4);
        const imageTokens = Math.max(0, usage.outputTokens - estimatedTextOutputTokens);
        const textOutputTokens = Math.max(0, usage.outputTokens - imageTokens);
        const inputCost =
          (usage.inputTokens / 1_000_000) * (imgPricing.inputPerMillion || 0);
        const textOutCost =
          (textOutputTokens / 1_000_000) * (imgPricing.outputPerMillion || 0);
        const imageOutCost =
          (imageTokens / 1_000_000) * imgPricing.imageOutputPerMillion;
        estimatedCost = parseFloat(
          (inputCost + textOutCost + imageOutCost).toFixed(8),
        );
      } else {
        const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
        estimatedCost = calculateTextCost(usage, pricing);
      }
    } else {
      const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
      estimatedCost = calculateTextCost(usage, pricing);
    }

    const effectiveGenSec =
      generationSec && generationSec > 0.001 ? generationSec : totalSec;

    tokensPerSec = usage.tokensPerSec
      ? parseFloat(usage.tokensPerSec.toFixed(1))
      : effectiveGenSec > 0 && usage.outputTokens > 0
        ? parseFloat((usage.outputTokens / effectiveGenSec).toFixed(1))
        : null;

    // Cap at 10k tok/s — anything higher is a measurement artifact
    if (tokensPerSec !== null && tokensPerSec > 10000) {
      tokensPerSec = null;
    }
  }

  // ── Console logging ───────────────────────────────────────────
  const inputTokens = getTotalInputTokens(usage);
  const outputTokens = usage?.outputTokens || 0;
  const tokensPerSecStr =
    tokensPerSec !== null ? tokensPerSec.toFixed(1) : "N/A";
  const cacheInfo =
    usage?.cacheReadInputTokens || usage?.cacheCreationInputTokens
      ? `, cache_read: ${usage.cacheReadInputTokens || 0}, cache_write: ${usage.cacheCreationInputTokens || 0}`
      : "";

  logger.request(
    project,
    username,
    clientIp,
    `[chat] ${providerName} ${resolvedModel} — ` +
      `in: ${inputTokens} tokens, out: ${outputTokens} tokens${cacheInfo}, ` +
      `speed: ${tokensPerSecStr} tok/s, ` +
      `ttg: ${timeToGenerationSec !== null ? timeToGenerationSec.toFixed(2) + "s" : "N/A"}, ` +
      `generation: ${generationSec !== null ? generationSec.toFixed(2) + "s" : "N/A"}, ` +
      `total: ${totalSec.toFixed(2)}s` +
      (estimatedCost !== null ? `, cost: $${estimatedCost.toFixed(6)}` : ""),
  );

  // ── Build WAV from accumulated PCM audio chunks ───────────────
  let audioRef = null;
  if (audioChunks.length > 0) {
    try {
      const pcmBuffers = audioChunks.map((b64) =>
        Buffer.from(b64, "base64"),
      );
      const pcmData = Buffer.concat(pcmBuffers);

      const numChannels = 1;
      const bitsPerSample = 16;
      const byteRate = audioSampleRate * numChannels * (bitsPerSample / 8);
      const blockAlign = numChannels * (bitsPerSample / 8);
      const wavHeader = Buffer.alloc(44);
      wavHeader.write("RIFF", 0);
      wavHeader.writeUInt32LE(36 + pcmData.length, 4);
      wavHeader.write("WAVE", 8);
      wavHeader.write("fmt ", 12);
      wavHeader.writeUInt32LE(16, 16);
      wavHeader.writeUInt16LE(1, 20);
      wavHeader.writeUInt16LE(numChannels, 22);
      wavHeader.writeUInt32LE(audioSampleRate, 24);
      wavHeader.writeUInt32LE(byteRate, 28);
      wavHeader.writeUInt16LE(blockAlign, 32);
      wavHeader.writeUInt16LE(bitsPerSample, 34);
      wavHeader.write("data", 36);
      wavHeader.writeUInt32LE(pcmData.length, 40);

      const wavBuffer = Buffer.concat([wavHeader, pcmData]);
      const dataUrl = `data:audio/wav;base64,${wavBuffer.toString("base64")}`;
      const { ref } = await FileService.uploadFile(
        dataUrl,
        "generations",
        project,
        username,
      );
      audioRef = ref;
    } catch (err) {
      logger.error(
        `[chat] Failed to build/upload Live API audio WAV: ${err.message}`,
      );
    }
  }

  // ── Request logging with sanitized payloads ────────────────────
  // Placed after audio build so audioRef is available for modality detection
  if (!skipRequestLog) {
    RequestLogger.logChatGeneration({
      requestId,
      endpoint: modelDef?.liveAPI ? "live" : "chat",
      project,
      username,
      clientIp,
      provider: providerName,
      model: resolvedModel,
      conversationId: conversationId || null,
      success: true,
      usage,
      estimatedCost,
      tokensPerSec,
      timeToGenerationSec,
      generationSec,
      totalSec,
      options,
      messages: originalMessages || messages,
      text,
      thinking,
      images,
      toolCalls,
      outputCharacters,
      audioRef,
    });
  }

  // ── Emit done event ───────────────────────────────────────────
  if (!signal?.aborted) {
    emit({
      type: "done",
      provider: providerName,
      model: resolvedModel,
      usage: usage || null,
      estimatedCost,
      tokensPerSec,
      ...(audioRef ? { audioRef } : {}),
      timeToGeneration:
        timeToGenerationSec !== null
          ? parseFloat(timeToGenerationSec.toFixed(3))
          : null,
      generationTime:
        generationSec !== null ? parseFloat(generationSec.toFixed(3)) : null,
      totalTime: parseFloat(totalSec.toFixed(3)),
      ...(sessionId && { sessionId }),
      ...(conversationId && { conversationId }),
    });
  }

  // ── Link conversation to session ──────────────────────────────
  if (sessionId && conversationId) {
    try {
      const sessionDb = MongoWrapper.getClient(MONGO_DB_NAME)?.db(MONGO_DB_NAME);
      if (sessionDb) {
        sessionDb.collection("sessions").updateOne(
          { id: sessionId },
          {
            $addToSet: { conversationIds: conversationId },
            $set: { updatedAt: new Date().toISOString() },
          },
        ).catch((err) =>
          logger.error(`Failed to link conversation to session: ${err.message}`),
        );
      }
    } catch (err) {
      logger.error(`Failed to link conversation to session: ${err.message}`);
    }
  }

  // ── Conversation persistence ──────────────────────────────────
  if (conversationId) {
    let messagesToAppend = [];
    if (overrideMessagesToAppend) {
      messagesToAppend = [...overrideMessagesToAppend];
      // Append the final LLM response block (contains telemetry and final text step)
      messagesToAppend.push({
        role: "assistant",
        content: text,
        ...(thinking && { thinking }),
        ...(images.length > 0 && { images }),
        ...(audioRef && { audio: audioRef }),
        // We do not append toolCalls here because overrideMessagesToAppend handles intermediate tool iterations
        model: resolvedModel,
        provider: providerName,
        timestamp: new Date().toISOString(),
        usage: usage || null,
        totalTime: parseFloat(totalSec.toFixed(3)),
        tokensPerSec,
        estimatedCost,
      });
    } else {
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
        content: text,
        ...(thinking && { thinking }),
        ...(images.length > 0 && { images }),
        ...(audioRef && { audio: audioRef }),
        ...(toolCalls.length > 0 && { toolCalls }),
        model: resolvedModel,
        provider: providerName,
        timestamp: new Date().toISOString(),
        usage: usage || null,
        totalTime: parseFloat(totalSec.toFixed(3)),
        tokensPerSec,
        estimatedCost,
      });
    }

    const meta = conversationMeta
      ? {
          ...conversationMeta,
          settings: { provider: providerName, model: resolvedModel },
        }
      : undefined;

    ConversationService.appendMessages(
      conversationId,
      project,
      username,
      messagesToAppend,
      meta,
    )
      .then(() =>
        ConversationService.setGenerating(
          conversationId,
          project,
          username,
          false,
        ),
      )
      .catch((err) =>
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
    provider,
    providerName,
    resolvedModel,
    modelDef,
    messages,
    options,
    conversationId,
    project,
    username,
    requestStart,
    emit,
    signal,
  } = ctx;

  // Mark conversation as generating
  if (conversationId) {
    ConversationService.setGenerating(
      conversationId,
      project,
      username,
      true,
    ).catch((err) =>
      logger.error(`Failed to set isGenerating: ${err.message}`),
    );
  }

  const stream =
    modelDef?.liveAPI && provider.generateTextStreamLive
      ? provider.generateTextStreamLive(messages, resolvedModel, {
          ...options,
          signal,
        })
      : provider.generateTextStream(messages, resolvedModel, {
          ...options,
          signal,
        });

  let usage = null;
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
      logger.info(
        `[chat] Client disconnected, aborting stream for ${providerName} ${resolvedModel}`,
      );
      break;
    }
    // Usage object (final item from provider)
    if (chunk && typeof chunk === "object" && chunk.type === "usage") {
      usage = chunk.usage;
      continue;
    }
    // Thinking chunks
    if (chunk && typeof chunk === "object" && chunk.type === "thinking") {
      generationEnd = performance.now();
      streamedThinking += chunk.content;
      emit({ type: "thinking", content: chunk.content });
      continue;
    }
    // Image chunks from multimodal models
    if (chunk && typeof chunk === "object" && chunk.type === "image") {
      let minioRef = null;
      if (chunk.data) {
        try {
          const mimeType = chunk.mimeType || "image/png";
          const dataUrl = `data:${mimeType};base64,${chunk.data}`;
          const { ref } = await FileService.uploadFile(
            dataUrl,
            "generations",
            project,
            username,
          );
          minioRef = ref;
        } catch (uploadErr) {
          logger.error(
            `[chat/stream] MinIO upload failed: ${uploadErr.message}`,
          );
        }
        streamedImages.push(
          minioRef ||
            `data:${chunk.mimeType || "image/png"};base64,${chunk.data}`,
        );
      }
      emit({
        type: "image",
        data: chunk.data,
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
    if (
      chunk &&
      typeof chunk === "object" &&
      chunk.type === "codeExecutionResult"
    ) {
      emit({
        type: "codeExecutionResult",
        output: chunk.output,
        outcome: chunk.outcome,
      });
      continue;
    }
    // Web search result chunks
    if (
      chunk &&
      typeof chunk === "object" &&
      chunk.type === "webSearchResult"
    ) {
      emit({ type: "webSearchResult", results: chunk.results });
      continue;
    }
    // Audio chunks (Live API — streamed PCM for client playback)
    if (chunk && typeof chunk === "object" && chunk.type === "audio") {
      emit({ type: "audio", data: chunk.data, mimeType: chunk.mimeType });
      if (chunk.data) streamedAudioChunks.push(chunk.data);
      if (chunk.mimeType) {
        const rateMatch = chunk.mimeType.match(/rate=(\d+)/);
        if (rateMatch) audioSampleRate = parseInt(rateMatch[1], 10);
      }
      continue;
    }
    // Tool call chunks (custom function calling or MCP native tool events)
    if (chunk && typeof chunk === "object" && chunk.type === "toolCall") {
      if (chunk.status === "done" || chunk.status === "error") {
        // Update existing entry with result (don't create a new one)
        const existing = streamedToolCalls.find(
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
        // New tool call (status: "calling")
        streamedToolCalls.push({
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
      continue;
    }
    // Status messages (e.g. "Loading model…")
    if (chunk && typeof chunk === "object" && chunk.type === "status") {
      emit({ type: "status", message: chunk.message });
      continue;
    }
    // Text chunk
    if (!firstTokenTime) {
      firstTokenTime = performance.now();
    }
    generationEnd = performance.now();
    const chunkStr = typeof chunk === "string" ? chunk : "";
    outputCharacters += chunkStr.length;
    fullStreamedText += chunkStr;
    emit({ type: "chunk", content: chunk });
  }

  // Build normalized result for shared finalization
  const now = performance.now();
  await finalizeTextGeneration(ctx, {
    text: fullStreamedText,
    thinking: streamedThinking,
    images: streamedImages,
    toolCalls: streamedToolCalls,
    audioChunks: streamedAudioChunks,
    audioSampleRate,
    usage,
    outputCharacters,
    timeToGenerationSec: firstTokenTime
      ? (firstTokenTime - requestStart) / 1000
      : null,
    generationSec:
      firstTokenTime && generationEnd
        ? (generationEnd - firstTokenTime) / 1000
        : null,
    totalSec: (now - requestStart) / 1000,
  });
}

// ============================================================
// Dispatch: Non-streaming text generation (fallback)
// ============================================================

async function handleNonStreamingText(ctx) {
  const {
    provider,
    resolvedModel,
    messages,
    options,
    conversationId,
    project,
    username,
    requestStart,
    emit,
  } = ctx;

  // Mark conversation as generating
  if (conversationId) {
    ConversationService.setGenerating(
      conversationId,
      project,
      username,
      true,
    ).catch((err) =>
      logger.error(`Failed to set isGenerating: ${err.message}`),
    );
  }

  const generationStart = performance.now();
  const genResult = await provider.generateText(
    messages,
    resolvedModel,
    options,
  );
  const now = performance.now();

  // Emit chunk/thinking/toolCall events before finalization
  if (genResult.text) {
    emit({ type: "chunk", content: genResult.text });
  }
  if (genResult.thinking) {
    emit({ type: "thinking", content: genResult.thinking });
  }
  if (genResult.toolCalls && genResult.toolCalls.length > 0) {
    for (const tc of genResult.toolCalls) {
      emit({
        type: "toolCall",
        id: tc.id || null,
        name: tc.name,
        args: tc.args || {},
        thoughtSignature: tc.thoughtSignature || undefined,
      });
    }
  }

  // Handle images from the generation result (e.g. Gemini image models)
  const images = [];
  if (genResult.images && genResult.images.length > 0) {
    for (const img of genResult.images) {
      let minioRef = null;
      if (img.data) {
        try {
          const mimeType = img.mimeType || "image/png";
          const dataUrl = `data:${mimeType};base64,${img.data}`;
          const { ref } = await FileService.uploadFile(
            dataUrl,
            "generations",
            project,
            username,
          );
          minioRef = ref;
        } catch (uploadErr) {
          logger.error(
            `[chat/non-stream] MinIO upload failed: ${uploadErr.message}`,
          );
        }
        images.push(
          minioRef ||
            `data:${img.mimeType || "image/png"};base64,${img.data}`,
        );
      }
      emit({
        type: "image",
        data: img.data,
        mimeType: img.mimeType,
        minioRef,
      });
    }
  }

  // Build normalized result for shared finalization
  await finalizeTextGeneration(ctx, {
    text: genResult.text || "",
    thinking: genResult.thinking || "",
    images,
    toolCalls:
      genResult.toolCalls?.map((tc) => ({
        id: tc.id || null,
        name: tc.name,
        args: tc.args || {},
        thoughtSignature: tc.thoughtSignature || undefined,
      })) || [],
    audioChunks: [],
    audioSampleRate: 24000,
    usage: genResult.usage || { inputTokens: 0, outputTokens: 0 },
    outputCharacters: genResult.text ? genResult.text.length : 0,
    timeToGenerationSec: (generationStart - requestStart) / 1000,
    generationSec: (now - generationStart) / 1000,
    totalSec: (now - requestStart) / 1000,
  });
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
          // Strip heavy base64 data from image events when minioRef is
          // available — SSE/browser clients load images via the ref URL.
          if (event.type === "image" && event.minioRef && event.data) {
            const { data: _stripped, ...lightweight } = event;
            res.write(`data: ${JSON.stringify(lightweight)}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
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

    const toolCalls = events
      .filter((e) => e.type === "tool_execution" && e.status === "calling")
      .map((e) => ({
        name: e.tool?.name,
        args: e.tool?.args,
      }));

    res.json({
      text: text || null,
      thinking: thinking || null,
      images: images.length > 0 ? images : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      // provider/model echoed back — useful when Prism resolves a default model
      provider: doneEvent.provider || req.body.provider,
      model: doneEvent.model || req.body.model,
      usage: doneEvent.usage || null,
      estimatedCost: doneEvent.estimatedCost ?? null,
      ...(doneEvent.sessionId && { sessionId: doneEvent.sessionId }),
      ...(doneEvent.conversationId && { conversationId: doneEvent.conversationId }),
    });
  }
});

export default router;

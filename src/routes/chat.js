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
  estimateTokens,
  calculateTextCost,
  calculateImageCost,
  getTotalInputTokens,
} from "../utils/CostCalculator.js";
import logger from "../utils/logger.js";
import RequestLogger from "../services/RequestLogger.js";
import FileService from "../services/FileService.js";
import { createStreamState, dispatchChunk } from "../utils/StreamChunkDispatcher.js";
import { calculateTokensPerSec } from "../utils/math.js";
import { compressImageForSizeLimit } from "../utils/media.js";
import { formatCostTag } from "../utils/utilities.js";

import ToolOrchestratorService from "../services/ToolOrchestratorService.js";
import localModelQueue from "../services/LocalModelQueue.js";

import {
  markGenerating,
  appendAndFinalize,
} from "../utils/ConversationUtilities.js";
import {
  handleSseRequest,
  handleJsonRequest,
} from "../utils/SseUtilities.js";

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
 * Compress an oversized image data URL in-place.
 * Parses the data URL, checks decoded size, runs through compressImageForSizeLimit,
 * and reconstructs if compression changed the data.
 * @param {string} dataUrl - Full data URL (data:<mime>;base64,<data>)
 * @returns {Promise<string>} - Possibly compressed data URL
 */
async function compressDataUrlIfOversized(dataUrl) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return dataUrl;

  const mimeType = match[1];
  if (!mimeType.startsWith("image/")) return dataUrl;

  const base64Data = match[2];
  const b64Len = base64Data.length; // Anthropic checks base64 STRING length
  const MAX = 5 * 1024 * 1024;

  if (b64Len <= MAX) return dataUrl;

  logger.info(
    `[chat] Oversized image detected: ${(b64Len / 1024 / 1024).toFixed(2)} MB b64 (${mimeType}). Compressing...`,
  );

  try {
    const result = await compressImageForSizeLimit(base64Data, mimeType);
    const newUrl = `data:${result.mediaType};base64,${result.data}`;
    const newLen = result.data.length;
    logger.info(
      `[chat] Compressed: ${(b64Len / 1024 / 1024).toFixed(2)} MB → ${(newLen / 1024 / 1024).toFixed(2)} MB b64 (${result.mediaType})`,
    );
    return newUrl;
  } catch (err) {
    logger.error(`[chat] Image compression failed: ${err.message}. Sending original.`);
    return dataUrl;
  }
}

/**
 * Resolve a single media reference for both provider and storage use.
 * @returns {{ providerRef: string, storageRef: string }}
 */
async function resolveMediaRef(ref, project, username) {
  // Already a base64 data URL — compress if oversized, upload to MinIO for storage
  if (ref.startsWith("data:")) {
    let providerRef = ref;
    // Compress oversized images before they reach any provider
    providerRef = await compressDataUrlIfOversized(providerRef);
    let storageRef = providerRef;
    try {
      const { ref: minioRef } = await FileService.uploadFile(
        ref, // Upload original to MinIO
        "uploads",
        project,
        username,
      );
      storageRef = minioRef;
    } catch (err) {
      logger.error(`[chat] Failed to upload media to MinIO: ${err.message}`);
    }
    return { providerRef, storageRef };
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
      let providerRef = `data:${contentType};base64,${base64}`;
      // Compress oversized images before they reach any provider
      providerRef = await compressDataUrlIfOversized(providerRef);
      return {
        providerRef,
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
    project = "unknown",
    username = "unknown",
    clientIp = null,
    agent = null,
    // Generation options — flat at top-level (OpenAI-style)
    tools,
    temperature,
    maxTokens,
    topP,
    topK,
    frequencyPenalty,
    presencePenalty,
    stopSequences,
    seed,
    minP,
    repeatPenalty,
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
    agenticLoopEnabled,
    enabledTools,
    minContextLength,
    forceImageGeneration,
    responseFormat,
    serviceTier,
    textOnly,
    skipConversation,
    autoApprove,
    planFirst,
    maxIterations,
    agentContext,
    // customSystemPrompt is deprecated — the assembler always runs and
    // loads the correct persona via AgentPersonaRegistry. Kept here to
    // avoid breaking old callers silently; the value is simply ignored.
    customSystemPrompt: _deprecatedCustomSystemPrompt,
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

  // ── Session: passthrough ────────────────────────────────────
  // SessionId is generated client-side and passed on every request.
  // Sessions are derived views over requests — no separate collection.
  const sessionId = incomingSessionId || null;

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
    ...(seed !== undefined && seed !== "" && { seed }),
    ...(minP !== undefined && { minP }),
    ...(repeatPenalty !== undefined && { repeatPenalty }),
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
    ...(agenticLoopEnabled !== undefined && { agenticLoopEnabled }),
    ...(enabledTools && { enabledTools }),
    ...(minContextLength && { minContextLength }),
    ...(forceImageGeneration && { forceImageGeneration }),
    ...(responseFormat && { responseFormat }),
    ...(serviceTier && { serviceTier }),
    ...(textOnly && { textOnly }),
    ...(autoApprove && { autoApprove }),
    ...(planFirst && { planFirst }),
    ...(maxIterations !== undefined && { maxIterations }),
    ...(agentContext && { agentContext }),
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
        // LM Studio supports both native MCP (tool calling handled server-side)
        // and standard function calling (tool calling managed by Prism).
        // When agenticLoopEnabled is true (Agent tab), we ALWAYS use Prism's
        // AgenticLoopService so local models get iteration tracking, context
        // management, approval gating, planning mode, and memory extraction.
        // Native MCP is only used for the Chat tab where Prism doesn't
        // manage the tool loop.
        const useLmStudioNativeMcp = providerName === "lm-studio" && !options.agenticLoopEnabled;

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
          logger.info(`[chat] LM-Studio MCP: ${tools.length} tools enabled, enabledTools=${(options.enabledTools || []).length}, builtIn=${builtInTools.length}, contextLength=${options.contextLength || 'unset'}`);
        } else if (useLmStudioNativeMcp) {
          logger.warn(`[chat] LM-Studio MCP SKIPPED: functionCallingEnabled=${options.functionCallingEnabled}, useLmStudioNativeMcp=${useLmStudioNativeMcp}`);
        }

        // For non-LM-Studio providers on the /chat path: load tool schemas
        // from ToolOrchestratorService so the provider receives proper function
        // definitions. Without this, the LLM only sees tool names in the system
        // prompt and hallucinates XML tool calls instead of structured ones.
        if (!useLmStudioNativeMcp && !options.agenticLoopEnabled && options.functionCallingEnabled) {
          const builtInTools = ToolOrchestratorService.getToolSchemas();
          let tools = builtInTools;
          if (options.enabledTools && Array.isArray(options.enabledTools)) {
            const enabledSet = new Set(options.enabledTools);
            tools = tools.filter((t) => enabledSet.has(t.name));
          }
          options.tools = tools;
          logger.info(`[chat] FC tools injected: ${tools.length} tools enabled for ${providerName} ${resolvedModel}`);
        }

        if (options.agenticLoopEnabled) {
          // Lazy-load AgenticLoopService — only needed for the agentic path
          // which is exclusively triggered via the /agent endpoint.
          const { default: AgenticLoopService } = await import("../services/AgenticLoopService.js");
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
            agent,
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
            agent,
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
          agent,
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
    markGenerating(conversationId, project, username, false);
    const totalSec = (performance.now() - requestStart) / 1000;
    RequestLogger.logChatGeneration({
      requestId,
      endpoint: agenticLoopEnabled ? "/agent" : "/chat",
      operation: agenticLoopEnabled ? "agent" : "chat",
      project,
      username,
      clientIp,
      provider: providerName,
      model: resolvedModel || requestedModel || "unknown",
      conversationId: conversationId || null,
      sessionId: sessionId || null,
      success: false,
      errorMessage: error.message,
      totalSec,
      messages: messages || [],
      options: {},
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
  markGenerating(conversationId, project, username, true);
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
      formatCostTag(estimatedCost),
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
    estimateTokens(prompt) + allImages.length * (modelDef?.imageTokensPerImage || 1120);

  RequestLogger.log({
    requestId,
    endpoint: "/chat",
    operation: "chat:image",
    project,
    username,
    clientIp,
    provider: providerName,
    model: resolvedModel,
    conversationId: conversationId || null,
    sessionId: sessionId || null,
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

    appendAndFinalize(conversationId, project, username, messagesToAppend, meta);
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
    thinkingSignature,
    images,
    toolCalls,
    audioChunks,
    audioSampleRate,
    usage,
    outputCharacters,
    timeToGenerationSec,
    generationSec,
    totalSec,
    rateLimits,
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
    agent,
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

    tokensPerSec = calculateTokensPerSec(usage.outputTokens, generationSec, {
      providerReported: usage.tokensPerSec,
      fallbackSec: totalSec,
    });
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
      formatCostTag(estimatedCost),
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
      endpoint: options.agenticLoopEnabled ? "/agent" : modelDef?.liveAPI ? "/live" : "/chat",
      operation: options.agenticLoopEnabled ? "agent" : modelDef?.liveAPI ? "live" : "chat",
      project,
      username,
      clientIp,
      agent,
      provider: providerName,
      model: resolvedModel,
      conversationId: conversationId || null,
      sessionId: sessionId || null,
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
      rateLimits,
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
        ...(thinkingSignature && { thinkingSignature }),
        ...(images.length > 0 && { images }),
        ...(audioRef && { audio: audioRef }),
        // Include toolCalls on the final message if no intermediate message
        // already persists them. The regular agentic loop embeds toolCalls in
        // intermediate assistant messages (overrideMessagesToAppend), but
        // native MCP tool calls (e.g. LM Studio) bypass that path — without
        // this, tool calls vanish on page refresh.
        ...(!overrideMessagesToAppend.some((m) => m.role === "assistant" && m.toolCalls?.length > 0) &&
          toolCalls.length > 0 && { toolCalls }),
        model: resolvedModel,
        provider: providerName,
        timestamp: new Date().toISOString(),
        usage: usage || null,
        totalTime: parseFloat(totalSec.toFixed(3)),
        tokensPerSec,
        estimatedCost,
        // Generation settings — source of truth per request
        generationSettings: {
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          thinkingEnabled: options.thinkingEnabled || false,
          ...(options.reasoningEffort && { reasoningEffort: options.reasoningEffort }),
          ...(options.thinkingBudget && { thinkingBudget: options.thinkingBudget }),
        },
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
        ...(thinkingSignature && { thinkingSignature }),
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
        // Generation settings — source of truth per request
        generationSettings: {
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          thinkingEnabled: options.thinkingEnabled || false,
          ...(options.reasoningEffort && { reasoningEffort: options.reasoningEffort }),
          ...(options.thinkingBudget && { thinkingBudget: options.thinkingBudget }),
        },
      });
    }

    const meta = conversationMeta
      ? {
          ...conversationMeta,
          settings: { provider: providerName, model: resolvedModel },
        }
      : undefined;

    appendAndFinalize(conversationId, project, username, messagesToAppend, meta);
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
  markGenerating(conversationId, project, username, true);

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

  const ss = createStreamState();

  for await (const chunk of stream) {
    // Client disconnected — abort the upstream provider stream
    if (signal?.aborted) {
      if (typeof stream.return === "function") stream.return();
      logger.info(
        `[chat] Client disconnected, aborting stream for ${providerName} ${resolvedModel}`,
      );
      break;
    }
    await dispatchChunk(chunk, ss, { emit, project, username }, { logPrefix: "chat/stream" });
  }

  // ── FC tool execution loop ─────────────────────────────────
  // When functionCallingEnabled is set on /chat (not the agentic loop),
  // execute returned tool calls via ToolOrchestratorService and re-call
  // the provider with tool results. Lightweight loop — no approval
  // engine, no context manager, just direct execution.
  const MAX_FC_ITERATIONS = 10;
  let fcIteration = 0;

  while (
    options.functionCallingEnabled &&
    ss.toolCalls.length > 0 &&
    ss.toolCalls.some((tc) => !tc.result && tc.status !== "done" && tc.status !== "error") &&
    fcIteration < MAX_FC_ITERATIONS &&
    !signal?.aborted
  ) {
    fcIteration++;
    const pendingCalls = ss.toolCalls.filter(
      (tc) => !tc.result && tc.status !== "done" && tc.status !== "error",
    );

    if (pendingCalls.length === 0) break;

    logger.info(`[chat/FC] Iteration ${fcIteration}: executing ${pendingCalls.length} tool call(s)`);

    // Execute all pending tool calls
    for (const tc of pendingCalls) {
      emit({ type: "toolCall", id: tc.id, name: tc.name, args: tc.args, status: "calling" });
      try {
        const result = await ToolOrchestratorService.executeTool(tc.name, tc.args, { project, username });
        tc.result = result;
        tc.status = result?.error ? "error" : "done";
        emit({ type: "toolCall", id: tc.id, name: tc.name, args: tc.args, result, status: tc.status });
      } catch (err) {
        tc.result = { error: err.message };
        tc.status = "error";
        emit({ type: "toolCall", id: tc.id, name: tc.name, args: tc.args, result: tc.result, status: "error" });
      }
    }

    // Build tool result messages for the provider
    const assistantToolMsg = {
      role: "assistant",
      content: ss.text || "",
      toolCalls: ss.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        args: tc.args,
      })),
      ...(ss.thinking ? { thinking: ss.thinking } : {}),
      ...(ss.thinkingSignature ? { thinkingSignature: ss.thinkingSignature } : {}),
    };

    const toolResultMsgs = ss.toolCalls
      .filter((tc) => tc.result)
      .map((tc) => ({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.name,
        content: typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result),
      }));

    // Re-call provider with tool results appended
    const updatedMessages = [...messages, assistantToolMsg, ...toolResultMsgs];

    // Reset accumulators for the follow-up stream
    ss.text = "";
    ss.thinking = "";
    ss.thinkingSignature = "";
    ss.toolCalls.length = 0;

    const followUpStream = provider.generateTextStream(updatedMessages, resolvedModel, {
      ...options,
      signal,
    });

    // Use dispatchChunk with a custom usage merger for follow-up iteration
    const usageMerger = (followUpUsage) => {
      if (ss.usage && followUpUsage) {
        ss.usage.inputTokens = (ss.usage.inputTokens || 0) + (followUpUsage.inputTokens || 0);
        ss.usage.outputTokens = (ss.usage.outputTokens || 0) + (followUpUsage.outputTokens || 0);
      } else {
        ss.usage = followUpUsage;
      }
    };

    for await (const chunk of followUpStream) {
      if (signal?.aborted) {
        if (typeof followUpStream.return === "function") followUpStream.return();
        break;
      }
      await dispatchChunk(chunk, ss, { emit, project, username }, { onUsage: usageMerger, logPrefix: "chat/FC" });
    }

    // Update messages ref for potential next iteration
    messages.push(assistantToolMsg, ...toolResultMsgs);
  }

  // Build normalized result for shared finalization
  const now = performance.now();
  await finalizeTextGeneration(ctx, {
    text: ss.text,
    thinking: ss.thinking,
    thinkingSignature: ss.thinkingSignature,
    images: ss.images,
    toolCalls: ss.toolCalls,
    audioChunks: ss.audioChunks,
    audioSampleRate: ss.audioSampleRate,
    usage: ss.usage,
    outputCharacters: ss.outputCharacters,
    timeToGenerationSec: ss.firstTokenTime
      ? (ss.firstTokenTime - requestStart) / 1000
      : null,
    generationSec:
      ss.firstTokenTime && ss.generationEnd
        ? (ss.generationEnd - ss.firstTokenTime) / 1000
        : null,
    totalSec: (now - requestStart) / 1000,
    rateLimits: ss.rateLimits,
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
  markGenerating(conversationId, project, username, true);

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
    rateLimits: genResult.rateLimits || null,
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
  const params = {
    ...req.body,
    project: req.body.project || req.project,
    username: req.username,
    clientIp: req.clientIp,
  };

  if (req.query.stream !== "false") {
    await handleSseRequest(req, res, params);
  } else {
    await handleJsonRequest(req, res, next, params);
  }
});

export default router;

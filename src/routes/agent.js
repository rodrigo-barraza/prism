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
export async function resolveImageRefs(messages, project, username) {
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
    enabledTools,
    minContextLength,
    forceImageGeneration,
    responseFormat,
    serviceTier,
    textOnly,
    skipConversation,
    autoApprove,
    planFirst,
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
  // Sessions group requests across a single interaction cycle (e.g.
  // a Discord message in Lupos), even when skipConversation is set.
  let sessionId = incomingSessionId || null;
  if (!sessionId && incomingCreateSession) {
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
    ...(enabledTools && { enabledTools }),
    ...(minContextLength && { minContextLength }),
    ...(forceImageGeneration && { forceImageGeneration }),
    ...(responseFormat && { responseFormat }),
    ...(serviceTier && { serviceTier }),
    ...(textOnly && { textOnly }),
    ...(autoApprove && { autoApprove }),
    ...(planFirst && { planFirst }),
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
          logger.info(`[chat] LM-Studio MCP: ${tools.length} tools enabled, enabledTools=${(options.enabledTools || []).length}, builtIn=${builtInTools.length}, contextLength=${options.contextLength || 'unset'}`);
        } else if (useLmStudioNativeMcp) {
          logger.warn(`[chat] LM-Studio MCP SKIPPED: functionCallingEnabled=${options.functionCallingEnabled}, useLmStudioNativeMcp=${useLmStudioNativeMcp}`);
        }

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

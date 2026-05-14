import { expandMessagesForFC } from "../../utils/FunctionCallingUtilities.js";
import { mergeUsage, createUsageAccumulator } from "../../utils/CostCalculator.js";
import { calculateTextCost } from "../../utils/CostCalculator.js";
import { calculateTokensPerSec } from "../../utils/math.js";
import { getPricing, TYPES } from "../../config.js";
import { stripToolCallMarkup } from "../../utils/StreamChunkDispatcher.js";
import ContextWindowManager from "../../utils/ContextWindowManager.js";
import SessionGenerationTracker from "../SessionGenerationTracker.js";
import RequestLogger from "../RequestLogger.js";
import FileService from "../FileService.js";
import logger from "../../utils/logger.js";

/**
 * BaseAgenticHarness — abstract base class that defines the contract
 * for agentic loop execution strategies ("harnesses").
 *
 * Subclasses implement `run()` with their specific control flow
 * (standard tool loop, ReAct, plan-then-execute, etc.) while
 * inheriting shared infrastructure:
 *
 *   - Stream chunk routing (`processStreamChunk`)
 *   - Progress emission (`emitGenerationProgress`, `maybeEmitProgress`)
 *   - Iteration logging (`logIteration`)
 *   - Context window enforcement (`enforceContextWindow`)
 *   - LLM stream creation (`createProviderStream`)
 *   - Stream consumption (`consumeStream` — full pass with chunk routing)
 */
export default class BaseAgenticHarness {
  /** Harness identifier — subclasses MUST override. */
  static id = "base";
  static label = "Base (abstract)";
  static description = "Abstract base harness — do not use directly.";

  /**
   * @param {object}              ctx    — generation context from ChatRoutes
   * @param {AgenticLoopState}    state  — shared mutable state accumulator
   * @param {object}              tools  — { finalTools, customToolMap, resolvedEnabledTools }
   */
  constructor(ctx, state, tools) {
    this.ctx = ctx;
    this.state = state;
    this.tools = tools;

    const { parentAgentSessionId, agentSessionId } = ctx;
    this.trackerSessionId = parentAgentSessionId || agentSessionId;
  }

  /**
   * Execute the agentic loop. Subclasses MUST override.
   * @returns {Promise<{ messages: object[] }>}
   */
  async run() {
    throw new Error(`${this.constructor.name}.run() is abstract — subclasses must override.`);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  SHARED INFRASTRUCTURE — used by all harness subclasses
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ── Progress emission ────────────────────────────────────

  /** Emit a generation_progress status event with current session stats. */
  emitGenerationProgress() {
    const { emit } = this.ctx;
    const state = this.state;
    const stats = SessionGenerationTracker.getSessionStats(this.trackerSessionId);
    if (stats.activeRequests > 0 || stats.totalOutputTokens > 0) {
      state.hwmOutputTokens = Math.max(state.hwmOutputTokens, stats.totalOutputTokens);
      state.hwmInputTokens = Math.max(state.hwmInputTokens, stats.totalInputTokens);
      state.hwmTotalTokens = Math.max(state.hwmTotalTokens, stats.totalTokens);
      state.hwmOutputCharacters = Math.max(state.hwmOutputCharacters, state.overallOutputCharacters);
      emit({
        type: "status",
        message: "generation_progress",
        tokPerSec: stats.tokPerSec,
        activeRequests: stats.activeRequests,
        outputTokens: state.hwmOutputTokens,
        inputTokens: state.hwmInputTokens,
        totalTokens: state.hwmTotalTokens,
        outputCharacters: state.hwmOutputCharacters,
        avgTtft: stats.avgTtft,
      });
    }
    state.lastProgressEmitTime = performance.now();
    state.chunksSinceLastProgress = 0;
  }

  /** Check if it's time to emit a progress event. */
  maybeEmitProgress() {
    const state = this.state;
    state.chunksSinceLastProgress++;
    const timeSinceLast = performance.now() - state.lastProgressEmitTime;
    if (state.chunksSinceLastProgress >= state.PROGRESS_CHUNK_INTERVAL || timeSinceLast >= state.PROGRESS_TIME_INTERVAL_MS) {
      this.emitGenerationProgress();
    }
  }

  // ── Context window enforcement ───────────────────────────

  /**
   * Enforce token budget on messages before sending to provider.
   * @param {object[]} messages
   * @param {number}   toolCount
   * @returns {object[]} — possibly truncated messages
   */
  enforceContextWindow(messages, toolCount) {
    const { modelDef, options, emit } = this.ctx;
    const contextResult = ContextWindowManager.enforce(messages, {
      maxInputTokens: modelDef?.maxInputTokens || 128_000,
      maxOutputTokens: options.maxTokens || 8192,
      toolCount,
    });
    if (contextResult.truncated) {
      emit({
        type: "status",
        message: "context_truncated",
        strategy: contextResult.strategy,
        estimatedTokens: contextResult.estimatedTokens,
      });
      return contextResult.messages;
    }
    return messages;
  }

  // ── Provider stream creation ──────────────────────────────

  /**
   * Create an LLM text stream from the provider.
   * Handles liveAPI fallback and message expansion.
   */
  createProviderStream(messages, passOptions) {
    const { provider, resolvedModel, modelDef, signal } = this.ctx;
    const expandedMessages = expandMessagesForFC(messages, { filterDeleted: false });
    return modelDef?.liveAPI && provider.generateTextStreamLive
      ? provider.generateTextStreamLive(expandedMessages, resolvedModel, { ...passOptions, signal })
      : provider.generateTextStream(expandedMessages, resolvedModel, { ...passOptions, signal });
  }

  // ── Session tracking helpers ──────────────────────────────

  /** Register a request with SessionGenerationTracker. */
  registerTrackerRequest(passRequestId) {
    const { providerName, resolvedModel, parentAgentSessionId, agentSessionId } = this.ctx;
    SessionGenerationTracker.register(this.trackerSessionId, passRequestId, {
      provider: providerName,
      model: resolvedModel,
      source: parentAgentSessionId ? "worker" : "orchestrator",
      workerId: parentAgentSessionId ? agentSessionId : null,
    });
  }

  // ── Stream chunk processing ───────────────────────────────

  /**
   * Process a single stream chunk — routes to the appropriate handler.
   * Returns an action descriptor for the caller:
   *   { action: "continue" }     — chunk was consumed, keep iterating
   *   { action: "toolCall", tc }  — a tool call was detected
   *   { action: "skip" }         — chunk was filtered/dropped
   *
   * @param {*}      chunk            — raw chunk from provider stream
   * @param {object} pass             — per-iteration pass state
   * @param {Set}    allowedToolNames — tool names in the current schema
   * @returns {object}
   */
  processStreamChunk(chunk, pass, allowedToolNames) {
    const { emit, signal } = this.ctx;
    const state = this.state;

    // Abort check
    if (signal?.aborted) return { action: "break" };

    // ── Usage event ──────────────────────────────────────
    if (chunk?.type === "usage") {
      mergeUsage(state.overallUsage, chunk.usage);
      mergeUsage(pass.usage, chunk.usage);
      const reportedInput = chunk.usage?.inputTokens || chunk.usage?.promptTokens || 0;
      if (reportedInput > 0) {
        SessionGenerationTracker.update(pass.requestId, { inputTokens: reportedInput });
      }
      return { action: "continue" };
    }

    // ── Rate limits ──────────────────────────────────────
    if (chunk?.type === "rateLimits") {
      state.lastRateLimits = chunk.rateLimits;
      return { action: "continue" };
    }

    // ── Thinking ─────────────────────────────────────────
    if (chunk?.type === "thinking") {
      this._recordFirstToken(pass);
      this._recordTiming(pass);
      state.streamedThinking += chunk.content;
      pass.streamedThinking += chunk.content;
      // Display segment tracking
      if (state.lastDisplaySegType !== "thinking") {
        state.displaySegments.push({ type: "thinking", fragmentIndex: state.displayThinkingFragments.length });
        state.displayThinkingFragments.push("");
        state.lastDisplaySegType = "thinking";
      }
      state.displayThinkingFragments[state.displayThinkingFragments.length - 1] += chunk.content;
      state.overallOutputCharacters += chunk.content.length;
      SessionGenerationTracker.recordChunkTiming(pass.requestId, chunk.content.length);
      emit({ type: "thinking", content: chunk.content, outputCharacters: state.overallOutputCharacters });
      this.maybeEmitProgress();
      return { action: "continue" };
    }

    // ── Thinking signature (Anthropic) ───────────────────
    if (chunk?.type === "thinking_signature") {
      pass.thinkingSignature = chunk.signature;
      return { action: "continue" };
    }

    // ── Tool call argument delta ─────────────────────────
    if (chunk?.type === "toolCallDelta") {
      this._recordFirstToken(pass);
      this._recordTiming(pass);
      state.overallOutputCharacters += chunk.characters;
      SessionGenerationTracker.recordChunkTiming(pass.requestId, chunk.characters);
      this.maybeEmitProgress();
      return { action: "continue" };
    }

    // ── Tool call ────────────────────────────────────────
    if (chunk?.type === "toolCall") {
      this._recordFirstToken(pass);
      this._recordTiming(pass);
      SessionGenerationTracker.recordChunkTiming(pass.requestId, JSON.stringify(chunk.args || {}).length);
      this.maybeEmitProgress();

      // Native MCP tool calls: pass through directly
      if (chunk.native) {
        if (chunk.status === "calling") {
          const tcId = chunk.id || `ntc-${state.streamedToolCalls.length}`;
          state.streamedToolCalls.push({ id: tcId, name: chunk.name, args: chunk.args || {} });
          this._trackToolDisplaySegment(tcId);
        } else if (chunk.status === "done" || chunk.status === "error") {
          const existing = state.streamedToolCalls.find(
            (tc) => (chunk.id && tc.id === chunk.id) || (!chunk.id && tc.name === chunk.name),
          );
          if (existing) {
            existing.result = chunk.result;
            existing.status = chunk.status;
            if (chunk.args && Object.keys(chunk.args).length > 0) existing.args = chunk.args;
          }
        }
        emit({
          type: "toolCall",
          id: chunk.id || null,
          name: chunk.name,
          args: chunk.args || {},
          result: chunk.result || undefined,
          status: chunk.status || "calling",
        });
        return { action: "continue" };
      }

      // Schema enforcement
      if (!allowedToolNames.has(chunk.name)) {
        logger.warn(`[AgenticLoop] Dropped tool call "${chunk.name}" — not in schema: [${[...allowedToolNames].join(", ")}]`);
        return { action: "skip" };
      }

      const stdTcId = chunk.id || `tc-${state.streamedToolCalls.length}`;
      const tc = {
        id: stdTcId,
        responsesItemId: chunk.responsesItemId || undefined,
        name: chunk.name,
        args: chunk.args || {},
        thoughtSignature: chunk.thoughtSignature || undefined,
      };
      pass.pendingToolCalls.push(tc);
      state.streamedToolCalls.push({ ...tc });
      this._trackToolDisplaySegment(stdTcId);
      emit({
        type: "tool_execution",
        tool: { name: chunk.name, args: chunk.args || {}, id: stdTcId },
        status: "calling",
      });
      return { action: "toolCall", tc };
    }

    // ── Image ────────────────────────────────────────────
    if (chunk?.type === "image") {
      return this._handleImageChunk(chunk, pass);
    }

    // ── Pass-through events ──────────────────────────────
    if (chunk?.type === "executableCode") {
      emit({ type: "executableCode", code: chunk.code, language: chunk.language });
      return { action: "continue" };
    }
    if (chunk?.type === "codeExecutionResult") {
      emit({ type: "codeExecutionResult", output: chunk.output, outcome: chunk.outcome });
      return { action: "continue" };
    }
    if (chunk?.type === "webSearchResult") {
      emit({ type: "webSearchResult", results: chunk.results });
      return { action: "continue" };
    }
    if (chunk?.type === "audio") {
      emit({ type: "audio", data: chunk.data, mimeType: chunk.mimeType });
      if (chunk.data) state.streamedAudioChunks.push(chunk.data);
      if (chunk.mimeType) {
        const rateMatch = chunk.mimeType.match(/rate=(\d+)/);
        if (rateMatch) state.audioSampleRate = parseInt(rateMatch[1], 10);
      }
      return { action: "continue" };
    }
    if (chunk?.type === "status") {
      const { type: _t, ...statusRest } = chunk;
      emit({ type: "status", ...statusRest });
      return { action: "continue" };
    }

    // ── Text chunk (default) ─────────────────────────────
    this._recordFirstToken(pass);
    this._recordTiming(pass);
    const rawChunkStr = typeof chunk === "string" ? chunk : "";
    state.overallOutputCharacters += rawChunkStr.length;
    pass.outputCharacters += rawChunkStr.length;
    pass.streamedText += rawChunkStr;
    // Strip tool call XML markup leaked by some local models
    const cleanedPassText = stripToolCallMarkup(pass.streamedText);
    const chunkStr = cleanedPassText.slice(state.finalStreamedText.length);
    state.finalStreamedText = cleanedPassText;
    if (state.planModeActive) state.planModeText += chunkStr;
    // Display segment tracking
    if (state.lastDisplaySegType !== "text") {
      state.displaySegments.push({ type: "text", fragmentIndex: state.displayTextFragments.length });
      state.displayTextFragments.push("");
      state.lastDisplaySegType = "text";
    }
    state.displayTextFragments[state.displayTextFragments.length - 1] += chunkStr;
    SessionGenerationTracker.recordChunkTiming(pass.requestId, rawChunkStr.length);
    if (chunkStr) emit({ type: "chunk", content: chunkStr, outputCharacters: state.overallOutputCharacters });
    this.maybeEmitProgress();
    return { action: "continue" };
  }

  // ── Iteration logging ─────────────────────────────────────

  /**
   * Log a single iteration to the request log.
   */
  logIteration(pass, currentMessages) {
    const { resolvedModel, providerName, project, username, agent, agentSessionId, parentAgentSessionId, traceId } = this.ctx;
    const state = this.state;
    const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];

    const passTotalSec = (performance.now() - pass.start) / 1000;
    const passGenerationSec = pass.firstTokenTime && pass.generationEnd ? (pass.generationEnd - pass.firstTokenTime) / 1000 : null;
    const passTokensPerSec = calculateTokensPerSec(pass.usage.outputTokens, passGenerationSec);
    const passEstimatedCost = calculateTextCost(pass.usage, pricing);

    RequestLogger.logChatGeneration({
      requestId: `${this.ctx.requestId}-${state.iterations}`,
      endpoint: "/agent",
      operation: "agent:iteration",
      project,
      username,
      clientIp: this.ctx.clientIp,
      agent: agent || null,
      provider: providerName,
      model: resolvedModel,
      agentSessionId,
      parentAgentSessionId: parentAgentSessionId || null,
      traceId: traceId || null,
      success: true,
      usage: pass.usage,
      estimatedCost: passEstimatedCost,
      tokensPerSec: passTokensPerSec,
      timeToGenerationSec: pass.firstTokenTime ? (pass.firstTokenTime - pass.start) / 1000 : null,
      generationSec: passGenerationSec,
      totalSec: passTotalSec,
      options: pass.options,
      messages: currentMessages,
      text: pass.streamedText,
      thinking: pass.streamedThinking,
      images: pass.streamedImages,
      toolCalls: pass.pendingToolCalls,
      outputCharacters: pass.outputCharacters,
      agenticIteration: state.iterations,
    }).catch(err => logger.error(`[AgenticLoopService] Failed to log intermediate request: ${err.message}`));
  }

  // ── Per-iteration pass state factory ──────────────────────

  /**
   * Create a fresh per-iteration pass state object.
   */
  createPassState(passOptions) {
    return {
      streamedText: "",
      streamedThinking: "",
      thinkingSignature: "",
      pendingToolCalls: [],
      streamedImages: [],
      start: performance.now(),
      firstTokenTime: null,
      generationEnd: null,
      outputCharacters: 0,
      usage: createUsageAccumulator(),
      options: passOptions,
      requestId: null, // set after tracker registration
    };
  }

  // ── Private helpers ───────────────────────────────────────

  _recordFirstToken(pass) {
    const state = this.state;
    if (!state.overallFirstTokenTime) state.overallFirstTokenTime = performance.now();
    if (!pass.firstTokenTime) {
      pass.firstTokenTime = performance.now();
      const ttftSec = (pass.firstTokenTime - pass.start) / 1000;
      SessionGenerationTracker.update(pass.requestId, { ttft: ttftSec });
      this.ctx.emit({ type: "status", message: "generation_started", timeToFirstToken: ttftSec });
    }
  }

  _recordTiming(pass) {
    this.state.overallGenerationEnd = performance.now();
    pass.generationEnd = performance.now();
  }

  _trackToolDisplaySegment(tcId) {
    const state = this.state;
    if (state.lastDisplaySegType === "tools") {
      state.displaySegments[state.displaySegments.length - 1].toolIds.push(tcId);
    } else {
      state.displaySegments.push({ type: "tools", toolIds: [tcId] });
      state.lastDisplaySegType = "tools";
    }
  }

  async _handleImageChunk(chunk, pass) {
    const { emit, project, username } = this.ctx;
    const state = this.state;
    let minioRef = null;
    if (chunk.data) {
      try {
        const mimeType = chunk.mimeType || "image/png";
        const dataUrl = `data:${mimeType};base64,${chunk.data}`;
        const { ref } = await FileService.uploadFile(dataUrl, "generations", project, username);
        minioRef = ref;
      } catch (err) {
        logger.error(`MinIO upload failed: ${err.message}`);
      }
      const imgRef = minioRef || `data:${chunk.mimeType || "image/png"};base64,${chunk.data}`;
      state.streamedImages.push(imgRef);
      pass.streamedImages.push(imgRef);
    }
    emit({ type: "image", ...(minioRef ? {} : { data: chunk.data }), mimeType: chunk.mimeType, minioRef });
    return { action: "continue" };
  }
}

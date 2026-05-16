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
    static id: string;
    static label: string;
    static description: string;
    /**
     * @param {object}              ctx    — generation context from ChatRoutes
     * @param {AgenticLoopState}    state  — shared mutable state accumulator
     * @param {object}              tools  — { finalTools, customToolMap, resolvedEnabledTools }
     */
    constructor(ctx: any, state: any, tools: any);
    /**
     * Execute the agentic loop. Subclasses MUST override.
     * @returns {Promise<{ messages: object[] }>}
     */
    run(): Promise<void>;
    /** Emit a generation_progress status event with current session stats. */
    emitGenerationProgress(): void;
    /** Check if it's time to emit a progress event. */
    maybeEmitProgress(): void;
    /**
     * Enforce token budget on messages before sending to provider.
     * @param {object[]} messages
     * @param {number}   toolCount
     * @returns {object[]} — possibly truncated messages
     */
    enforceContextWindow(messages: any, toolCount: any): any;
    /**
     * Create an LLM text stream from the provider.
     * Handles liveAPI fallback and message expansion.
     */
    createProviderStream(messages: any, passOptions: any): any;
    /** Register a request with SessionGenerationTracker. */
    registerTrackerRequest(passRequestId: any): void;
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
    processStreamChunk(chunk: any, pass: any, allowedToolNames: any): Promise<{
        action: string;
    }> | {
        action: string;
        tc?: undefined;
    } | {
        action: string;
        tc: {
            id: any;
            responsesItemId: any;
            name: any;
            args: any;
            thoughtSignature: any;
        };
    };
    /**
     * Log a single iteration to the request log.
     */
    logIteration(pass: any, currentMessages: any): void;
    /**
     * Create a fresh per-iteration pass state object.
     */
    createPassState(passOptions: any): {
        streamedText: string;
        streamedThinking: string;
        thinkingSignature: string;
        pendingToolCalls: never[];
        streamedImages: never[];
        start: number;
        firstTokenTime: null;
        generationEnd: null;
        outputCharacters: number;
        usage: {
            inputTokens: number;
            outputTokens: number;
            cacheReadInputTokens: number;
            cacheCreationInputTokens: number;
            reasoningOutputTokens: number;
        };
        options: any;
        requestId: null;
    };
    _recordFirstToken(pass: any): void;
    _recordTiming(pass: any): void;
    _trackToolDisplaySegment(tcId: any): void;
    _handleImageChunk(chunk: any, pass: any): Promise<{
        action: string;
    }>;
}
//# sourceMappingURL=BaseAgenticHarness.d.ts.map
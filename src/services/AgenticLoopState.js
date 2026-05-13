import { createUsageAccumulator } from "../utils/CostCalculator.js";

/**
 * AgenticLoopState — encapsulates all mutable accumulated state
 * for an agentic loop execution.
 *
 * Harness implementations populate this during `run()` and the
 * finalization logic reads from it to persist and emit results.
 *
 * Separating state from logic makes it possible for different
 * harnesses to share finalization, progress emission, and DB
 * persistence code without inheritance coupling.
 */
export default class AgenticLoopState {
  constructor({ originalMessageCount = 0, planModeActive = false } = {}) {
    // ── Iteration tracking ──────────────────────────────────
    this.iterations = 0;

    // ── Usage / cost accumulation ────────────────────────────
    this.overallUsage = createUsageAccumulator();
    this.overallFirstTokenTime = null;
    this.overallGenerationEnd = null;
    this.overallOutputCharacters = 0;

    // ── Streamed content ────────────────────────────────────
    this.finalStreamedText = "";
    this.streamedThinking = "";
    this.streamedImages = [];
    this.streamedToolCalls = [];
    this.streamedAudioChunks = [];
    this.audioSampleRate = 24000;
    this.lastRateLimits = null;

    // ── Display segment tracking ────────────────────────────
    // Mirrors the client-side contentSegments system so the
    // interleaving order (thinking ↔ tools ↔ text) survives DB
    // round-trips for proper rendering on session restore.
    this.displaySegments = [];
    this.displayTextFragments = [];
    this.displayThinkingFragments = [];
    this.lastDisplaySegType = null;

    // ── Plan mode ───────────────────────────────────────────
    this.planModeActive = planModeActive;
    this.planModeText = "";

    // ── Message management ──────────────────────────────────
    // Track the initial message count so we can slice only NEW
    // messages for DB persistence. The client sends the full
    // history; we must not re-append already-persisted messages.
    this.originalMessageCount = originalMessageCount;

    // ── Error budget tracking ───────────────────────────────
    this.toolErrorCounts = new Map();

    // ── High-water marks ────────────────────────────────────
    // Token counts emitted to the frontend must be monotonically
    // non-decreasing. These prevent dips at iteration boundaries.
    this.hwmOutputTokens = 0;
    this.hwmInputTokens = 0;
    this.hwmTotalTokens = 0;
    this.hwmOutputCharacters = 0;

    // ── Progress emission throttling ────────────────────────
    this.PROGRESS_CHUNK_INTERVAL = 10;
    this.PROGRESS_TIME_INTERVAL_MS = 500;
    this.lastProgressEmitTime = 0;
    this.chunksSinceLastProgress = 0;
  }

  /**
   * Get clean display segments (trimmed, empty-filtered) for DB persistence.
   */
  getCleanDisplayData() {
    const cleanSegments = [];
    const cleanTextFragments = [];
    const cleanThinkingFragments = [];

    for (const seg of this.displaySegments) {
      if (seg.type === "text") {
        const trimmed = this.displayTextFragments[seg.fragmentIndex]?.trim();
        if (!trimmed) continue;
        cleanSegments.push({ type: "text", fragmentIndex: cleanTextFragments.length });
        cleanTextFragments.push(trimmed);
      } else if (seg.type === "thinking") {
        const trimmed = this.displayThinkingFragments[seg.fragmentIndex]?.trim();
        if (!trimmed) continue;
        cleanSegments.push({ type: "thinking", fragmentIndex: cleanThinkingFragments.length });
        cleanThinkingFragments.push(trimmed);
      } else {
        cleanSegments.push(seg); // tools segments pass through
      }
    }

    return { cleanSegments, cleanTextFragments, cleanThinkingFragments };
  }
}

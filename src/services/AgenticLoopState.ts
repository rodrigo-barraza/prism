import { createUsageAccumulator } from "../utils/CostCalculator.ts";

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
  constructor({ originalMessageCount = 0, planModeActive = false }: any = {}) {
    // ── Iteration tracking ──────────────────────────────────
    // @ts-ignore
    this.iterations = 0;

    // ── Usage / cost accumulation ────────────────────────────
    // @ts-ignore
    this.overallUsage = createUsageAccumulator();
    // @ts-ignore
    this.overallFirstTokenTime = null;
    // @ts-ignore
    this.overallGenerationEnd = null;
    // @ts-ignore
    this.overallOutputCharacters = 0;

    // ── Streamed content ────────────────────────────────────
    // @ts-ignore
    this.finalStreamedText = "";
    // @ts-ignore
    this.streamedThinking = "";
    // @ts-ignore
    this.streamedImages = [];
    // @ts-ignore
    this.streamedToolCalls = [];
    // @ts-ignore
    this.streamedAudioChunks = [];
    // @ts-ignore
    this.audioSampleRate = 24000;
    // @ts-ignore
    this.lastRateLimits = null;

    // ── Display segment tracking ────────────────────────────
    // Mirrors the client-side contentSegments system so the
    // interleaving order (thinking ↔ tools ↔ text) survives DB
    // round-trips for proper rendering on session restore.
    // @ts-ignore
    this.displaySegments = [];
    // @ts-ignore
    this.displayTextFragments = [];
    // @ts-ignore
    this.displayThinkingFragments = [];
    // @ts-ignore
    this.lastDisplaySegType = null;

    // ── Plan mode ───────────────────────────────────────────
    // @ts-ignore
    this.planModeActive = planModeActive;
    // @ts-ignore
    this.planModeText = "";

    // ── Message management ──────────────────────────────────
    // Track the initial message count so we can slice only NEW
    // messages for DB persistence. The client sends the full
    // history; we must not re-append already-persisted messages.
    // @ts-ignore
    this.originalMessageCount = originalMessageCount;

    // ── Error budget tracking ───────────────────────────────
    // @ts-ignore
    this.toolErrorCounts = new Map();

    // ── High-water marks ────────────────────────────────────
    // Token counts emitted to the frontend must be monotonically
    // non-decreasing. These prevent dips at iteration boundaries.
    // @ts-ignore
    this.hwmOutputTokens = 0;
    // @ts-ignore
    this.hwmInputTokens = 0;
    // @ts-ignore
    this.hwmTotalTokens = 0;
    // @ts-ignore
    this.hwmOutputCharacters = 0;

    // ── Progress emission throttling ────────────────────────
    // @ts-ignore
    this.PROGRESS_CHUNK_INTERVAL = 10;
    // @ts-ignore
    this.PROGRESS_TIME_INTERVAL_MS = 500;
    // @ts-ignore
    this.lastProgressEmitTime = 0;
    // @ts-ignore
    this.chunksSinceLastProgress = 0;
  }

  /**
   * Get clean display segments (trimmed, empty-filtered) for DB persistence.
   */
  getCleanDisplayData() {
    const cleanSegments: any[] = [];
    const cleanTextFragments: any[] = [];
    const cleanThinkingFragments: any[] = [];

    // @ts-ignore
    for ( const seg of this.displaySegments) {
      if (seg.type === "text") {
        // @ts-ignore
        const trimmed = this.displayTextFragments[seg.fragmentIndex]?.trim();
        if (!trimmed) continue;
        cleanSegments.push({
          type: "text",
          fragmentIndex: cleanTextFragments.length,
        });
        cleanTextFragments.push(trimmed);
      } else if (seg.type === "thinking") {
        // @ts-ignore
        const trimmed =
          // @ts-ignore
          this.displayThinkingFragments[seg.fragmentIndex]?.trim();
        if (!trimmed) continue;
        cleanSegments.push({
          type: "thinking",
          fragmentIndex: cleanThinkingFragments.length,
        });
        cleanThinkingFragments.push(trimmed);
      } else {
        cleanSegments.push(seg); // tools segments pass through
      }
    }

    return { cleanSegments, cleanTextFragments, cleanThinkingFragments };
  }
}

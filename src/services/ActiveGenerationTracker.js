/**
 * ActiveGenerationTracker
 *
 * In-memory atomic counter tracking how many provider API calls are
 * currently in-flight across the entire Prism process. This powers the
 * rainbow canvas animation in Prism Client's admin sidebar — the counter
 * increments when any provider method starts (generateText, generateTextStream,
 * generateImage, transcribeAudio, etc.) and decrements when it finishes.
 *
 * Designed to be read from the admin SSE endpoint at ~1 Hz so Prism Client
 * can reflect real-time generation activity regardless of whether a
 * conversation is being persisted.
 */

let activeCount = 0;

const ActiveGenerationTracker = {
  /** Increment the active generation counter. */
  increment() {
    activeCount++;
  },

  /** Decrement the active generation counter (floor at 0). */
  decrement() {
    activeCount = Math.max(0, activeCount - 1);
  },

  /** Current number of in-flight provider calls. */
  get count() {
    return activeCount;
  },
};

export default ActiveGenerationTracker;

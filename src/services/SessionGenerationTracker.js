// ─────────────────────────────────────────────────────────────
// SessionGenerationTracker
// ─────────────────────────────────────────────────────────────
// Per-session in-memory tracker for active LLM requests.
// Tracks token throughput at the source (backend provider level)
// so the frontend receives authoritative tok/s data instead of
// computing rates from SSE chunk inter-arrival times.
//
// Each active LLM request registers itself here with timing and
// token data. The aggregate session tok/s is computed on demand
// from all active requests — covering the coordinator, workers,
// and tool sub-requests (e.g. generate_image → Prism /chat).
// ─────────────────────────────────────────────────────────────

// ── Rate computation guards ─────────────────────────────────
// Prevent anomalous spikes from single large chunks or very
// short elapsed windows. Rate is only reported once enough
// samples have accumulated to produce a statistically meaningful
// average. The token estimate (~4 chars/token) can massively
// overcount on large thinking deltas, so we need a generous
// window to let the rate stabilize before reporting.
const MIN_ELAPSED_SEC = 0.5;    // 500ms minimum sample window
const MIN_TOKENS_FOR_RATE = 10; // minimum tokens before reporting rate

/**
 * @typedef {object} ActiveRequest
 * @property {string} requestId
 * @property {string} agentSessionId
 * @property {number} startTime        - performance.now() when request began
 * @property {number} firstTokenTime   - performance.now() of first token (null until first token)
 * @property {number} lastTokenTime    - performance.now() of most recent token
 * @property {number} outputTokens     - running output token count
 * @property {string} provider
 * @property {string} model
 * @property {string} source           - "orchestrator" | "worker" | "tool-sub-request"
 * @property {string|null} workerId    - worker agent ID (null for orchestrator/sub-requests)
 */

/** @type {Map<string, ActiveRequest>} requestId → ActiveRequest */
const activeRequests = new Map();

/** @type {Map<string, Set<string>>} agentSessionId → Set<requestId> */
const sessionIndex = new Map();

/**
 * @typedef {object} SessionAccumulator
 * @property {number} completedTokens - cumulative output tokens from completed requests
 */

/** @type {Map<string, SessionAccumulator>} agentSessionId → cumulative session counters */
const sessionAccumulators = new Map();

const SessionGenerationTracker = {
  /**
   * Register a new LLM request for tracking.
   *
   * @param {string} agentSessionId - Parent session this request belongs to
   * @param {string} requestId      - Unique request identifier
   * @param {object} meta
   * @param {string} meta.provider
   * @param {string} meta.model
   * @param {string} [meta.source="orchestrator"] - "orchestrator" | "worker" | "tool-sub-request"
   * @param {string} [meta.workerId]              - Worker agent ID (for worker requests)
   */
  register(agentSessionId, requestId, { provider, model, source = "orchestrator", workerId = null } = {}) {
    if (!agentSessionId || !requestId) return;

    const entry = {
      requestId,
      agentSessionId,
      startTime: performance.now(),
      firstTokenTime: null,
      lastTokenTime: null,
      outputTokens: 0,
      provider: provider || "unknown",
      model: model || "unknown",
      source,
      workerId,
    };

    activeRequests.set(requestId, entry);

    // Maintain session → requests index
    if (!sessionIndex.has(agentSessionId)) {
      sessionIndex.set(agentSessionId, new Set());
    }
    sessionIndex.get(agentSessionId).add(requestId);

    // Initialize session accumulator (idempotent — preserves across iterations)
    if (!sessionAccumulators.has(agentSessionId)) {
      sessionAccumulators.set(agentSessionId, { completedTokens: 0 });
    }
  },

  /**
   * Update a tracked request with new token data.
   * Called on each chunk/thinking event or on usage completion.
   *
   * @param {string} requestId
   * @param {object} data
   * @param {number} [data.outputTokens] - Running output token count
   */
  update(requestId, { outputTokens } = {}) {
    const entry = activeRequests.get(requestId);
    if (!entry) return;

    const now = performance.now();
    if (!entry.firstTokenTime) entry.firstTokenTime = now;
    entry.lastTokenTime = now;

    if (outputTokens != null) {
      entry.outputTokens = outputTokens;
    }
  },

  /**
   * Mark a request as complete and remove it from active tracking.
   * Rolls the request's final token count into the session accumulator
   * so totalOutputTokens remains monotonically non-decreasing.
   *
   * @param {string} requestId
   */
  complete(requestId) {
    const entry = activeRequests.get(requestId);
    if (!entry) return;

    // Roll completed tokens into the session accumulator
    const acc = sessionAccumulators.get(entry.agentSessionId);
    if (acc) {
      acc.completedTokens += entry.outputTokens;
    }

    activeRequests.delete(requestId);

    const sessionSet = sessionIndex.get(entry.agentSessionId);
    if (sessionSet) {
      sessionSet.delete(requestId);
      if (sessionSet.size === 0) sessionIndex.delete(entry.agentSessionId);
    }
  },

  /**
   * Compute aggregate tok/s and stats for all active requests in a session.
   *
   * Rate computation uses a warm-up guard: tok/s is only reported once
   * a request has accumulated at least MIN_TOKENS_FOR_RATE tokens over
   * at least MIN_ELAPSED_SEC seconds. This prevents anomalous spikes
   * from single large chunks arriving in near-zero elapsed time.
   *
   * @param {string} agentSessionId
   * @returns {{ tokPerSec: number|null, activeRequests: number, totalOutputTokens: number }}
   */
  getSessionStats(agentSessionId) {
    const requestIds = sessionIndex.get(agentSessionId);
    const acc = sessionAccumulators.get(agentSessionId);
    const completedTokens = acc?.completedTokens || 0;

    if (!requestIds || requestIds.size === 0) {
      return { tokPerSec: null, activeRequests: 0, totalOutputTokens: completedTokens };
    }

    let totalTokPerSec = 0;
    let generatingCount = 0;
    let activeOutputTokens = 0;

    for (const rid of requestIds) {
      const req = activeRequests.get(rid);
      if (!req) continue;

      activeOutputTokens += req.outputTokens;

      // Only compute tok/s for requests that have warmed up:
      // - firstTokenTime and lastTokenTime must exist
      // - enough tokens to be statistically meaningful
      // - enough elapsed time to avoid early-burst spikes
      if (req.firstTokenTime && req.lastTokenTime && req.outputTokens >= MIN_TOKENS_FOR_RATE) {
        const elapsed = (req.lastTokenTime - req.firstTokenTime) / 1000;
        if (elapsed >= MIN_ELAPSED_SEC) {
          totalTokPerSec += req.outputTokens / elapsed;
          generatingCount++;
        }
      }
    }

    return {
      tokPerSec: generatingCount > 0
        ? parseFloat((totalTokPerSec / generatingCount).toFixed(1))
        : null,
      activeRequests: requestIds.size,
      // Cumulative: completed requests + in-flight requests
      totalOutputTokens: completedTokens + activeOutputTokens,
    };
  },

  /**
   * Clean up all tracking data for a session.
   *
   * @param {string} agentSessionId
   */
  cleanup(agentSessionId) {
    const requestIds = sessionIndex.get(agentSessionId);
    if (requestIds) {
      for (const rid of requestIds) {
        activeRequests.delete(rid);
      }
      sessionIndex.delete(agentSessionId);
    }
    sessionAccumulators.delete(agentSessionId);
  },

  /**
   * Check if a session has any active requests.
   *
   * @param {string} agentSessionId
   * @returns {boolean}
   */
  hasActiveRequests(agentSessionId) {
    const requestIds = sessionIndex.get(agentSessionId);
    return !!(requestIds && requestIds.size > 0);
  },

  /** Total active requests across all sessions (for diagnostics). */
  get totalActiveRequests() {
    return activeRequests.size;
  },
};

export default SessionGenerationTracker;

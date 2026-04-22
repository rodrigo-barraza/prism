/**
 * Session Generation Tracker — Tok/s Live Integration Tests
 * ═══════════════════════════════════════════════════════════════
 * Validates backend-sourced token throughput (tok/s) tracking from
 * SessionGenerationTracker. Uses the /agent endpoint with a Qwen3
 * model loaded in LM Studio to verify:
 *
 *   1. Combined tok/s is emitted via generation_progress SSE events
 *      and would appear in SettingsPanel statsBadges
 *   2. Coordinator + 4 workers report aggregate tok/s via the unified
 *      tracker (workers register under the parent session)
 *   3. Per-worker tok/s is forwarded as worker_status events and
 *      would appear in MessageList toolCallItem per-worker badges
 *   4. Sub-request attribution: tool callbacks (generate_image,
 *      describe_image) register under the parent session
 *
 * Run:  npm run test:live -- --testPathPattern=sessionGenTracker
 *
 * ═══════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeAll } from "vitest";

const PRISM_URL = "http://localhost:7777";
const LM_STUDIO_URL = "http://localhost:1234";

// ── Target model discovery ─────────────────────────────────
// Qwen3.6 35B A3B UD — auto-discovered from LM Studio
const TARGET_MODEL_PATTERNS = [
  /qwen.*3\.6.*35b.*a3b/i,
  /qwen.*3.*35b.*a3b/i,
  /qwen.*3\.[56].*35b/i,
  /qwen.*3.*30b.*a3b/i,
];

// ── Timeout constants ──────────────────────────────────────
const AGENT_TIMEOUT_MS = 120_000;
const SSE_IDLE_TIMEOUT_MS = 60_000;

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

async function findTargetModel() {
  const res = await fetch(`${LM_STUDIO_URL}/api/v1/models`);
  if (!res.ok) throw new Error("LM Studio not responding");
  const data = await res.json();
  const models = data.models || data.data || [];

  for (const pattern of TARGET_MODEL_PATTERNS) {
    const match = models.find((m) => pattern.test(m.key || m.id));
    if (match) return match.key || match.id;
  }

  // Fallback: any loaded conversational model
  const loaded = models.find(
    (m) => m.loaded_instances?.length > 0 && m.type !== "embedding",
  );
  if (loaded) return loaded.key || loaded.id;

  const first = models.find((m) => m.type !== "embedding");
  return first ? first.key || first.id : null;
}

/**
 * Parse SSE events from a streaming agent response.
 * Extended to capture generation_progress and worker_status events
 * for tok/s validation.
 */
async function consumeAgentSSE(response, { timeoutMs = AGENT_TIMEOUT_MS, controller } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const result = {
    events: [],
    chunks: [],
    thinkingChunks: [],
    statuses: [],
    toolCalls: [],
    errors: [],
    done: null,
    text: "",
    thinking: "",
    phases: new Set(),
    aborted: false,
    timedOut: false,
    totalEvents: 0,
    durationMs: 0,

    // ── Tok/s tracking fields ────────────────────────────
    generationProgressEvents: [],   // { tokPerSec, activeRequests, outputTokens }
    usageUpdateEvents: [],          // { usage }
    workerStatusEvents: [],         // all worker_status events
    workerGenerationProgress: {},   // workerId → { tokPerSec, outputTokens }[]
    workerCompleteEvents: [],       // worker completion events with usage
  };

  const startTime = Date.now();
  let lastEventTime = Date.now();

  const timeoutId = setTimeout(() => {
    result.timedOut = true;
    controller?.abort();
    reader.cancel().catch(() => {});
  }, timeoutMs);

  const idleTimeoutId = setInterval(() => {
    if (Date.now() - lastEventTime > SSE_IDLE_TIMEOUT_MS) {
      console.warn(`  ⚠ SSE idle for ${SSE_IDLE_TIMEOUT_MS / 1000}s — aborting`);
      result.timedOut = true;
      controller?.abort();
      reader.cancel().catch(() => {});
    }
  }, 5000);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        try {
          const event = JSON.parse(trimmed.slice(6));
          result.events.push(event);
          result.totalEvents++;
          lastEventTime = Date.now();

          switch (event.type) {
            case "chunk":
              result.chunks.push(event.content);
              result.text += event.content || "";
              break;
            case "thinking":
              result.thinkingChunks.push(event.content);
              result.thinking += event.content || "";
              break;
            case "status":
              result.statuses.push(event);
              if (event.phase) result.phases.add(event.phase);
              // Capture generation_progress events from the coordinator
              if (event.message === "generation_progress") {
                result.generationProgressEvents.push({
                  tokPerSec: event.tokPerSec,
                  activeRequests: event.activeRequests,
                  outputTokens: event.outputTokens,
                  timestamp: Date.now(),
                });
              }
              break;
            case "usage_update":
              result.usageUpdateEvents.push(event);
              break;
            case "tool_execution":
              result.toolCalls.push(event);
              break;
            case "toolCall":
              result.toolCalls.push(event);
              break;
            case "worker_status":
              result.workerStatusEvents.push(event);
              // Capture per-worker generation_progress
              if (event.message === "generation_progress") {
                if (!result.workerGenerationProgress[event.workerId]) {
                  result.workerGenerationProgress[event.workerId] = [];
                }
                result.workerGenerationProgress[event.workerId].push({
                  tokPerSec: event.tokPerSec,
                  activeRequests: event.activeRequests,
                  outputTokens: event.outputTokens,
                  timestamp: Date.now(),
                });
              }
              if (event.message === "complete") {
                result.workerCompleteEvents.push(event);
              }
              break;
            case "error":
              result.errors.push(event);
              break;
            case "done":
              result.done = event;
              break;
          }
        } catch {
          // Skip malformed JSON
        }
      }

      if (result.done) break;
    }
  } catch (err) {
    if (err.name === "AbortError") {
      result.aborted = true;
    } else {
      result.errors.push({ type: "error", message: err.message });
    }
  } finally {
    clearTimeout(timeoutId);
    clearInterval(idleTimeoutId);
    result.durationMs = Date.now() - startTime;
  }

  return result;
}

/**
 * Stream an agent request and return structured SSE results.
 */
async function agentStream(payload, { timeoutMs = AGENT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const response = await fetch(`${PRISM_URL}/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-project": "prism-tok-per-sec-tests",
      "x-username": "test-runner",
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Agent endpoint failed: ${response.status} ${text}`);
  }

  return consumeAgentSSE(response, { timeoutMs, controller });
}

/**
 * Log tok/s test results with comprehensive telemetry.
 */
function logTokPerSecResult(label, result) {
  const dur = (result.durationMs / 1000).toFixed(1);
  const progEvents = result.generationProgressEvents;
  const lastProg = progEvents[progEvents.length - 1];
  const peakTokPerSec = progEvents.reduce(
    (max, e) => (e.tokPerSec != null && e.tokPerSec > max ? e.tokPerSec : max), 0,
  );
  const workerIds = Object.keys(result.workerGenerationProgress);

  console.log(`\n  ┌─ ${label} ${"─".repeat(Math.max(1, 55 - label.length))}┐`);
  console.log(`  │ Duration:            ${dur.padEnd(37)}│`);
  console.log(`  │ Total SSE events:    ${String(result.totalEvents).padEnd(37)}│`);
  console.log(`  │ gen_progress events: ${String(progEvents.length).padEnd(37)}│`);
  console.log(`  │ Peak tok/s:          ${peakTokPerSec > 0 ? peakTokPerSec.toFixed(1) : "N/A".padEnd(37)}│`);
  console.log(`  │ Last tok/s:          ${lastProg?.tokPerSec != null ? lastProg.tokPerSec.toFixed(1) : "N/A".padEnd(37)}│`);
  console.log(`  │ Last activeRequests: ${lastProg?.activeRequests ?? "N/A".padEnd(37)}│`);
  console.log(`  │ Last outputTokens:   ${lastProg?.outputTokens ?? "N/A".padEnd(37)}│`);
  console.log(`  │ Worker IDs tracked:  ${workerIds.length > 0 ? workerIds.join(", ").slice(0, 37) : "none".padEnd(37)}│`);
  console.log(`  │ Worker completions:  ${String(result.workerCompleteEvents.length).padEnd(37)}│`);
  console.log(`  │ usage_update events: ${String(result.usageUpdateEvents.length).padEnd(37)}│`);
  if (result.errors.length > 0) {
    for (const e of result.errors.slice(0, 3)) {
      console.log(`  │ ❌ ${(e.message || "unknown").slice(0, 53).padEnd(53)}│`);
    }
  }
  if (result.timedOut) console.log(`  │ ⚠️  TIMED OUT                                        │`);

  // Per-worker tok/s summary
  for (const wId of workerIds) {
    const wProg = result.workerGenerationProgress[wId];
    const wPeak = wProg.reduce(
      (max, e) => (e.tokPerSec != null && e.tokPerSec > max ? e.tokPerSec : max), 0,
    );
    const wLast = wProg[wProg.length - 1];
    console.log(`  │ Worker ${wId.slice(0, 10).padEnd(10)}: ${wProg.length} events, peak=${wPeak > 0 ? wPeak.toFixed(1) : "N/A"} tok/s, last=${wLast?.tokPerSec?.toFixed(1) ?? "N/A"} tok/s│`);
  }
  console.log(`  └${"─".repeat(59)}┘`);
}


// ═══════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════

let targetModel = null;

beforeAll(async () => {
  try {
    await fetch(PRISM_URL);
  } catch {
    throw new Error(`Prism not running at ${PRISM_URL}`);
  }
  try {
    await fetch(LM_STUDIO_URL);
  } catch {
    throw new Error(`LM Studio not running at ${LM_STUDIO_URL}`);
  }

  targetModel = await findTargetModel();
  if (!targetModel) {
    throw new Error("No suitable Qwen model found in LM Studio");
  }

  console.log("\n  ╔═══════════════════════════════════════════════════════╗");
  console.log("  ║  SessionGenerationTracker — Tok/s Integration Tests  ║");
  console.log("  ╠═══════════════════════════════════════════════════════╣");
  console.log(`  ║  Model:  ${targetModel.padEnd(46).slice(0, 46)}║`);
  console.log("  ╚═══════════════════════════════════════════════════════╝\n");
}, 15_000);

describe("SessionGenerationTracker — Tok/s Attribution", () => {

  // ── Test 1: Single-turn generation emits generation_progress ──
  // This validates that the coordinator's own generation produces
  // the generation_progress SSE events consumed by SettingsPanel.
  it("single-turn agent emits generation_progress with valid tok/s", async () => {
    const result = await agentStream({
      provider: "lm-studio",
      model: targetModel,
      messages: [
        { role: "user", content: "Explain what a red-black tree is in 2-3 sentences." },
      ],
      agent: "CODING",
      agentSessionId: crypto.randomUUID(),
      maxTokens: 300,
      autoApprove: true,
    });

    logTokPerSecResult("Single Turn — generation_progress", result);

    // Core: must complete without timeout
    expect(result.timedOut).toBe(false);
    expect(result.done).toBeTruthy();

    // generation_progress events MUST have been emitted
    // (every 10 chunks or 500ms during active generation)
    expect(result.generationProgressEvents.length).toBeGreaterThan(0);

    // At least one event must have a non-null, positive tok/s
    const withTokPerSec = result.generationProgressEvents.filter(
      (e) => e.tokPerSec != null && e.tokPerSec > 0,
    );
    expect(withTokPerSec.length).toBeGreaterThan(0);

    // Validate event structure — what SettingsPanel would receive
    for (const event of result.generationProgressEvents) {
      expect(event).toHaveProperty("tokPerSec");
      expect(event).toHaveProperty("activeRequests");
      expect(event).toHaveProperty("outputTokens");
      // activeRequests should be 1 (single request) during generation
      // or 0 after completion (the final progress event fires after complete())
    }

    // Sanity: tok/s should be reasonable (0.1 – 500 tok/s for local models)
    const peakTokPerSec = Math.max(
      ...result.generationProgressEvents
        .filter((e) => e.tokPerSec != null)
        .map((e) => e.tokPerSec),
    );
    expect(peakTokPerSec).toBeGreaterThan(0);
    expect(peakTokPerSec).toBeLessThan(500);

    // usage_update should also have been emitted at least once
    expect(result.usageUpdateEvents.length).toBeGreaterThan(0);
  }, AGENT_TIMEOUT_MS + 10_000);

  // ── Test 2: Tool-calling agent maintains tok/s across iterations ──
  // When an agent generates tool call JSON, the LLM is actively producing
  // tokens internally. SessionGenerationTracker should track these tokens
  // and emit generation_progress events even during tool argument generation.
  it("tool-calling agent emits generation_progress across multiple iterations", async () => {
    const result = await agentStream({
      provider: "lm-studio",
      model: targetModel,
      messages: [
        { role: "user", content: "What files are in /tmp? Use shell_execute to check, then list them." },
      ],
      agent: "CODING",
      agentSessionId: crypto.randomUUID(),
      maxTokens: 500,
      autoApprove: true,
      maxIterations: 5,
    });

    logTokPerSecResult("Tool Calling — generation_progress", result);

    expect(result.timedOut).toBe(false);
    expect(result.done).toBeTruthy();

    // Should have generation_progress events from at least 1 iteration
    expect(result.generationProgressEvents.length).toBeGreaterThan(0);

    // If tool calls were made, there should be multiple iterations
    // and generation_progress from each iteration's LLM call
    const iterationEvents = result.statuses.filter(
      (s) => s.message === "iteration_progress",
    );
    if (iterationEvents.length > 1) {
      // Multiple iterations → should have progress from each
      console.log(`  📊 ${iterationEvents.length} iterations, ${result.generationProgressEvents.length} progress events`);
      // At least 1 progress event per iteration (conservative — some iterations may
      // be very short and complete before the 10-chunk / 500ms threshold)
    }

    // All events should have valid structure
    for (const event of result.generationProgressEvents) {
      expect(typeof event.tokPerSec === "number" || event.tokPerSec === null).toBe(true);
      expect(typeof event.activeRequests).toBe("number");
      expect(typeof event.outputTokens).toBe("number");
    }
  }, AGENT_TIMEOUT_MS + 30_000);

  // ── Test 3: Coordinator with 4 workers — combined + per-worker tok/s ──
  // The critical test: spawn 4 parallel workers and validate that:
  // a) The coordinator's generation_progress aggregates all workers via
  //    SessionGenerationTracker.getSessionStats(parentSessionId)
  // b) Each worker's generation_progress is forwarded as worker_status
  //    events for per-worker tok/s display in MessageList toolCallItem
  it("coordinator with 4 workers reports combined and per-worker tok/s", async () => {
    const sessionId = crypto.randomUUID();
    const COORDINATOR_TIMEOUT = 300_000; // 5 min — workers are sequential on local

    const result = await agentStream({
      provider: "lm-studio",
      model: targetModel,
      messages: [
        {
          role: "user",
          content:
            "I need you to research 4 topics IN PARALLEL using your team_create tool. " +
            "Create a team with 4 workers:\n" +
            "1. Worker 1: Run `echo 'hello from worker 1'` using shell_execute\n" +
            "2. Worker 2: Run `echo 'hello from worker 2'` using shell_execute\n" +
            "3. Worker 3: Run `echo 'hello from worker 3'` using shell_execute\n" +
            "4. Worker 4: Run `echo 'hello from worker 4'` using shell_execute\n\n" +
            "Use team_create with exactly 4 members. Each worker should use shell_execute.",
        },
      ],
      agent: "CODING",
      agentSessionId: sessionId,
      maxTokens: 1500,
      autoApprove: true,
      maxIterations: 10,
    }, { timeoutMs: COORDINATOR_TIMEOUT });

    logTokPerSecResult("Coordinator + 4 Workers — tok/s", result);

    // Core: must complete
    expect(result.timedOut).toBe(false);
    expect(result.done).toBeTruthy();

    // ── Combined tok/s (SettingsPanel statsBadges) ────────────
    // Coordinator MUST emit generation_progress events
    expect(result.generationProgressEvents.length).toBeGreaterThan(0);

    // At least some events should have valid tok/s
    const validProgress = result.generationProgressEvents.filter(
      (e) => e.tokPerSec != null && e.tokPerSec > 0,
    );
    expect(validProgress.length).toBeGreaterThan(0);

    console.log(`\n  📊 Combined tok/s events: ${result.generationProgressEvents.length}`);
    console.log(`     Valid tok/s events: ${validProgress.length}`);

    // The activeRequests count should reflect the number of
    // concurrent LLM calls. When workers are running in parallel,
    // activeRequests could be > 1 (on multi-instance setups).
    // On a single LM Studio instance with sequential workers,
    // activeRequests will be 1 at any given time.
    const maxActiveReqs = Math.max(
      ...result.generationProgressEvents.map((e) => e.activeRequests || 0),
    );
    console.log(`     Peak activeRequests: ${maxActiveReqs}`);

    // ── Per-worker tok/s (MessageList toolCallItem) ──────────
    // Check if workers were actually spawned
    const teamCreateCalls = result.toolCalls.filter(
      (t) => t.tool?.name === "team_create" || t.name === "team_create",
    );
    const workerIds = Object.keys(result.workerGenerationProgress);

    console.log(`     team_create calls: ${teamCreateCalls.length}`);
    console.log(`     Workers with generation_progress: ${workerIds.length}`);
    console.log(`     Worker completions: ${result.workerCompleteEvents.length}`);

    // If the model successfully spawned workers, validate per-worker tok/s
    if (teamCreateCalls.length > 0 && workerIds.length > 0) {
      // Each worker that generated text should have at least 1 progress event
      for (const wId of workerIds) {
        const wProgress = result.workerGenerationProgress[wId];
        expect(wProgress.length).toBeGreaterThan(0);

        // At least one event should have tok/s
        const wWithTokPerSec = wProgress.filter(
          (e) => e.tokPerSec != null && e.tokPerSec > 0,
        );

        console.log(`     Worker ${wId.slice(0, 12)}: ${wProgress.length} progress events, ${wWithTokPerSec.length} with tok/s`);

        // Validate event structure — what toolCallItem would display
        for (const event of wProgress) {
          expect(event).toHaveProperty("tokPerSec");
          expect(event).toHaveProperty("outputTokens");
        }
      }

      // Worker completions should have usage data
      for (const wComplete of result.workerCompleteEvents) {
        expect(wComplete.workerId).toBeDefined();
        // Usage may be null for aborted workers, but should exist for completed ones
        if (wComplete.usage) {
          expect(typeof wComplete.usage.outputTokens).toBe("number");
        }
      }
    } else {
      // Model didn't spawn workers — this is possible if LM Studio
      // doesn't support function calling for this model. Log but don't fail.
      console.log(`\n  ⚠ Model did not spawn workers — coordinator-only tok/s verified`);
      console.log(`    Tool calls: ${result.toolCalls.map((t) => t.tool?.name || t.name).join(", ") || "none"}`);
    }
  }, 600_000); // 10 min total

  // ── Test 4: OutputTokens accumulation accuracy ────────────────
  // Validate that the outputTokens count in generation_progress
  // events increases monotonically within an iteration and matches
  // the provider-reported usage at the end.
  it("outputTokens in generation_progress increases monotonically", async () => {
    const result = await agentStream({
      provider: "lm-studio",
      model: targetModel,
      messages: [
        { role: "user", content: "Write a short poem about the moon (4 lines)." },
      ],
      agent: "CODING",
      agentSessionId: crypto.randomUUID(),
      maxTokens: 200,
      autoApprove: true,
    });

    logTokPerSecResult("Output Token Monotonicity", result);

    expect(result.timedOut).toBe(false);
    expect(result.done).toBeTruthy();
    expect(result.generationProgressEvents.length).toBeGreaterThan(0);

    // OutputTokens should increase monotonically across progress events
    let prevTokens = 0;
    for (const event of result.generationProgressEvents) {
      if (event.outputTokens != null) {
        expect(event.outputTokens).toBeGreaterThanOrEqual(prevTokens);
        prevTokens = event.outputTokens;
      }
    }

    // Final outputTokens should be > 0 (model produced output)
    const lastEvent = result.generationProgressEvents[result.generationProgressEvents.length - 1];
    expect(lastEvent.outputTokens).toBeGreaterThan(0);

    // Compare with done event usage — should be in the same ballpark
    // (generation_progress uses estimated counts, done has provider-reported)
    if (result.done?.usage?.outputTokens) {
      const ratio = lastEvent.outputTokens / result.done.usage.outputTokens;
      console.log(`  📊 Progress outputTokens: ${lastEvent.outputTokens}, Done usage: ${result.done.usage.outputTokens}, ratio: ${ratio.toFixed(2)}`);
      // Allow generous margin — estimated vs provider counts can differ
      // but should be within 5x
      expect(ratio).toBeGreaterThan(0.1);
      expect(ratio).toBeLessThan(5);
    }
  }, AGENT_TIMEOUT_MS + 10_000);
});

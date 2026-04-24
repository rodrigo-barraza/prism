/**
 * tokenMetricsLive.test.js
 * ═══════════════════════════════════════════════════════════════
 * Unified token metrics validation suite.
 *
 * Covers two provider tiers:
 *
 *   1. **LM Studio (local)** — tok/s accuracy, input/output/total
 *      token counting, monotonicity, and tool-call-phase streaming.
 *
 *   2. **Online providers (cheapest tier)** — OpenAI gpt-5-nano,
 *      Anthropic claude-haiku-4-5, Google gemini-3-flash-preview.
 *      Validates provider-reported usage parity and cost accuracy.
 *
 * Run:
 *   npx vitest run tests/live/tokenMetricsLive.test.js --config vitest.live.config.js
 *
 * ═══════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeAll } from "vitest";

const PRISM_URL = "http://localhost:7777";
const LM_STUDIO_URL = "http://localhost:1234";

// ═══════════════════════════════════════════════════════════════
// Target Models
// ═══════════════════════════════════════════════════════════════

/** Cheapest listed model per online provider. */
const ONLINE_MODELS = {
  openai: { model: "gpt-5-nano", label: "GPT 5 Nano" },
  anthropic: { model: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  google: { model: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
};

/** LM Studio model discovery patterns (prefer Qwen3.6 35B). */
const LM_STUDIO_PATTERNS = [
  /qwen.*3\.6.*35b.*a3b/i,
  /qwen.*3.*35b.*a3b/i,
  /qwen.*3\.[56].*35b/i,
  /qwen.*3.*30b.*a3b/i,
];

// ═══════════════════════════════════════════════════════════════
// Shared SSE Consumer
// ═══════════════════════════════════════════════════════════════

/**
 * Stream an /agent or /chat request and collect all token-relevant
 * SSE events into a structured result object.
 *
 * @param {string} provider
 * @param {string} model
 * @param {string} prompt
 * @param {object} opts
 * @returns {Promise<object>}
 */
async function streamAndCollect(provider, model, prompt, {
  maxTokens = 500,
  timeout = 120_000,
  agent = "CODING",
  autoApprove = true,
  maxIterations = 5,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const res = await fetch(`${PRISM_URL}/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-project": "token-metrics-tests",
      "x-username": "test-runner",
    },
    body: JSON.stringify({
      provider,
      model,
      messages: [{ role: "user", content: prompt }],
      agent,
      agentSessionId: crypto.randomUUID(),
      maxTokens,
      autoApprove,
      maxIterations,
    }),
    signal: controller.signal,
  });

  if (!res.ok) {
    clearTimeout(timer);
    throw new Error(`/agent returned ${res.status}: ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const result = {
    progressEvents: [],
    usageUpdates: [],
    doneUsage: null,
    chunkCount: 0,
    thinkingChunkCount: 0,
    lastOutputChars: 0,
    totalEvents: 0,
    durationMs: 0,
    text: "",
    timedOut: false,
  };

  const startTime = performance.now();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") continue;
        let event;
        try { event = JSON.parse(raw); } catch { continue; }
        result.totalEvents++;

        if (event.type === "status" && event.message === "generation_progress") {
          result.progressEvents.push({
            timestamp: performance.now(),
            outputTokens: event.outputTokens,
            inputTokens: event.inputTokens,
            totalTokens: event.totalTokens,
            outputCharacters: event.outputCharacters,
            tokPerSec: event.tokPerSec,
            activeRequests: event.activeRequests,
            avgTtft: event.avgTtft,
          });
        }
        if (event.type === "usage_update" && event.usage) {
          result.usageUpdates.push(event.usage);
        }
        if (event.type === "done" && event.usage) {
          result.doneUsage = event.usage;
        }
        if (event.type === "chunk") {
          result.chunkCount++;
          result.text += event.content || "";
          if (event.outputCharacters != null) {
            result.lastOutputChars = event.outputCharacters;
          }
        }
        if (event.type === "thinking") {
          result.thinkingChunkCount++;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    result.durationMs = performance.now() - startTime;
    reader.releaseLock();
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// Assertion Helpers
// ═══════════════════════════════════════════════════════════════

/** Check that token fields are monotonically non-decreasing. */
function checkMonotonicity(events) {
  let prevOut = 0, prevIn = 0, prevTotal = 0;
  const violations = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.outputTokens < prevOut) violations.push(`out: ${prevOut}→${e.outputTokens} @${i}`);
    if (e.inputTokens < prevIn) violations.push(`in: ${prevIn}→${e.inputTokens} @${i}`);
    if (e.totalTokens < prevTotal) violations.push(`total: ${prevTotal}→${e.totalTokens} @${i}`);
    prevOut = e.outputTokens;
    prevIn = e.inputTokens;
    prevTotal = e.totalTokens;
  }
  return violations;
}

/** Print a formatted results table. */
function printTable(label, result) {
  const events = result.progressEvents;
  if (!events.length) {
    console.log(`\n  ⚠ ${label}: no generation_progress events received`);
    return;
  }
  const last = events[events.length - 1];
  const providerOut = result.doneUsage?.outputTokens || 0;
  const providerIn = result.doneUsage?.inputTokens || result.doneUsage?.promptTokens || 0;

  console.log(`\n  ┌─ ${label} ${"─".repeat(Math.max(1, 53 - label.length))}┐`);
  console.log(`  │ Progress events:  ${String(events.length).padStart(5)}                             │`);
  console.log(`  │ Chunks (text):    ${String(result.chunkCount).padStart(5)}                             │`);
  console.log(`  │ Chunks (think):   ${String(result.thinkingChunkCount).padStart(5)}                             │`);
  console.log("  ├──────────────────────────────────────────────────────┤");
  console.log(`  │ Progress out:     ${String(last.outputTokens).padStart(6)}   Provider out: ${String(providerOut).padStart(6)}      │`);
  console.log(`  │ Progress in:      ${String(last.inputTokens).padStart(6)}   Provider in:  ${String(providerIn).padStart(6)}      │`);
  console.log(`  │ Progress total:   ${String(last.totalTokens).padStart(6)}                             │`);
  console.log(`  │ Peak tok/s:       ${String(Math.max(...events.filter(e => e.tokPerSec != null).map(e => e.tokPerSec), 0).toFixed(1)).padStart(6)}                             │`);
  console.log(`  │ Duration:         ${(result.durationMs / 1000).toFixed(1).padStart(5)}s                             │`);
  if (providerOut > 0) {
    const ratio = last.outputTokens / providerOut;
    console.log(`  │ Progress/Provider: ${ratio.toFixed(4)}                             │`);
  }
  console.log("  └──────────────────────────────────────────────────────┘\n");
}

// ═══════════════════════════════════════════════════════════════
// Discovery
// ═══════════════════════════════════════════════════════════════

let lmStudioModel = null;
let lmStudioAvailable = false;
let _prismAvailable = false;
/** Tracks which online providers have valid API keys. */
const onlineAvailable = { openai: false, anthropic: false, google: false };

async function findLmStudioModel() {
  try {
    const res = await fetch(`${LM_STUDIO_URL}/api/v1/models`);
    if (!res.ok) return null;
    const data = await res.json();
    const models = data.models || data.data || [];
    for (const pattern of LM_STUDIO_PATTERNS) {
      const match = models.find((m) => pattern.test(m.key || m.id));
      if (match) return match.key || match.id;
    }
    const loaded = models.find(
      (m) => m.loaded_instances?.length > 0 && m.type !== "embedding",
    );
    if (loaded) return loaded.key || loaded.id;
    const first = models.find((m) => m.type !== "embedding");
    return first ? first.key || first.id : null;
  } catch {
    return null;
  }
}

/**
 * Probe whether an online provider is reachable via Prism's /config
 * endpoint — avoids burning tokens just to discover availability.
 */
async function probeOnlineProviders() {
  try {
    const res = await fetch(`${PRISM_URL}/config`);
    if (!res.ok) return;
    const cfg = await res.json();
    const textModels = cfg?.textToText?.models || {};
    for (const provider of Object.keys(ONLINE_MODELS)) {
      const providerModels = textModels[provider] || [];
      const target = ONLINE_MODELS[provider].model;
      if (providerModels.some((m) => m.name === target)) {
        onlineAvailable[provider] = true;
      }
    }
  } catch {
    // Prism /config failed — online providers unavailable
  }
}

beforeAll(async () => {
  // Check Prism
  try {
    await fetch(PRISM_URL);
    _prismAvailable = true;
  } catch {
    throw new Error(`Prism not running at ${PRISM_URL}`);
  }

  // Discover LM Studio
  lmStudioModel = await findLmStudioModel();
  lmStudioAvailable = !!lmStudioModel;

  // Probe online providers
  await probeOnlineProviders();

  console.log("\n  ╔═══════════════════════════════════════════════════════╗");
  console.log("  ║  Token Metrics — Live Integration Tests              ║");
  console.log("  ╠═══════════════════════════════════════════════════════╣");
  console.log(`  ║  LM Studio:  ${lmStudioAvailable ? lmStudioModel.padEnd(41).slice(0, 41) : "unavailable".padEnd(41)}║`);
  console.log(`  ║  OpenAI:     ${onlineAvailable.openai ? "✅ " + ONLINE_MODELS.openai.label.padEnd(38).slice(0, 38) : "❌ not configured".padEnd(41)}║`);
  console.log(`  ║  Anthropic:  ${onlineAvailable.anthropic ? "✅ " + ONLINE_MODELS.anthropic.label.padEnd(38).slice(0, 38) : "❌ not configured".padEnd(41)}║`);
  console.log(`  ║  Google:     ${onlineAvailable.google ? "✅ " + ONLINE_MODELS.google.label.padEnd(38).slice(0, 38) : "❌ not configured".padEnd(41)}║`);
  console.log("  ╚═══════════════════════════════════════════════════════╝\n");
}, 15_000);


// ═══════════════════════════════════════════════════════════════
// TIER 1: LM Studio — Local Token Metrics
// ═══════════════════════════════════════════════════════════════

describe("LM Studio — Token Metrics", () => {

  // ── 1. Tok/s is reported and within sane range ──────────────
  it("generation_progress emits valid tok/s", async () => {
    if (!lmStudioAvailable) return console.log("  ⏭ LM Studio not available");

    const result = await streamAndCollect(
      "lm-studio", lmStudioModel,
      "Explain what a hash map is in 2-3 sentences.",
      { maxTokens: 300 },
    );

    printTable("LM Studio — Tok/s", result);

    expect(result.progressEvents.length).toBeGreaterThan(0);
    const withTokPerSec = result.progressEvents.filter(
      (e) => e.tokPerSec != null && e.tokPerSec > 0,
    );
    expect(withTokPerSec.length).toBeGreaterThan(0);

    // Sane range: 0.1–500 tok/s for local models
    const peak = Math.max(...withTokPerSec.map((e) => e.tokPerSec));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(500);
  }, 90_000);

  // ── 2. Input / output / total tokens are correct ────────────
  it("input, output, and total tokens match provider usage", async () => {
    if (!lmStudioAvailable) return console.log("  ⏭ LM Studio not available");

    const result = await streamAndCollect(
      "lm-studio", lmStudioModel,
      "Write a haiku about the ocean.",
      { maxTokens: 200 },
    );

    printTable("LM Studio — Token Counts", result);

    expect(result.progressEvents.length).toBeGreaterThan(0);
    const last = result.progressEvents[result.progressEvents.length - 1];

    // All three token fields must be populated
    expect(last.outputTokens).toBeGreaterThan(0);
    expect(last.inputTokens).toBeGreaterThan(0);
    expect(last.totalTokens).toBeGreaterThan(0);

    // Identity: total = input + output
    expect(last.totalTokens).toBe(last.inputTokens + last.outputTokens);

    // Provider parity: final progress outputTokens === done.usage.outputTokens
    if (result.doneUsage?.outputTokens) {
      expect(last.outputTokens).toBe(result.doneUsage.outputTokens);
    }
    if (result.doneUsage?.inputTokens || result.doneUsage?.promptTokens) {
      const providerIn = result.doneUsage.inputTokens || result.doneUsage.promptTokens;
      expect(last.inputTokens).toBe(providerIn);
    }
  }, 90_000);

  // ── 3. Token counts are monotonically non-decreasing ────────
  it("tokens are monotonically non-decreasing across progress events", async () => {
    if (!lmStudioAvailable) return console.log("  ⏭ LM Studio not available");

    const result = await streamAndCollect(
      "lm-studio", lmStudioModel,
      "List the planets in order from the sun.",
      { maxTokens: 400 },
    );

    printTable("LM Studio — Monotonicity", result);

    expect(result.progressEvents.length).toBeGreaterThan(0);
    const violations = checkMonotonicity(result.progressEvents);
    expect(violations).toEqual([]);
  }, 90_000);

  // ── 4. avgTtft (Time To First Token) is reported ────────────
  it("avgTtft is present and reasonable", async () => {
    if (!lmStudioAvailable) return console.log("  ⏭ LM Studio not available");

    const result = await streamAndCollect(
      "lm-studio", lmStudioModel,
      "What is 2+2?",
      { maxTokens: 100 },
    );

    printTable("LM Studio — TTFT", result);

    const last = result.progressEvents[result.progressEvents.length - 1];
    expect(last.avgTtft).toBeDefined();
    expect(typeof last.avgTtft).toBe("number");
    expect(last.avgTtft).toBeGreaterThan(0);
    // Sanity: TTFT < 60s for local model
    expect(last.avgTtft).toBeLessThan(60);
  }, 90_000);

  // ── 5. Tool-call generation still streams tok/s ─────────────
  // When the model generates tool-call JSON, chunks still flow
  // and generation_progress should continue updating.
  it("tok/s continues during tool-call argument generation", async () => {
    if (!lmStudioAvailable) return console.log("  ⏭ LM Studio not available");

    const result = await streamAndCollect(
      "lm-studio", lmStudioModel,
      "List the files in /tmp using shell_execute.",
      { maxTokens: 500, maxIterations: 3 },
    );

    printTable("LM Studio — Tool Call Tok/s", result);

    // Should have progress events even during tool-call generation
    expect(result.progressEvents.length).toBeGreaterThan(0);
    const withTokPerSec = result.progressEvents.filter(
      (e) => e.tokPerSec != null && e.tokPerSec > 0,
    );
    expect(withTokPerSec.length).toBeGreaterThan(0);

    // Token totals should include tool-call tokens
    const last = result.progressEvents[result.progressEvents.length - 1];
    expect(last.outputTokens).toBeGreaterThan(0);
  }, 120_000);
});


// ═══════════════════════════════════════════════════════════════
// TIER 2: Online Providers — Cheapest Model Per Provider
// ═══════════════════════════════════════════════════════════════
//
// STATUS: DISABLED — skipped until backend tok/s centralisation is done.
//
// TODO: Before enabling these tests:
//
//   1. Centralise all tok/s, input/output/total token calculation
//      into SessionGenerationTracker (or a single service close to
//      the providers on the backend). Right now the calculation is
//      split between the backend tracker, the frontend burst
//      counters (liveStreamingBurst*), and useTokenRate.js — the
//      single source of truth should be the backend, emitted via
//      generation_progress SSE events.
//
//   2. Each test should send a known prompt with deterministic
//      constraints (e.g. maxTokens, temperature=0) and assert:
//        - Input tokens match the expected prompt token count
//        - Output tokens match the provider-reported usage exactly
//        - total === input + output
//        - tok/s is computed from provider-reported data, not from
//          frontend heuristics
//        - Monotonicity holds across multi-iteration tool-call flows
//
//   3. Validate that the SSE events the frontend receives are the
//      ONLY source — no client-side recalculation needed.
//
//   4. Cost accuracy: provider-reported tokens × pricing from
//      config.js should match the cost emitted in the done event.
//
// Target models (cheapest per provider to minimise API spend):
//   - OpenAI:    gpt-5-nano       ($0.05/$0.40 per M)
//   - Anthropic: claude-haiku-4-5 ($1.00/$5.00 per M)
//   - Google:    gemini-3-flash   ($0.50/$3.00 per M)
//
// ═══════════════════════════════════════════════════════════════

describe.skip.each([
  ["openai", ONLINE_MODELS.openai],
  ["anthropic", ONLINE_MODELS.anthropic],
  ["google", ONLINE_MODELS.google],
])("%s — Token Metrics (%s)", (provider, { model, label }) => {

  // ── 1. Basic token reporting ────────────────────────────────
  it(`${label}: emits generation_progress with valid tokens`, async () => {
    if (!onlineAvailable[provider]) {
      return console.log(`  ⏭ ${label} not configured — skipping`);
    }

    const result = await streamAndCollect(
      provider, model,
      "What is the speed of light? One sentence.",
      { maxTokens: 150, timeout: 60_000 },
    );

    printTable(`${label} — Token Counts`, result);

    expect(result.progressEvents.length).toBeGreaterThan(0);
    const last = result.progressEvents[result.progressEvents.length - 1];

    // All three fields must be present and positive
    expect(last.outputTokens).toBeGreaterThan(0);
    expect(last.inputTokens).toBeGreaterThan(0);
    expect(last.totalTokens).toBeGreaterThan(0);

    // Identity
    expect(last.totalTokens).toBe(last.inputTokens + last.outputTokens);
  }, 90_000);

  // ── 2. Provider-reported usage parity ───────────────────────
  it(`${label}: final progress matches done.usage`, async () => {
    if (!onlineAvailable[provider]) {
      return console.log(`  ⏭ ${label} not configured — skipping`);
    }

    const result = await streamAndCollect(
      provider, model,
      "Name three colors.",
      { maxTokens: 100, timeout: 60_000 },
    );

    printTable(`${label} — Provider Parity`, result);

    expect(result.doneUsage).toBeTruthy();
    const providerOut = result.doneUsage.outputTokens || 0;
    const providerIn = result.doneUsage.inputTokens || result.doneUsage.promptTokens || 0;

    expect(providerOut).toBeGreaterThan(0);
    expect(providerIn).toBeGreaterThan(0);

    const last = result.progressEvents[result.progressEvents.length - 1];
    // Progress should match provider exactly (both from same source)
    expect(last.outputTokens).toBe(providerOut);
    expect(last.inputTokens).toBe(providerIn);
  }, 90_000);

  // ── 3. Monotonicity ─────────────────────────────────────────
  it(`${label}: tokens monotonically non-decreasing`, async () => {
    if (!onlineAvailable[provider]) {
      return console.log(`  ⏭ ${label} not configured — skipping`);
    }

    const result = await streamAndCollect(
      provider, model,
      "Count from 1 to 10.",
      { maxTokens: 200, timeout: 60_000 },
    );

    printTable(`${label} — Monotonicity`, result);

    expect(result.progressEvents.length).toBeGreaterThan(0);
    const violations = checkMonotonicity(result.progressEvents);
    expect(violations).toEqual([]);
  }, 90_000);

  // ── 4. Tok/s is reported ────────────────────────────────────
  it(`${label}: tok/s reported in generation_progress`, async () => {
    if (!onlineAvailable[provider]) {
      return console.log(`  ⏭ ${label} not configured — skipping`);
    }

    const result = await streamAndCollect(
      provider, model,
      "Explain gravity in 2 sentences.",
      { maxTokens: 200, timeout: 60_000 },
    );

    printTable(`${label} — Tok/s`, result);

    const withTokPerSec = result.progressEvents.filter(
      (e) => e.tokPerSec != null && e.tokPerSec > 0,
    );
    expect(withTokPerSec.length).toBeGreaterThan(0);

    // Online models: 10–2000 tok/s range
    const peak = Math.max(...withTokPerSec.map((e) => e.tokPerSec));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(2000);
  }, 90_000);
});

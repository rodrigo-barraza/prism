#!/usr/bin/env node
// ============================================================
// Token Calculation Verification Test
// ============================================================
// Sends real agentic requests to Prism → LM Studio (Qwen3.6 35B),
// captures all SSE events, simulates frontend message-building,
// then verifies getSessionTokenStats + getTotalInputTokens match
// the authoritative provider-reported usage from the `done` event.
//
// Usage:
//   node tests/token-calc-verification.js
// ============================================================

const PRISM_URL = "http://localhost:7777";
const PROJECT = "retina";
const PROVIDER = "lm-studio";
const MODEL = "qwen3.6-35b-a3b";

// ── Import the functions we're testing ────────────────────────
// Copy-pasted from retina/src/utils/utilities.js to avoid ESM issues.

function getTotalInputTokens(usage) {
  if (!usage) return 0;
  return (
    (usage.inputTokens || 0) +
    (usage.cacheReadInputTokens || 0) +
    (usage.cacheCreationInputTokens || 0)
  );
}

function getSessionTokenStats(messages) {
  let input = 0;
  let output = 0;
  let requests = 0;
  let liveStreamingTokens = 0;

  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (m.usage) {
      requests += m.usage.requests || 1;
      input += getTotalInputTokens(m.usage);
      output += m.usage.outputTokens || 0;
    } else if (m._streamingOutputTokens > 0) {
      output += m._streamingOutputTokens;
      liveStreamingTokens = m._streamingOutputTokens;
    }
    if (m._workerGenerationProgress) {
      for (const wp of Object.values(m._workerGenerationProgress)) {
        if (wp.outputTokens > 0) {
          output += wp.outputTokens;
        }
      }
    }
    if (m._workerTokens) {
      input += m._workerTokens.input || 0;
      output += m._workerTokens.output || 0;
      requests += m._workerTokens.requests || 0;
    }
  }
  return {
    totalTokens: { input, output, total: input + output },
    requestCount: requests,
    liveStreamingTokens,
  };
}

// ── Helpers ──────────────────────────────────────────────────

const SEP = "═".repeat(70);
const THIN = "─".repeat(70);
let totalPassed = 0;
let totalFailed = 0;

function log(icon, msg) {
  console.log(`  ${icon}  ${msg}`);
}

function logSection(title) {
  console.log(`\n${THIN}`);
  console.log(`  ${title}`);
  console.log(THIN);
}

function passFail(label, actual, expected) {
  const ok = actual === expected;
  const icon = ok ? "✅" : "❌";
  console.log(`  ${icon}  ${label}: ${actual} ${ok ? "==" : "!="} ${expected}${ok ? "" : " ← MISMATCH"}`);
  if (ok) totalPassed++; else totalFailed++;
  return ok;
}

// ── SSE Stream Consumer ─────────────────────────────────────

async function streamAgentRequest(prompt, options = {}) {
  const sessionId = options.sessionId || `token-test-${Date.now()}`;
  const payload = {
    provider: PROVIDER,
    model: MODEL,
    messages: [
      { role: "system", content: "" },
      { role: "user", content: prompt },
    ],
    functionCallingEnabled: true,
    enabledTools: options.enabledTools || ["read_file", "write_file", "list_dir", "run_command"],
    maxTokens: options.maxTokens || 2048,
    temperature: options.temperature ?? 0.7,
    thinkingEnabled: true,
    project: PROJECT,
    agentSessionId: sessionId,
    conversationMeta: { title: options.title || "Token Verification Test" },
    agent: options.agent || "CODING",
    autoApprove: true,
    planFirst: false,
    maxIterations: options.maxIterations || 5,
    ...(options.maxWorkerIterations != null && { maxWorkerIterations: options.maxWorkerIterations }),
  };

  const res = await fetch(`${PRISM_URL}/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-project": PROJECT,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  // Parse SSE stream
  const events = [];
  let chunkCount = 0;
  let thinkingChunkCount = 0;
  const toolExecutions = [];
  let doneEvent = null;
  const statusEvents = [];
  const workerStatusEvents = [];
  const workerCompleteEvents = [];
  const workerProgressEvents = [];

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const json = line.slice(6);
      if (!json) continue;
      try {
        const data = JSON.parse(json);
        events.push(data);

        switch (data.type) {
          case "chunk":
            chunkCount++;
            break;
          case "thinking":
            thinkingChunkCount++;
            break;
          case "tool_execution":
            toolExecutions.push(data);
            break;
          case "worker_status":
            workerStatusEvents.push(data);
            if (data.message === "complete") workerCompleteEvents.push(data);
            if (data.message === "generation_progress") workerProgressEvents.push(data);
            break;
          case "error":
            console.error(`  ❌  SSE error: ${data.message || JSON.stringify(data)}`);
            break;
          case "status":
            statusEvents.push(data);
            break;
          case "done":
            doneEvent = data;
            break;
        }
      } catch { /* skip malformed */ }
    }
  }

  return {
    events, chunkCount, thinkingChunkCount, toolExecutions,
    doneEvent, statusEvents, workerStatusEvents, workerCompleteEvents, workerProgressEvents,
    sessionId,
  };
}

// ── Test: Single-Agent Flow ─────────────────────────────────

async function testSingleAgentFlow() {
  logSection("PART A: SINGLE-AGENT AGENTIC FLOW");

  log("📤", `Prompt: "List the contents of the current directory. Then tell me what files you see, in a short sentence."`);
  log("⏳", "Streaming SSE response...\n");

  const result = await streamAgentRequest(
    "List the contents of the current directory. Then tell me what files you see, in a short sentence.",
    { maxIterations: 3, title: "Single Agent Token Test" },
  );

  const { chunkCount, thinkingChunkCount, toolExecutions, doneEvent, statusEvents } = result;

  logSection("A1. SSE Event Summary");
  log("📊", `Total SSE events: ${result.events.length}`);
  log("💬", `Text chunks: ${chunkCount}`);
  log("🧠", `Thinking chunks: ${thinkingChunkCount}`);
  log("🔧", `Tool executions: ${toolExecutions.length}`);
  log("📡", `Status events: ${statusEvents.length}`);
  log(doneEvent ? "✅" : "❌", `Done event: ${doneEvent ? "received" : "MISSING"}`);

  if (!doneEvent) {
    console.error("\n❌ No done event received — cannot verify tokens.");
    return;
  }

  const providerUsage = doneEvent.usage;

  logSection("A2. Provider-Reported Usage");
  log("📥", `inputTokens:             ${providerUsage.inputTokens}`);
  log("📤", `outputTokens:            ${providerUsage.outputTokens}`);
  log("🔄", `requests (iterations):   ${providerUsage.requests}`);
  log("⚡", `tokensPerSec:            ${doneEvent.tokensPerSec || "N/A"}`);

  // Test getTotalInputTokens
  logSection("A3. getTotalInputTokens()");
  const totalIn = getTotalInputTokens(providerUsage);
  passFail("getTotalInputTokens(providerUsage)", totalIn, (providerUsage.inputTokens || 0) + (providerUsage.cacheReadInputTokens || 0) + (providerUsage.cacheCreationInputTokens || 0));
  passFail("null safety", getTotalInputTokens(null), 0);
  passFail("empty object", getTotalInputTokens({}), 0);
  passFail("inputTokens only", getTotalInputTokens({ inputTokens: 100 }), 100);
  passFail("input + cacheRead + cacheWrite", getTotalInputTokens({ inputTokens: 100, cacheReadInputTokens: 50, cacheCreationInputTokens: 25 }), 175);

  // Test finalized stats
  logSection("A4. getSessionTokenStats() — Finalized");
  const userMsg = { role: "user", content: "test" };
  const finalizedMsg = { role: "assistant", content: "text", usage: providerUsage };
  const stats = getSessionTokenStats([userMsg, finalizedMsg]);

  passFail("input tokens", stats.totalTokens.input, getTotalInputTokens(providerUsage));
  passFail("output tokens", stats.totalTokens.output, providerUsage.outputTokens || 0);
  passFail("request count", stats.requestCount, providerUsage.requests || 1);
  passFail("liveStreamingTokens = 0 (finalized)", stats.liveStreamingTokens, 0);

  // Test streaming stats (simulating fixed behavior: text + thinking counted)
  logSection("A5. getSessionTokenStats() — Streaming (in-flight)");
  const allChunks = chunkCount + thinkingChunkCount;
  const streamMsg = { role: "assistant", content: "", _streamingOutputTokens: allChunks };
  const streamStats = getSessionTokenStats([userMsg, streamMsg]);

  passFail("output = text + thinking chunks", streamStats.totalTokens.output, allChunks);
  passFail("liveStreamingTokens = all chunks", streamStats.liveStreamingTokens, allChunks);
  passFail("input = 0 (no usage)", streamStats.totalTokens.input, 0);

  // Mutual exclusion
  logSection("A6. Mutual Exclusion (streaming → finalized)");
  const transitionMsg = { role: "assistant", content: "", usage: providerUsage, _streamingOutputTokens: 9999 };
  const transitionStats = getSessionTokenStats([userMsg, transitionMsg]);
  passFail("usage overrides stale _streamingOutputTokens", transitionStats.totalTokens.output, providerUsage.outputTokens || 0);
  passFail("liveStreamingTokens = 0", transitionStats.liveStreamingTokens, 0);

  // Heuristic accuracy
  logSection("A7. Heuristic Accuracy");
  const accuracy = (providerUsage.outputTokens || 0) > 0
    ? ((allChunks / providerUsage.outputTokens) * 100).toFixed(1)
    : "N/A";
  log("📊", `Provider output tokens: ${providerUsage.outputTokens}`);
  log("📊", `Total chunks (text + thinking): ${allChunks}`);
  log("📊", `Heuristic accuracy: ${accuracy}%`);

  return providerUsage;
}

// ── Test: Coordinator + Worker Flow ─────────────────────────

async function testCoordinatorFlow() {
  logSection("PART B: COORDINATOR + WORKER AGENTIC FLOW");

  const prompt = `You MUST delegate this work by calling team_create with exactly 2 workers:
- Worker 1: "List files in /tmp and report what you find"
- Worker 2: "Run 'echo hello world' and report the output"
Do NOT do the work yourself. Use team_create immediately.`;

  log("📤", `Prompt: delegate to 2 workers`);
  log("⏳", "Streaming coordinator + worker SSE response...\n");

  const result = await streamAgentRequest(prompt, {
    maxIterations: 10,
    maxWorkerIterations: 3,
    title: "Coordinator Token Test",
    enabledTools: [
      "read_file", "write_file", "list_dir", "run_command",
      "team_create", "send_message", "stop_agent",
    ],
  });

  const {
    chunkCount, thinkingChunkCount, toolExecutions,
    doneEvent, statusEvents,
    workerStatusEvents, workerCompleteEvents, workerProgressEvents,
  } = result;

  logSection("B1. SSE Event Summary");
  log("📊", `Total SSE events: ${result.events.length}`);
  log("💬", `Text chunks: ${chunkCount}`);
  log("🧠", `Thinking chunks: ${thinkingChunkCount}`);
  log("🔧", `Tool executions: ${toolExecutions.length}`);
  log("📡", `Status events: ${statusEvents.length}`);
  log("👷", `Worker status events: ${workerStatusEvents.length}`);
  log("👷", `  ↳ generation_progress: ${workerProgressEvents.length}`);
  log("👷", `  ↳ complete: ${workerCompleteEvents.length}`);
  log(doneEvent ? "✅" : "❌", `Done event: ${doneEvent ? "received" : "MISSING"}`);

  if (!doneEvent) {
    console.error("\n❌ No done event received — cannot verify coordinator tokens.");
    return;
  }

  const providerUsage = doneEvent.usage;

  logSection("B2. Provider-Reported Usage (coordinator aggregate)");
  log("📥", `inputTokens:             ${providerUsage.inputTokens}`);
  log("📤", `outputTokens:            ${providerUsage.outputTokens}`);
  log("🔄", `requests (iterations):   ${providerUsage.requests}`);
  log("⚡", `tokensPerSec:            ${doneEvent.tokensPerSec || "N/A"}`);
  log("⏱️", `totalTime:               ${doneEvent.totalTime}s`);

  // ── Simulate frontend worker token accumulation ──
  logSection("B3. Worker Token Accumulation (simulating frontend)");

  // Track unique workers
  const workerIds = new Set();
  for (const ev of workerStatusEvents) {
    if (ev.workerId) workerIds.add(ev.workerId);
  }
  log("👷", `Unique workers: ${workerIds.size} — [${[...workerIds].join(", ")}]`);

  // Simulate _workerTokens accumulation (what AgentComponent does on worker_status complete)
  const simulatedWorkerTokens = { input: 0, output: 0, requests: 0 };
  for (const ev of workerCompleteEvents) {
    if (ev.usage) {
      simulatedWorkerTokens.input += ev.usage.inputTokens || 0;
      simulatedWorkerTokens.output += ev.usage.outputTokens || 0;
      simulatedWorkerTokens.requests += ev.usage.requests || 1;
      log("📦", `Worker ${ev.workerId} complete: in=${ev.usage.inputTokens}, out=${ev.usage.outputTokens}, reqs=${ev.usage.requests || 1}`);
    }
  }

  log("📊", `Total worker tokens: in=${simulatedWorkerTokens.input}, out=${simulatedWorkerTokens.output}, reqs=${simulatedWorkerTokens.requests}`);

  // ── Test: finalized message with worker tokens ──
  logSection("B4. getSessionTokenStats() — Finalized with Workers");
  const userMsg = { role: "user", content: "test" };
  const coordMsg = {
    role: "assistant",
    content: "coordination text",
    usage: providerUsage,
    _workerTokens: simulatedWorkerTokens,
  };
  const stats = getSessionTokenStats([userMsg, coordMsg]);

  const expectedInput = getTotalInputTokens(providerUsage) + simulatedWorkerTokens.input;
  const expectedOutput = (providerUsage.outputTokens || 0) + simulatedWorkerTokens.output;
  const expectedRequests = (providerUsage.requests || 1) + simulatedWorkerTokens.requests;

  log("📊", `Expected: in=${expectedInput}, out=${expectedOutput}, reqs=${expectedRequests}`);
  log("📊", `Got:      in=${stats.totalTokens.input}, out=${stats.totalTokens.output}, reqs=${stats.requestCount}`);

  passFail("input = coordinator + workers", stats.totalTokens.input, expectedInput);
  passFail("output = coordinator + workers", stats.totalTokens.output, expectedOutput);
  passFail("total = input + output", stats.totalTokens.total, expectedInput + expectedOutput);
  passFail("requests = coordinator + workers", stats.requestCount, expectedRequests);

  // ── Test: in-flight with live worker generation progress ──
  logSection("B5. getSessionTokenStats() — Streaming with Live Workers");

  // Get the last generation_progress per worker (simulating what the frontend sees mid-stream)
  const latestProgress = {};
  for (const ev of workerProgressEvents) {
    latestProgress[ev.workerId] = {
      outputTokens: ev.outputTokens || 0,
      firstChunkTime: ev.firstChunkTime || 0,
      lastChunkTime: ev.lastChunkTime || 0,
    };
  }

  const coordStreamTokens = chunkCount + thinkingChunkCount;
  let expectedLiveWorkerOutput = 0;
  for (const wp of Object.values(latestProgress)) {
    expectedLiveWorkerOutput += wp.outputTokens || 0;
  }

  const liveMsg = {
    role: "assistant",
    content: "",
    _streamingOutputTokens: coordStreamTokens,
    _workerGenerationProgress: Object.keys(latestProgress).length > 0 ? latestProgress : undefined,
  };
  const liveStats = getSessionTokenStats([userMsg, liveMsg]);

  log("📊", `Coordinator streaming tokens: ${coordStreamTokens}`);
  log("📊", `Live worker progress tokens: ${expectedLiveWorkerOutput}`);
  log("📊", `Workers with progress: ${Object.keys(latestProgress).length}`);
  for (const [wid, wp] of Object.entries(latestProgress)) {
    log("  👷", `${wid}: ${wp.outputTokens} tokens`);
  }

  passFail(
    "output = coord streaming + live worker progress",
    liveStats.totalTokens.output,
    coordStreamTokens + expectedLiveWorkerOutput,
  );

  // ── Test: transition from live progress → completed workers ──
  logSection("B6. Worker Progress → Completion (no double-count)");

  // Simulate: all workers completed, progress cleared, workerTokens populated
  const postCompleteMsg = {
    role: "assistant",
    content: "",
    _streamingOutputTokens: coordStreamTokens,
    _workerTokens: simulatedWorkerTokens,
    // No _workerGenerationProgress — cleared on completion
  };
  const postStats = getSessionTokenStats([userMsg, postCompleteMsg]);

  passFail(
    "output = coord streaming + completed worker tokens",
    postStats.totalTokens.output,
    coordStreamTokens + simulatedWorkerTokens.output,
  );
  passFail(
    "input = completed worker input (no coord input during streaming)",
    postStats.totalTokens.input,
    simulatedWorkerTokens.input,
  );
  passFail(
    "requests = completed worker requests",
    postStats.requestCount,
    simulatedWorkerTokens.requests,
  );

  return { providerUsage, simulatedWorkerTokens };
}

// ── Test: Pure Unit Tests (no network) ──────────────────────

function testPureUnitTests() {
  logSection("PART C: PURE UNIT TESTS (no network)");

  // Multi-request session simulation
  logSection("C1. Multi-Request Session");
  const multiMessages = [
    { role: "user", content: "do something" },
    { role: "assistant", content: "read", usage: { inputTokens: 5000, outputTokens: 200 } },
    { role: "tool", content: "file" },
    { role: "assistant", content: "write", usage: { inputTokens: 6000, outputTokens: 300 } },
    { role: "tool", content: "ok" },
    { role: "assistant", content: "done", usage: { inputTokens: 7000, outputTokens: 150, requests: 1 } },
  ];
  const multiStats = getSessionTokenStats(multiMessages);
  passFail("input = 5000+6000+7000", multiStats.totalTokens.input, 18000);
  passFail("output = 200+300+150", multiStats.totalTokens.output, 650);
  passFail("total = 18650", multiStats.totalTokens.total, 18650);
  passFail("requests = 3", multiStats.requestCount, 3);

  // Worker accumulation unit test
  logSection("C2. Worker Token Accumulation");
  const workerMsg = {
    role: "assistant", content: "coord",
    usage: { inputTokens: 1000, outputTokens: 200 },
    _workerTokens: { input: 5000, output: 800, requests: 3 },
  };
  const wStats = getSessionTokenStats([{ role: "user", content: "" }, workerMsg]);
  passFail("input = coord(1000) + workers(5000)", wStats.totalTokens.input, 6000);
  passFail("output = coord(200) + workers(800)", wStats.totalTokens.output, 1000);
  passFail("requests = coord(1) + workers(3)", wStats.requestCount, 4);

  // Live worker progress + completed workers (no double-count)
  logSection("C3. Live Progress + Completed Workers (no double-count)");
  const mixedMsg = {
    role: "assistant", content: "",
    _streamingOutputTokens: 50,
    _workerTokens: { input: 2000, output: 120, requests: 1 },
    _workerGenerationProgress: {
      "worker-2": { outputTokens: 80, firstChunkTime: 110, lastChunkTime: 190 },
    },
  };
  const mixedStats = getSessionTokenStats([{ role: "user", content: "" }, mixedMsg]);
  passFail("output = streaming(50) + completed(120) + live(80)", mixedStats.totalTokens.output, 250);
  passFail("input = completed workers only", mixedStats.totalTokens.input, 2000);
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log(SEP);
  console.log("  🧪 TOKEN CALCULATION VERIFICATION TEST");
  console.log(`  Provider: ${PROVIDER} | Model: ${MODEL}`);
  console.log(SEP);

  // Part A: Single-agent agentic flow
  await testSingleAgentFlow();

  // Part B: Coordinator + worker flow
  await testCoordinatorFlow();

  // Part C: Pure unit tests
  testPureUnitTests();

  // ── Summary ───────────────────────────────────────────────
  console.log(`\n${SEP}`);
  if (totalFailed === 0) {
    console.log(`  ✅ ALL ${totalPassed} ASSERTIONS PASSED`);
  } else {
    console.log(`  ❌ ${totalFailed} FAILED / ${totalPassed + totalFailed} TOTAL`);
  }
  console.log(SEP);

  if (totalFailed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});

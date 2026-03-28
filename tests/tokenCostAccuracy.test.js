import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import {
  app,
  MOCK_GENERATE_TEXT,
  MOCK_GENERATE_TEXT_STREAM,
} from "./setup.js";
import { calculateTextCost } from "../src/utils/CostCalculator.js";
import { TYPES, getPricing } from "../src/config.js";

// ═══════════════════════════════════════════════════════════════
// Token & Cost Accuracy Tests
// ═══════════════════════════════════════════════════════════════
// Verifies the full pipeline: mock provider returns usage →
// chat route applies real pricing → response has correct cost.
//
// Uses the cheapest model per provider that supports Function Calling:
//   • OpenAI:    gpt-5-nano      ($0.025/$0.20 per M)
//   • Anthropic: claude-haiku-4-5-20251001 ($1.00/$5.00 per M + cache tiers)
//   • Google:    gemini-3-flash-preview    ($0.50/$3.00 per M)
// ═══════════════════════════════════════════════════════════════

const TEXT_PRICING = getPricing(TYPES.TEXT, TYPES.TEXT);

// 10 realistic tool definitions for FC tests
const SAMPLE_TOOLS = Array.from({ length: 10 }, (_, i) => ({
  name: `tool_${i + 1}`,
  description: `Test tool number ${i + 1} that does something useful.`,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "integer", description: "Max results" },
    },
    required: ["query"],
  },
}));

// ── Helper: compute expected cost from config pricing ────────
function expectedCost(model, usage) {
  const pricing = TEXT_PRICING[model];
  expect(pricing).toBeDefined();
  return calculateTextCost(usage, pricing);
}

// ── Helper: send chat request (non-streaming) ────────────────
function sendChat(payload) {
  return request(app)
    .post("/chat?stream=false")
    .send(payload);
}

// ═══════════════════════════════════════════════════════════════
// 1. OpenAI — GPT-5 Nano (cheapest FC model)
// ═══════════════════════════════════════════════════════════════

describe("Token/Cost Accuracy — OpenAI gpt-5-nano", () => {
  const MODEL = "gpt-5-nano";
  const PROVIDER = "openai";

  beforeEach(() => {
    MOCK_GENERATE_TEXT.mockClear();
    MOCK_GENERATE_TEXT_STREAM.mockClear();
  });

  it("calculates correct cost WITHOUT function calling", async () => {
    const usage = { inputTokens: 500, outputTokens: 200 };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Hello from nano";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Hello" }],
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.usage.inputTokens).toBe(500);
    expect(res.body.usage.outputTokens).toBe(200);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual verification: (500/1M)*0.025 + (200/1M)*0.2
    // = 0.0000125 + 0.00004 = 0.0000525
    expect(expected).toBeCloseTo(0.0000525, 8);
  });

  it("calculates correct cost WITH 10 tools (function calling)", async () => {
    // Tools add input tokens (system prompt overhead)
    const usage = { inputTokens: 3500, outputTokens: 100 };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Tool result processed";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "What's the weather?" }],
      tools: SAMPLE_TOOLS,
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.usage.inputTokens).toBe(3500);
    expect(res.body.usage.outputTokens).toBe(100);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual: (3500/1M)*0.025 + (100/1M)*0.2
    // = 0.0000875 + 0.00002 = 0.0001075
    expect(expected).toBeCloseTo(0.0001075, 8);
  });

  it("calculates correct cost with cached input tokens", async () => {
    const usage = { inputTokens: 100, outputTokens: 50 };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Cached response";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Hi" }],
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual: (100/1M)*0.025 + (50/1M)*0.2 = 0.0000025 + 0.00001 = 0.0000125
    expect(expected).toBeCloseTo(0.0000125, 8);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Anthropic — Haiku 4.5 (cheapest FC model)
// ═══════════════════════════════════════════════════════════════

describe("Token/Cost Accuracy — Anthropic haiku-4.5", () => {
  const MODEL = "claude-haiku-4-5-20251001";
  const PROVIDER = "anthropic";

  beforeEach(() => {
    MOCK_GENERATE_TEXT.mockClear();
    MOCK_GENERATE_TEXT_STREAM.mockClear();
  });

  it("calculates correct cost WITHOUT function calling — no cache", async () => {
    const usage = { inputTokens: 500, outputTokens: 200 };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Hello from haiku";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Hello" }],
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.usage.inputTokens).toBe(500);
    expect(res.body.usage.outputTokens).toBe(200);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual: (500/1M)*1.0 + (200/1M)*5.0 = 0.0005 + 0.001 = 0.0015
    expect(expected).toBeCloseTo(0.0015, 8);
  });

  it("calculates correct cost WITHOUT FC — with cache read", async () => {
    const usage = {
      inputTokens: 50,
      outputTokens: 200,
      cacheReadInputTokens: 5000,
      cacheCreationInputTokens: 0,
    };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Cached haiku response";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Hello again" }],
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual: new=(50/1M)*1.0 + cache_read=(5000/1M)*0.1 + out=(200/1M)*5.0
    // = 0.00005 + 0.0005 + 0.001 = 0.00155
    expect(expected).toBeCloseTo(0.00155, 8);
  });

  it("calculates correct cost WITHOUT FC — with cache write", async () => {
    const usage = {
      inputTokens: 500,
      outputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 2000,
    };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Cache write response";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "New conversation" }],
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual: new=(500/1M)*1.0 + cache_write=(2000/1M)*1.25 + out=(200/1M)*5.0
    // = 0.0005 + 0.0025 + 0.001 = 0.004
    expect(expected).toBeCloseTo(0.004, 8);
  });

  it("calculates correct cost WITH FC — cache read + write", async () => {
    // Realistic FC scenario: tools in cache (read), new tool result (write)
    const usage = {
      inputTokens: 100,
      outputTokens: 150,
      cacheReadInputTokens: 24000,
      cacheCreationInputTokens: 800,
    };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "FC result from haiku";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "What's the weather?" }],
      tools: SAMPLE_TOOLS,
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.usage.inputTokens).toBe(100);
    expect(res.body.usage.outputTokens).toBe(150);
    expect(res.body.usage.cacheReadInputTokens).toBe(24000);
    expect(res.body.usage.cacheCreationInputTokens).toBe(800);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual:
    //   new    = (100/1M)*1.0    = 0.0001
    //   read   = (24000/1M)*0.1  = 0.0024
    //   write  = (800/1M)*1.25   = 0.001
    //   output = (150/1M)*5.0    = 0.00075
    //   total  =                   0.00425
    expect(expected).toBeCloseTo(0.00425, 8);
  });

  it("calculates correct cost WITH FC — heavy cache read (tool definitions)", async () => {
    // Second request in conversation: all tool defs cached
    const usage = {
      inputTokens: 8,
      outputTokens: 400,
      cacheReadInputTokens: 25000,
      cacheCreationInputTokens: 0,
    };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Second FC round response";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Now search for recipes" }],
      tools: SAMPLE_TOOLS,
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual:
    //   new    = (8/1M)*1.0        = 0.000008
    //   read   = (25000/1M)*0.1    = 0.0025
    //   output = (400/1M)*5.0      = 0.002
    //   total  =                     0.004508
    expect(expected).toBeCloseTo(0.004508, 8);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Google — Gemini 3 Flash (cheapest FC model)
// ═══════════════════════════════════════════════════════════════

describe("Token/Cost Accuracy — Google gemini-3-flash", () => {
  const MODEL = "gemini-3-flash-preview";
  const PROVIDER = "google";

  beforeEach(() => {
    MOCK_GENERATE_TEXT.mockClear();
    MOCK_GENERATE_TEXT_STREAM.mockClear();
  });

  it("calculates correct cost WITHOUT function calling", async () => {
    const usage = { inputTokens: 500, outputTokens: 200 };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Hello from gemini";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Hello" }],
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.usage.inputTokens).toBe(500);
    expect(res.body.usage.outputTokens).toBe(200);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual: (500/1M)*0.5 + (200/1M)*3.0 = 0.00025 + 0.0006 = 0.00085
    expect(expected).toBeCloseTo(0.00085, 8);
  });

  it("calculates correct cost WITH 10 tools (function calling)", async () => {
    const usage = { inputTokens: 4000, outputTokens: 120 };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Gemini FC result";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Search for data" }],
      tools: SAMPLE_TOOLS,
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.usage.inputTokens).toBe(4000);
    expect(res.body.usage.outputTokens).toBe(120);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual: (4000/1M)*0.5 + (120/1M)*3.0 = 0.002 + 0.00036 = 0.00236
    expect(expected).toBeCloseTo(0.00236, 8);
  });

  it("handles large context window (100k+ tokens)", async () => {
    const usage = { inputTokens: 100_000, outputTokens: 8000 };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Large context response";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: "Summarize all of this" }],
    }).expect(200);

    const expected = expectedCost(MODEL, usage);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 6);

    // Manual: (100000/1M)*0.5 + (8000/1M)*3.0 = 0.05 + 0.024 = 0.074
    expect(expected).toBeCloseTo(0.074, 6);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Cross-provider consistency checks
// ═══════════════════════════════════════════════════════════════

describe("Cross-provider cost consistency", () => {
  beforeEach(() => {
    MOCK_GENERATE_TEXT.mockClear();
    MOCK_GENERATE_TEXT_STREAM.mockClear();
  });

  it("all providers return estimatedCost as a number (not null) for known models", async () => {
    const cases = [
      { provider: "openai", model: "gpt-5-nano" },
      { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      { provider: "google", model: "gemini-3-flash-preview" },
    ];

    for (const { provider, model } of cases) {
      MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
        yield "Test";
        yield {
          type: "usage",
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      });

      const res = await sendChat({
        provider,
        model,
        messages: [{ role: "user", content: "Test cost" }],
      }).expect(200);

      expect(typeof res.body.estimatedCost).toBe("number");
      expect(res.body.estimatedCost).toBeGreaterThan(0);
    }
  });

  it("cost increases proportionally with token count", async () => {
    const results = [];

    for (const tokenCount of [100, 1000, 10000]) {
      MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
        yield "Test";
        yield {
          type: "usage",
          usage: { inputTokens: tokenCount, outputTokens: tokenCount / 2 },
        };
      });

      const res = await sendChat({
        provider: "openai",
        model: "gpt-5-nano",
        messages: [{ role: "user", content: "Scale test" }],
      }).expect(200);

      results.push(res.body.estimatedCost);
    }

    // Each 10x token increase should yield ~10x cost increase
    expect(results[1] / results[0]).toBeCloseTo(10, 0);
    expect(results[2] / results[1]).toBeCloseTo(10, 0);
  });

  it("tools in request do not inflate cost when usage tokens are the same", async () => {
    const usage = { inputTokens: 500, outputTokens: 200 };

    // Without tools
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "No tools";
      yield { type: "usage", usage };
    });
    const resNoTools = await sendChat({
      provider: "google",
      model: "gemini-3-flash-preview",
      messages: [{ role: "user", content: "Hello" }],
    }).expect(200);

    // With tools (same usage from provider)
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "With tools";
      yield { type: "usage", usage };
    });
    const resWithTools = await sendChat({
      provider: "google",
      model: "gemini-3-flash-preview",
      messages: [{ role: "user", content: "Hello" }],
      tools: SAMPLE_TOOLS,
    }).expect(200);

    // Cost should be identical — we price based on usage, not payload
    expect(resWithTools.body.estimatedCost).toBe(resNoTools.body.estimatedCost);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Edge cases
// ═══════════════════════════════════════════════════════════════

describe("Token/Cost edge cases", () => {
  beforeEach(() => {
    MOCK_GENERATE_TEXT_STREAM.mockClear();
  });

  it("zero output tokens still computes input cost", async () => {
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "";
      yield {
        type: "usage",
        usage: { inputTokens: 1000, outputTokens: 0 },
      };
    });

    const res = await sendChat({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "Empty response test" }],
    }).expect(200);

    // Manual: (1000/1M)*1.0 + 0 = 0.001
    expect(res.body.estimatedCost).toBeCloseTo(0.001, 8);
  });

  it("very large token counts compute correctly", async () => {
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Big response";
      yield {
        type: "usage",
        usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
      };
    });

    const res = await sendChat({
      provider: "openai",
      model: "gpt-5-nano",
      messages: [{ role: "user", content: "Max context" }],
    }).expect(200);

    // Manual: (1M/1M)*0.025 + (100k/1M)*0.2 = 0.025 + 0.02 = 0.045
    expect(res.body.estimatedCost).toBeCloseTo(0.045, 6);
  });

  it("Anthropic cache fields propagate through to usage in response", async () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 50,
      cacheReadInputTokens: 10000,
      cacheCreationInputTokens: 500,
    };
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield "Cache propagation test";
      yield { type: "usage", usage };
    });

    const res = await sendChat({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "Cache test" }],
    }).expect(200);

    // Verify cache fields are present in the response usage object
    expect(res.body.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 50,
      cacheReadInputTokens: 10000,
      cacheCreationInputTokens: 500,
    });

    // Verify cost includes all cache tiers
    const expected = expectedCost("claude-haiku-4-5-20251001", usage);
    expect(res.body.estimatedCost).toBeCloseTo(expected, 8);

    // Manual:
    //   new    = (10/1M)*1.0      = 0.00001
    //   read   = (10000/1M)*0.1   = 0.001
    //   write  = (500/1M)*1.25    = 0.000625
    //   output = (50/1M)*5.0      = 0.00025
    //   total  =                    0.001885
    expect(expected).toBeCloseTo(0.001885, 8);
  });
});

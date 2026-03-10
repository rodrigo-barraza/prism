import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, TEST_SECRET, MOCK_GENERATE_TEXT } from "./setup.js";
import {
    calculateTextCost,
    calculateAudioCost,
} from "../src/utils/CostCalculator.js";

// ═══════════════════════════════════════════════════════════════
// calculateTextCost — Unit Tests
// ═══════════════════════════════════════════════════════════════

describe("calculateTextCost", () => {
    it("returns null when pricing is null", () => {
        const usage = { inputTokens: 100, outputTokens: 50 };
        expect(calculateTextCost(usage, null)).toBeNull();
    });

    it("returns null when pricing is undefined", () => {
        const usage = { inputTokens: 100, outputTokens: 50 };
        expect(calculateTextCost(usage, undefined)).toBeNull();
    });

    it("returns null when usage is null", () => {
        const pricing = { inputPerMillion: 1.0, outputPerMillion: 5.0 };
        expect(calculateTextCost(null, pricing)).toBeNull();
    });

    it("returns 0 when token counts are zero", () => {
        const usage = { inputTokens: 0, outputTokens: 0 };
        const pricing = { inputPerMillion: 1.0, outputPerMillion: 5.0 };
        expect(calculateTextCost(usage, pricing)).toBe(0);
    });

    // ── Real model pricing ───────────────────────────────────────

    it("calculates cost for GPT 5.2 (10 in, 5 out)", () => {
        // GPT-5.2: input $0.875/M, output $7.00/M
        const usage = { inputTokens: 10, outputTokens: 5 };
        const pricing = { inputPerMillion: 0.875, outputPerMillion: 7.0 };
        // Expected: (10/1M)*0.875 + (5/1M)*7.0 = 0.00000875 + 0.000035 = 0.00004375
        const cost = calculateTextCost(usage, pricing);
        expect(cost).toBeCloseTo(0.00004375, 8);
    });

    it("calculates cost for GPT 5 Mini (1000 in, 500 out)", () => {
        // GPT-5-mini: input $0.125/M, output $1.00/M
        const usage = { inputTokens: 1000, outputTokens: 500 };
        const pricing = { inputPerMillion: 0.125, outputPerMillion: 1.0 };
        // Expected: (1000/1M)*0.125 + (500/1M)*1.0 = 0.000125 + 0.0005 = 0.000625
        const cost = calculateTextCost(usage, pricing);
        expect(cost).toBeCloseTo(0.000625, 8);
    });

    it("calculates cost for Haiku 4.5 (5000 in, 2000 out)", () => {
        // Haiku 4.5: input $1.00/M, output $5.00/M
        const usage = { inputTokens: 5000, outputTokens: 2000 };
        const pricing = { inputPerMillion: 1.0, outputPerMillion: 5.0 };
        // Expected: (5000/1M)*1.0 + (2000/1M)*5.0 = 0.005 + 0.01 = 0.015
        const cost = calculateTextCost(usage, pricing);
        expect(cost).toBeCloseTo(0.015, 8);
    });

    it("calculates cost for Opus 4.6 (50000 in, 10000 out)", () => {
        // Opus 4.6: input $5.00/M, output $25.00/M
        const usage = { inputTokens: 50000, outputTokens: 10000 };
        const pricing = { inputPerMillion: 5.0, outputPerMillion: 25.0 };
        // Expected: (50000/1M)*5.0 + (10000/1M)*25.0 = 0.25 + 0.25 = 0.5
        const cost = calculateTextCost(usage, pricing);
        expect(cost).toBeCloseTo(0.5, 8);
    });

    it("calculates cost for Gemini 3 Flash (10000 in, 3000 out)", () => {
        // Gemini 3 Flash: input $0.50/M, output $3.00/M
        const usage = { inputTokens: 10000, outputTokens: 3000 };
        const pricing = { inputPerMillion: 0.5, outputPerMillion: 3.0 };
        // Expected: (10000/1M)*0.5 + (3000/1M)*3.0 = 0.005 + 0.009 = 0.014
        const cost = calculateTextCost(usage, pricing);
        expect(cost).toBeCloseTo(0.014, 8);
    });

    it("handles large token counts (1M+ tokens)", () => {
        const usage = { inputTokens: 2_000_000, outputTokens: 128_000 };
        const pricing = { inputPerMillion: 1.25, outputPerMillion: 7.5 };
        // Expected: (2M/1M)*1.25 + (128k/1M)*7.5 = 2.5 + 0.96 = 3.46
        const cost = calculateTextCost(usage, pricing);
        expect(cost).toBeCloseTo(3.46, 5);
    });

    it("handles free models (LM Studio) with 0 pricing", () => {
        const usage = { inputTokens: 5000, outputTokens: 2000 };
        const pricing = { inputPerMillion: 0, outputPerMillion: 0 };
        expect(calculateTextCost(usage, pricing)).toBe(0);
    });

    it("handles pricing with only inputPerMillion set (embeddings-style)", () => {
        const usage = { inputTokens: 8000, outputTokens: 0 };
        const pricing = { inputPerMillion: 0.02 };
        // Expected: (8000/1M)*0.02 = 0.00016
        const cost = calculateTextCost(usage, pricing);
        expect(cost).toBeCloseTo(0.00016, 8);
    });
});

// ═══════════════════════════════════════════════════════════════
// calculateAudioCost — Unit Tests
// ═══════════════════════════════════════════════════════════════

describe("calculateAudioCost", () => {
    it("returns null when pricing is null", () => {
        const usage = { durationSeconds: 60 };
        expect(calculateAudioCost(usage, null)).toBeNull();
    });

    it("returns null when pricing is undefined", () => {
        const usage = { durationSeconds: 60 };
        expect(calculateAudioCost(usage, undefined)).toBeNull();
    });

    it("returns null when usage is null", () => {
        const pricing = { perMinute: 0.006 };
        expect(calculateAudioCost(null, pricing)).toBeNull();
    });

    it("returns null when no matching pricing strategy applies", () => {
        const usage = { durationSeconds: 60 };
        // Pricing has no perMinute and no audioInputPerMillion
        const pricing = { inputPerMillion: 1.0, outputPerMillion: 5.0 };
        expect(calculateAudioCost(usage, pricing)).toBeNull();
    });

    // ── Per-minute pricing ───────────────────────────────────────

    it("calculates per-minute cost for Whisper-1 (120s)", () => {
        // Whisper-1: $0.006/min
        const usage = { durationSeconds: 120 };
        const pricing = { perMinute: 0.006 };
        // Expected: (120/60) * 0.006 = 0.012
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.012, 8);
    });

    it("calculates per-minute cost for GPT-4o Transcribe (45s)", () => {
        // GPT-4o Transcribe also has perMinute $0.006
        const usage = { durationSeconds: 45, inputTokens: 500, outputTokens: 100 };
        const pricing = {
            audioInputPerMillion: 2.5,
            outputPerMillion: 10.0,
            perMinute: 0.006,
        };
        // Per-minute takes priority: (45/60) * 0.006 = 0.0045
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.0045, 8);
    });

    it("calculates per-minute cost for short audio (5s)", () => {
        const usage = { durationSeconds: 5 };
        const pricing = { perMinute: 0.006 };
        // Expected: (5/60) * 0.006 = 0.0005
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.0005, 8);
    });

    // ── Token-based pricing ──────────────────────────────────────

    it("calculates token-based cost for Gemini 3 Flash STT", () => {
        // Gemini 3 Flash STT: audioInput $1.00/M, output $3.00/M
        const usage = { inputTokens: 10000, outputTokens: 500 };
        const pricing = { audioInputPerMillion: 1.0, outputPerMillion: 3.0 };
        // Expected: (10000/1M)*1.0 + (500/1M)*3.0 = 0.01 + 0.0015 = 0.0115
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.0115, 8);
    });

    it("calculates token-based cost for GPT-4o Transcribe (no perMinute)", () => {
        // If perMinute is missing but tokens are present
        const usage = { inputTokens: 5000, outputTokens: 1000 };
        const pricing = { audioInputPerMillion: 2.5, outputPerMillion: 10.0 };
        // Expected: (5000/1M)*2.5 + (1000/1M)*10.0 = 0.0125 + 0.01 = 0.0225
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.0225, 8);
    });

    it("handles token-based cost with no output tokens", () => {
        const usage = { inputTokens: 8000 };
        const pricing = { audioInputPerMillion: 1.25, outputPerMillion: 5.0 };
        // Expected: (8000/1M)*1.25 + (0/1M)*5.0 = 0.01
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.01, 8);
    });

    it("handles token-based cost with no outputPerMillion in pricing", () => {
        const usage = { inputTokens: 10000, outputTokens: 500 };
        const pricing = { audioInputPerMillion: 1.0 };
        // Expected: (10000/1M)*1.0 + (500/1M)*0 = 0.01
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.01, 8);
    });

    // ── Priority: perMinute > token-based ────────────────────────

    it("prefers perMinute over token-based when both are available", () => {
        const usage = { durationSeconds: 60, inputTokens: 10000, outputTokens: 500 };
        const pricing = {
            perMinute: 0.006,
            audioInputPerMillion: 2.5,
            outputPerMillion: 10.0,
        };
        // Should use perMinute: (60/60)*0.006 = 0.006
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.006, 8);
    });

    it("falls back to token-based when durationSeconds is missing", () => {
        const usage = { inputTokens: 10000, outputTokens: 500 };
        const pricing = {
            perMinute: 0.006,
            audioInputPerMillion: 2.5,
            outputPerMillion: 10.0,
        };
        // perMinute can't fire (no durationSeconds), falls back to token-based
        // Expected: (10000/1M)*2.5 + (500/1M)*10.0 = 0.025 + 0.005 = 0.03
        const cost = calculateAudioCost(usage, pricing);
        expect(cost).toBeCloseTo(0.03, 8);
    });
});

// ═══════════════════════════════════════════════════════════════
// Integration — text-to-text endpoint returns correct cost
// ═══════════════════════════════════════════════════════════════

describe("POST /text-to-text — estimatedCost", () => {
    it("returns the expected estimatedCost for a known model", async () => {
        MOCK_GENERATE_TEXT.mockResolvedValueOnce({
            text: "Hello from mock",
            usage: { inputTokens: 1000, outputTokens: 500 },
        });

        const res = await request(app)
            .post("/text-to-text")
            .set("x-api-secret", TEST_SECRET)
            .send({
                provider: "openai",
                model: "gpt-5.2",
                messages: [{ role: "user", content: "hi" }],
            })
            .expect(200);

        // GPT-5.2: input $0.875/M, output $7.00/M
        // Expected: (1000/1M)*0.875 + (500/1M)*7.0 = 0.000875 + 0.0035 = 0.004375
        expect(res.body.estimatedCost).toBeCloseTo(0.004375, 8);
    });

    it("returns null estimatedCost for an unknown model", async () => {
        MOCK_GENERATE_TEXT.mockResolvedValueOnce({
            text: "Hello from mock",
            usage: { inputTokens: 100, outputTokens: 50 },
        });

        const res = await request(app)
            .post("/text-to-text")
            .set("x-api-secret", TEST_SECRET)
            .send({
                provider: "openai",
                model: "nonexistent-model-xyz",
                messages: [{ role: "user", content: "hi" }],
            })
            .expect(200);

        expect(res.body.estimatedCost).toBeNull();
    });

    it("returns 0 estimatedCost when tokens are zero", async () => {
        MOCK_GENERATE_TEXT.mockResolvedValueOnce({
            text: "",
            usage: { inputTokens: 0, outputTokens: 0 },
        });

        const res = await request(app)
            .post("/text-to-text")
            .set("x-api-secret", TEST_SECRET)
            .send({
                provider: "openai",
                model: "gpt-5.2",
                messages: [{ role: "user", content: "" }],
            })
            .expect(200);

        expect(res.body.estimatedCost).toBe(0);
    });

    it("returns correct cost for Anthropic model", async () => {
        MOCK_GENERATE_TEXT.mockResolvedValueOnce({
            text: "Hello",
            usage: { inputTokens: 5000, outputTokens: 2000 },
        });

        const res = await request(app)
            .post("/text-to-text")
            .set("x-api-secret", TEST_SECRET)
            .send({
                provider: "anthropic",
                model: "claude-sonnet-4-5-20250929",
                messages: [{ role: "user", content: "hi" }],
            })
            .expect(200);

        // Sonnet 4.5: input $3.00/M, output $15.00/M
        // Expected: (5000/1M)*3.0 + (2000/1M)*15.0 = 0.015 + 0.03 = 0.045
        expect(res.body.estimatedCost).toBeCloseTo(0.045, 8);
    });

    it("returns correct cost for Google model", async () => {
        MOCK_GENERATE_TEXT.mockResolvedValueOnce({
            text: "Hello",
            usage: { inputTokens: 10000, outputTokens: 3000 },
        });

        const res = await request(app)
            .post("/text-to-text")
            .set("x-api-secret", TEST_SECRET)
            .send({
                provider: "google",
                model: "gemini-3-flash-preview",
                messages: [{ role: "user", content: "hi" }],
            })
            .expect(200);

        // Gemini 3 Flash: input $0.50/M, output $3.00/M
        // Expected: (10000/1M)*0.5 + (3000/1M)*3.0 = 0.005 + 0.009 = 0.014
        expect(res.body.estimatedCost).toBeCloseTo(0.014, 8);
    });
});

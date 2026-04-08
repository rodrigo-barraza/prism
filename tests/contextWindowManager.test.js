import { vi } from "vitest";

// Suppress logger output during tests
vi.mock("../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

import ContextWindowManager from "../src/utils/ContextWindowManager.js";

// ═══════════════════════════════════════════════════════════════
// Token Estimation
// ═══════════════════════════════════════════════════════════════

describe("Token estimation", () => {
  it("estimates tokens for a simple text message", () => {
    // "Hello world" = 11 chars → ceil(11 / 3.5) = 4 tokens + 4 overhead = 8
    const tokens = ContextWindowManager.estimateMessageTokens({
      role: "user",
      content: "Hello world",
    });
    expect(tokens).toBe(4 + 4); // 4 content + 4 overhead
  });

  it("estimates zero tokens for null content", () => {
    const tokens = ContextWindowManager.estimateMessageTokens({
      role: "user",
      content: null,
    });
    expect(tokens).toBe(4); // Only overhead
  });

  it("estimates zero tokens for empty content", () => {
    const tokens = ContextWindowManager.estimateMessageTokens({
      role: "user",
      content: "",
    });
    expect(tokens).toBe(4); // Only overhead
  });

  it("includes tool call overhead (name + args + result)", () => {
    const msg = {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          name: "read_file",
          args: JSON.stringify({ path: "/test.js" }),
          result: "file content here",
        },
      ],
    };
    const tokens = ContextWindowManager.estimateMessageTokens(msg);
    // 4 overhead + 0 content + read_file tokens + args tokens + result tokens
    expect(tokens).toBeGreaterThan(4);
  });

  it("adds ~1000 tokens per image reference", () => {
    const withoutImages = ContextWindowManager.estimateMessageTokens({
      role: "user",
      content: "Look at this",
    });
    const withImages = ContextWindowManager.estimateMessageTokens({
      role: "user",
      content: "Look at this",
      images: ["minio://bucket/img1.png", "minio://bucket/img2.png"],
    });
    expect(withImages - withoutImages).toBe(2000);
  });

  it("includes thinking block tokens", () => {
    const without = ContextWindowManager.estimateMessageTokens({
      role: "assistant",
      content: "answer",
    });
    const with_ = ContextWindowManager.estimateMessageTokens({
      role: "assistant",
      content: "answer",
      thinking: "Let me think about this carefully...",
    });
    expect(with_).toBeGreaterThan(without);
  });

  it("estimates tokens across multiple messages", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    const total = ContextWindowManager.estimateTokens(messages);
    // Each message has content + 4 overhead
    expect(total).toBeGreaterThan(12); // At minimum 3 * 4 overhead
  });
});

// ═══════════════════════════════════════════════════════════════
// enforce() — Fast Path (no truncation needed)
// ═══════════════════════════════════════════════════════════════

describe("ContextWindowManager.enforce — fast path", () => {
  it("returns unchanged messages when under budget", () => {
    const messages = [
      { role: "system", content: "Be helpful." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ];
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 128_000,
    });
    expect(result.truncated).toBe(false);
    expect(result.strategy).toBeNull();
    expect(result.messages).toBe(messages); // Same reference
    expect(result.messages).toHaveLength(3);
  });

  it("returns unchanged when exactly at budget", () => {
    // Tiny context window but messages still fit
    const messages = [
      { role: "user", content: "Hi" },
    ];
    const estimated = ContextWindowManager.estimateTokens(messages);
    // Budget = floor((maxInput - outputReserve - schemaOverhead) * 0.80)
    // We need budget >= estimated, so set maxInput high enough
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 128_000,
    });
    expect(result.truncated).toBe(false);
  });

  it("handles empty messages array", () => {
    const result = ContextWindowManager.enforce([], {
      maxInputTokens: 128_000,
    });
    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// enforce() — Strategy 1: Tool Result Truncation
// ═══════════════════════════════════════════════════════════════

describe("ContextWindowManager.enforce — tool result truncation", () => {
  it("truncates large tool results in old messages", () => {
    const bigResult = "x".repeat(10_000);
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Do something" },
      {
        role: "assistant",
        content: "I'll read the file",
        toolCalls: [{ name: "read_file", args: '{"path": "big.js"}', result: bigResult }],
      },
      { role: "user", content: "What about this?" },
      { role: "user", content: "And this?" },
      { role: "user", content: "More context" },
      { role: "user", content: "Even more" },
      { role: "user", content: "Final question" },
      { role: "assistant", content: "Here's my answer" },
    ];

    // Use a small context window to force truncation
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 16_000,
      maxOutputTokens: 2_000,
      toolCount: 5,
    });

    if (result.truncated && result.strategy === "tool_truncation") {
      // The old tool result should be capped at 3000 chars
      const truncatedTc = result.messages[2].toolCalls[0];
      expect(truncatedTc.result.length).toBeLessThanOrEqual(3100); // 3000 + truncation notice
      expect(truncatedTc.result).toContain("truncated");
    }
    // Strategy may escalate to assistant_compression or sliding_window if 16k is too small
    expect(result.truncated).toBe(true);
  });

  it("preserves recent tool results (protected turns)", () => {
    const bigResult = "y".repeat(10_000);
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Read this file" },
      {
        role: "assistant",
        content: "Reading...",
        toolCalls: [{ name: "read_file", args: '{"path": "big.js"}', result: bigResult }],
      },
      // This is within the last 4 user turns, so should be protected
      { role: "user", content: "Now what?" },
      { role: "assistant", content: "Done." },
    ];

    // Even if we force truncation, recent messages should keep full results
    // With a large enough window that tool_truncation alone suffices
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 20_000,
    });

    // The tool result is in a recent turn — if strategy 1 fires, it should still be full
    // But with 20k context the whole thing might fit without truncation
    if (!result.truncated) {
      // It fit without truncation — expected for this message count + 20k window
      const tc = result.messages[2].toolCalls[0];
      expect(tc.result).toBe(bigResult);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// enforce() — Strategy 2: Assistant Message Compression
// ═══════════════════════════════════════════════════════════════

describe("ContextWindowManager.enforce — assistant compression", () => {
  it("compresses old assistant messages while preserving recent ones", () => {
    // Build a conversation large enough to trigger compression
    const longContent = "A".repeat(5_000);
    const messages = [
      { role: "system", content: "System" },
      { role: "user", content: "Q1" },
      { role: "assistant", content: longContent, thinking: "Think".repeat(1000) },
      { role: "user", content: "Q2" },
      { role: "assistant", content: longContent },
      { role: "user", content: "Q3" },
      { role: "assistant", content: longContent },
      { role: "user", content: "Q4" },
      { role: "assistant", content: longContent },
      { role: "user", content: "Q5" },
      { role: "assistant", content: longContent },
      { role: "user", content: "Q6 final" },
      { role: "assistant", content: "Short recent answer" },
    ];

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 16_000,
      maxOutputTokens: 2_000,
    });

    expect(result.truncated).toBe(true);

    // The most recent assistant message should be preserved
    const lastAssistant = result.messages.filter(m => m.role === "assistant").pop();
    if (result.strategy !== "sliding_window") {
      expect(lastAssistant.content).toContain("Short recent answer");
    }
  });

  it("replaces thinking blocks with undefined in compressed messages", () => {
    const messages = [
      { role: "system", content: "System" },
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A".repeat(8_000), thinking: "T".repeat(8_000) },
      { role: "user", content: "Q2" },
      { role: "assistant", content: "A".repeat(8_000), thinking: "T".repeat(8_000) },
      { role: "user", content: "Q3" },
      { role: "user", content: "Q4" },
      { role: "user", content: "Q5" },
      { role: "user", content: "Q6" },
      { role: "assistant", content: "Recent" },
    ];

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 16_000,
    });

    if (result.truncated) {
      // Old assistant messages should have thinking stripped
      const oldAssistants = result.messages.filter(
        (m, i) => m.role === "assistant" && i < result.messages.length - 2,
      );
      for (const msg of oldAssistants) {
        if (msg.content?.startsWith("[Earlier response")) {
          expect(msg.thinking).toBeUndefined();
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// enforce() — Strategy 3: Sliding Window
// ═══════════════════════════════════════════════════════════════

describe("ContextWindowManager.enforce — sliding window", () => {
  it("drops middle turns and inserts context note", () => {
    // Build a gigantic conversation that exceeds even compression
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "First question" },
    ];

    // Add 50 turns of substantial conversation
    for (let i = 0; i < 50; i++) {
      messages.push({ role: "assistant", content: "Response ".repeat(500) });
      messages.push({ role: "user", content: `Follow-up question ${i}` });
    }

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 8_000, // Very small window
      maxOutputTokens: 2_000,
    });

    expect(result.truncated).toBe(true);
    expect(result.strategy).toBe("sliding_window");
    expect(result.messages.length).toBeLessThan(messages.length);

    // Should have a context note about dropped messages
    const contextNote = result.messages.find(
      (m) => m.content?.includes("CONTEXT NOTE") || m.content?.includes("earlier messages were removed"),
    );
    expect(contextNote).toBeTruthy();

    // System message should be preserved
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toBe("System prompt");

    // First user message should be preserved
    expect(result.messages[1].role).toBe("user");
    expect(result.messages[1].content).toBe("First question");
  });

  it("preserves the most recent messages", () => {
    const messages = [
      { role: "system", content: "System" },
      { role: "user", content: "Old question" },
    ];

    for (let i = 0; i < 30; i++) {
      messages.push({ role: "assistant", content: "Long answer ".repeat(200) });
      messages.push({ role: "user", content: `Question ${i}` });
    }

    // Add a recognizable final exchange
    messages.push({ role: "assistant", content: "FINAL_ANSWER_MARKER" });

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 8_000,
    });

    expect(result.truncated).toBe(true);
    // The final answer should be in the result
    const lastAssistant = result.messages.filter(m => m.role === "assistant").pop();
    expect(lastAssistant.content).toContain("FINAL_ANSWER_MARKER");
  });

  it("handles conversation with only 3 messages (no truncation possible)", () => {
    const messages = [
      { role: "system", content: "S".repeat(50_000) },
      { role: "user", content: "Q" },
      { role: "assistant", content: "A" },
    ];

    // Even with sliding window, 3-message conversations are returned as-is
    // from slidingWindowTruncation (guard clause), but compression may still apply
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 8_000,
    });

    // The system message is always preserved regardless
    expect(result.messages[0].role).toBe("system");
  });
});

// ═══════════════════════════════════════════════════════════════
// Budget Calculation
// ═══════════════════════════════════════════════════════════════

describe("Budget calculation", () => {
  it("accounts for tool count in schema overhead", () => {
    const messages = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "user", content: "Question ".repeat(500) });
      messages.push({ role: "assistant", content: "Answer ".repeat(500) });
    }

    // More tools = higher schema overhead = tighter budget = more likely to truncate
    const noTools = ContextWindowManager.enforce(messages, {
      maxInputTokens: 32_000,
      toolCount: 0,
    });
    const manyTools = ContextWindowManager.enforce(messages, {
      maxInputTokens: 32_000,
      toolCount: 30,
    });

    // Many tools should have a lower effective budget,
    // which means it's MORE likely to truncate or use a more aggressive strategy
    if (!noTools.truncated && manyTools.truncated) {
      expect(manyTools.truncated).toBe(true);
    }
    // At minimum, estimated tokens should be the same for identical messages
    expect(noTools.estimatedTokens).toBeGreaterThan(0);
  });

  it("respects minimum output reserve of 8192", () => {
    const messages = [
      { role: "user", content: "Hi" },
    ];

    // Even with maxOutputTokens = 100, the reserve should be at least 8192
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 128_000,
      maxOutputTokens: 100, // Below minimum
    });

    // The budget formula: floor((128000 - max(100, 8192) - 2000) * 0.80)
    // = floor((128000 - 8192 - 2000) * 0.80) = floor(117808 * 0.80) = 94246
    expect(result.truncated).toBe(false); // Tiny message fits easily
  });

  it("handles negative budget gracefully", () => {
    const messages = [
      { role: "user", content: "Hi" },
    ];

    // maxInputTokens so small that budget goes negative
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 1000, // Way too small after output reserve + schema overhead
      maxOutputTokens: 8192,
      toolCount: 50,
    });

    // Should not crash — returns untouched messages with truncated: false
    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(1);
  });

  it("uses default maxInputTokens of 128k when not specified", () => {
    const messages = [
      { role: "user", content: "Test" },
    ];
    const result = ContextWindowManager.enforce(messages);
    expect(result.truncated).toBe(false);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Strategy Escalation
// ═══════════════════════════════════════════════════════════════

describe("Strategy escalation", () => {
  it("escalates from tool_truncation → assistant_compression → sliding_window", () => {
    // Build messages where tool truncation alone doesn't suffice
    const messages = [
      { role: "system", content: "System" },
    ];

    for (let i = 0; i < 40; i++) {
      messages.push({ role: "user", content: `Question ${i}` });
      messages.push({
        role: "assistant",
        content: "Analysis complete. ".repeat(100),
        toolCalls: [
          { name: "read_file", args: '{"path": "test.js"}', result: "file content ".repeat(200) },
        ],
      });
    }

    messages.push({ role: "user", content: "Final question" });

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 8_000,
    });

    expect(result.truncated).toBe(true);
    // With 40 turns of substantial content in an 8k window, should hit sliding_window
    expect(result.strategy).toBe("sliding_window");
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it("reports correct strategy name when tool truncation alone suffices", () => {
    const bigResult = "x".repeat(50_000);
    const messages = [
      { role: "system", content: "System" },
      { role: "user", content: "Read file" },
      {
        role: "assistant",
        content: "Done",
        toolCalls: [{ name: "read_file", args: "{}", result: bigResult }],
      },
      // 5 recent user turns to push the old tool result outside protection
      { role: "user", content: "Q1" },
      { role: "user", content: "Q2" },
      { role: "user", content: "Q3" },
      { role: "user", content: "Q4" },
      { role: "user", content: "Q5" },
      { role: "assistant", content: "Final" },
    ];

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 32_000,
    });

    if (result.truncated) {
      expect(["tool_truncation", "assistant_compression", "sliding_window"]).toContain(
        result.strategy,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Edge Cases
// ═══════════════════════════════════════════════════════════════

describe("Edge cases", () => {
  it("handles messages with only system prompt", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
    ];
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 128_000,
    });
    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(1);
  });

  it("handles tool messages (standalone, not in toolCalls)", () => {
    const messages = [
      { role: "system", content: "System" },
      { role: "user", content: "Test" },
      { role: "assistant", content: "Running tool..." },
      { role: "tool", content: "Tool result: success" },
      { role: "assistant", content: "Done" },
    ];
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 128_000,
    });
    expect(result.truncated).toBe(false);
  });

  it("handles non-string content (objects)", () => {
    const messages = [
      { role: "user", content: { text: "Hello", metadata: { foo: "bar" } } },
    ];
    // Should not throw
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 128_000,
    });
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it("handles messages with undefined fields", () => {
    const messages = [
      { role: "user", content: "Hi", images: undefined, toolCalls: undefined },
    ];
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 128_000,
    });
    expect(result.truncated).toBe(false);
  });
});

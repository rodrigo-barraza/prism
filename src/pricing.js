// ============================================================
// Prism the AI Gateway — Token Pricing (USD per 1M tokens)
// ============================================================
// Static lookup of input/output token costs by model name.
// Keys must match the exact model strings in config.js.
// Update manually when provider pricing changes.
// ============================================================

const TEXT2TEXT_PRICING = {
    // OpenAI
    "gpt-5.2": { inputPerMillion: 1.75, outputPerMillion: 14.00 },
    "gpt-5-mini": { inputPerMillion: 0.25, outputPerMillion: 2.00 },
    "gpt-5-nano": { inputPerMillion: 0.05, outputPerMillion: 0.40 },

    // Anthropic
    "claude-opus-4-5-20251101": { inputPerMillion: 5.00, outputPerMillion: 25.00 },
    "claude-opus-4-6": { inputPerMillion: 5.00, outputPerMillion: 25.00 },
    "claude-sonnet-4-5-20250929": { inputPerMillion: 3.00, outputPerMillion: 15.00 },
    "claude-sonnet-4-6": { inputPerMillion: 3.00, outputPerMillion: 15.00 },
    "claude-haiku-4-5-20251001": { inputPerMillion: 1.00, outputPerMillion: 5.00 },

    // Google
    "gemini-3-pro-preview": { inputPerMillion: 2.00, outputPerMillion: 12.00 },
    "gemini-3.1-pro-preview": { inputPerMillion: 2.00, outputPerMillion: 12.00 },
    "gemini-3-flash-preview": { inputPerMillion: 0.50, outputPerMillion: 3.00 },
};

export { TEXT2TEXT_PRICING };

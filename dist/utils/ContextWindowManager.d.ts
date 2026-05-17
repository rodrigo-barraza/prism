export default class ContextWindowManager {
    /**
     * Enforce context window limits on a messages array.
     *
     * Applies truncation strategies in order of aggressiveness until
     * the estimated token count fits within the model's context window.
     *
     * @param {Array} messages - The messages array (mutated in-place)
     * @param {object} options
     * @param {number} [options.maxInputTokens] - Model's context window (from config.js maxInputTokens)
     * @param {number} [options.maxOutputTokens] - Reserved output tokens
     * @param {number} [options.toolCount=0] - Number of tools (for schema overhead estimation)
     * @returns {{ messages: Array, truncated: boolean, strategy: string|null, estimatedTokens: number }}
     */
    static enforce(messages: any, options?: {}): {
        messages: any;
        truncated: boolean;
        strategy: string;
        estimatedTokens: any;
    };
    /**
     * Estimate token count for messages (exposed for diagnostics).
     * @param {Array} messages
     * @returns {number}
     */
    static estimateTokens(messages: any): any;
    /**
     * Estimate tokens for a single message (exposed for diagnostics).
     * @param {object} msg
     * @returns {number}
     */
    static estimateMessageTokens(msg: any): number;
}
//# sourceMappingURL=ContextWindowManager.d.ts.map
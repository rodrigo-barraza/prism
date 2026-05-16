/**
 * EmbeddingService — single entry point for all embedding generation.
 *
 * Wraps the provider's `generateEmbedding()` with RequestLogger tracking,
 * ensuring both HTTP `/embed` requests and internal callers (MemoryService,
 * SystemPromptAssembler) flow through the same path.
 */
declare const EmbeddingService: {
    /**
     * Generate an embedding and log the request.
     *
     * @param {string|Array|object} content - Text string or multimodal parts
     * @param {object} [options]
     * @param {string} [options.provider]    - Provider name (default: google)
     * @param {string} [options.model]       - Model name (default: gemini-embedding-2-preview)
     * @param {string} [options.taskType]    - e.g. SEMANTIC_SIMILARITY
     * @param {number} [options.dimensions]  - Output dimensionality
     * @param {string} [options.project]     - Project identifier (for request log)
     * @param {string} [options.username]    - Username (for request log)
     * @param {string} [options.clientIp]    - Client IP (for request log)
     * @param {string} [options.source]      - Caller identifier, e.g. "memory", "agent-memory", "skill-relevance", "api"
     * @param {string} [options.agent]       - Agent identifier (e.g. "CODING", "LUPOS")
     * @param {string} [options.agentSessionId] - Agent session ID for request grouping
     * @returns {Promise<{ embedding: number[], dimensions: number, provider: string, model: string }>}
     */
    generate(content: any, options?: {}): Promise<{
        embedding: any;
        dimensions: any;
        provider: any;
        model: any;
    }>;
    /**
     * Convenience wrapper — returns just the embedding vector.
     * Used by internal callers that only need the float array.
     *
     * @param {string} text - Text to embed
     * @param {object} [options] - Same as generate()
     * @returns {Promise<number[]>}
     */
    embed(text: any, options?: {}): Promise<any>;
};
export default EmbeddingService;
//# sourceMappingURL=EmbeddingService.d.ts.map
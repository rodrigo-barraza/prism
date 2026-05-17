/**
 * Factory: create an Ollama provider instance targeting a specific baseUrl.
 * @param {string} baseUrl - The base URL for the Ollama server
 * @param {string} [instanceId="ollama"] - Unique instance identifier
 * @returns {object} Provider object with all Ollama methods
 */
export declare function createOllamaProvider(baseUrl: any, instanceId?: string): {
    name: string;
    generateText(messages: any, model?: any, options?: {}): Promise<{
        text: any;
        thinking: any;
        usage: {
            inputTokens: any;
            outputTokens: any;
        };
    }>;
    generateTextStream(messages: any, model?: any, options?: {}): AsyncGenerator<any, void, unknown>;
    captionImage(images: any, prompt: string, model: any, systemPrompt: any): Promise<{
        text: any;
        usage: {
            inputTokens: any;
            outputTokens: any;
        };
    }>;
    /**
     * List all models available in Ollama.
     * GET /api/tags
     */
    listModels(): Promise<{
        models: any;
    }>;
};
//# sourceMappingURL=ollama.d.ts.map
declare const anthropicProvider: {
    name: string;
    generateText(messages: any, model?: any, options?: {}): Promise<{
        text: string;
        usage: {
            inputTokens: any;
            outputTokens: any;
            cacheReadInputTokens: any;
            cacheCreationInputTokens: any;
        };
    }>;
    /**
     * Caption / describe images (image-to-text).
     * @param {string[]} images - Array of image URLs or base64 data URLs
     * @param {string} prompt - Caption prompt
     * @param {string} model - Model name
     * @returns {Promise<{ text: string, usage: object }>}
     */
    captionImage(images: any, prompt: string, model: any, systemPrompt: any): Promise<{
        text: string;
        usage: {
            inputTokens: any;
            outputTokens: any;
            cacheReadInputTokens: any;
            cacheCreationInputTokens: any;
        };
    }>;
    generateTextStream(messages: any, model?: any, options?: {}): AsyncGenerator<any, void, any>;
};
export default anthropicProvider;
//# sourceMappingURL=anthropic.d.ts.map
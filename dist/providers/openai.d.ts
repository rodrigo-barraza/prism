declare const openaiProvider: {
    name: string;
    generateText(messages: any, model?: any, options?: {}): Promise<any>;
    /**
     * Responses API path for GPT-5.2/5.4 models.
     */
    _generateTextResponses(messages: any, model: any, options: any): Promise<{
        text: any;
        images: any[];
        usage: {
            inputTokens: any;
            outputTokens: any;
        };
    }>;
    /**
     * Chat Completions fallback for older models.
     */
    _generateTextChatCompletions(messages: any, model: any, options: any): Promise<{
        text: any;
        usage: {
            inputTokens: any;
            outputTokens: any;
        };
    }>;
    generateTextStream(messages: any, model?: any, options?: {}): AsyncGenerator<any, void, any>;
    /**
     * Streaming via the Responses API.
     */
    _streamResponses(messages: any, model: any, options: any): AsyncGenerator<any, void, unknown>;
    /**
     * Streaming via Chat Completions (fallback for older models).
     */
    _streamChatCompletions(messages: any, model: any, options: any): AsyncGenerator<any, void, unknown>;
    generateSpeech(text: any, voice?: string, options?: {}): Promise<{
        stream: any;
        contentType: string;
    }>;
    generateImage(prompt: any, images?: any[], model?: string): Promise<{
        imageData: any;
        mimeType: string;
        text: any;
    }>;
    captionImage(images: any, prompt: string, model: any, systemPrompt: any): Promise<{
        text: any;
        usage: {
            inputTokens: any;
            outputTokens: any;
        };
    }>;
    generateEmbedding(text: any, model?: any): Promise<{
        embedding: any;
    }>;
    transcribeAudio(audioBuffer: any, mimeType: any, model?: string, options?: {}): Promise<{
        text: any;
        usage: {};
    }>;
};
export default openaiProvider;
//# sourceMappingURL=openai.d.ts.map
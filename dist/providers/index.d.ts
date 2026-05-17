declare const providers: {
    openai: {
        name: string;
        generateText(messages: any, model?: any, options?: {}): Promise<any>;
        _generateTextResponses(messages: any, model: any, options: any): Promise<{
            text: any;
            images: any[];
            usage: {
                inputTokens: any;
                outputTokens: any;
            };
        }>;
        _generateTextChatCompletions(messages: any, model: any, options: any): Promise<{
            text: any;
            usage: {
                inputTokens: any;
                outputTokens: any;
            };
        }>;
        generateTextStream(messages: any, model?: any, options?: {}): AsyncGenerator<any, void, any>;
        _streamResponses(messages: any, model: any, options: any): AsyncGenerator<any, void, unknown>;
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
    anthropic: {
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
    google: {
        name: string;
        generateText(messages: any, model?: any, options?: {}): Promise<{
            text: any;
            usage: {
                inputTokens: any;
                outputTokens: any;
            };
        } | {
            text: string;
            usage: {
                inputTokens: number;
                outputTokens: number;
            };
            safetyBlock: boolean;
        }>;
        generateTextStream(messages: any, model?: any, options?: {}): AsyncGenerator<any, void, unknown>;
        generateTextStreamLive(messages: any, model: any, options?: {}): AsyncGenerator<any, void, unknown>;
        captionImage(images: any, prompt: string, model: any, systemPrompt: any): Promise<{
            text: any;
            usage: {
                inputTokens: any;
                outputTokens: any;
            };
        }>;
        generateImage(prompt: any, images: any[], model: string, systemPrompt: any): Promise<{
            imageData: any;
            mimeType: any;
            text: string;
        }>;
        generateSpeech(text: any, voice?: string, options?: {}): Promise<{
            stream: import("node:stream").Readable;
            contentType: string;
        }>;
        transcribeAudio(audioBuffer: any, mimeType: any, model?: string, options?: {}): Promise<{
            text: any;
            usage: {
                inputTokens: any;
                outputTokens: any;
            };
        }>;
        generateEmbedding(content: any, model: any, options?: {}): Promise<{
            embedding: any;
            dimensions: any;
        }>;
    };
    elevenlabs: {
        name: string;
        generateSpeech(text: any, voiceId?: string, options?: {}): Promise<{
            stream: import("node:stream/web").ReadableStream<any>;
            contentType: string;
        }>;
        generateSpeechStream(textStream: any, voiceId?: string, options?: {}): AsyncGenerator<Buffer<ArrayBuffer>, void, unknown>;
    };
    inworld: {
        name: string;
        generateSpeech(text: any, voice?: string, options?: {}): Promise<{
            stream: import("node:stream").Readable;
            contentType: string;
        }>;
        generateSpeechStream(textStream: any, voice?: string, options?: {}): AsyncGenerator<Buffer<ArrayBuffer>, void, unknown>;
    };
};
export declare function getProvider(name: any): any;
export declare function listProviders(): string[];
export { providers };
//# sourceMappingURL=index.d.ts.map
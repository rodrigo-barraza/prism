import { Readable } from "stream";
/**
 * Convert generic tool schemas to Google's functionDeclarations format.
 * Input:  [{ name, description, parameters: { type, properties, required } }]
 * Output: [{ functionDeclarations: [...] }]
 */
export declare function convertToolsToGoogle(tools: any): {
    functionDeclarations: {
        name: any;
        description: any;
        parameters: any;
    }[];
}[] | null;
declare const googleProvider: {
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
    /**
     * Live API streaming — for models that only support the bidirectional
     * WebSocket-based BidiGenerateContent method (e.g. gemini-3.1-flash-live-preview).
     *
     * Bridges the event-driven Live API into an async generator matching
     * the same interface as generateTextStream().
     */
    generateTextStreamLive(messages: any, model: any, options?: {}): AsyncGenerator<any, void, unknown>;
    captionImage(images: any, prompt: string | undefined, model: any, systemPrompt: any): Promise<{
        text: any;
        usage: {
            inputTokens: any;
            outputTokens: any;
        };
    }>;
    generateImage(prompt: any, images: never[] | undefined, model: string | undefined, systemPrompt: any): Promise<{
        imageData: any;
        mimeType: any;
        text: string;
    }>;
    generateSpeech(text: any, voice?: string, options?: {}): Promise<{
        stream: Readable;
        contentType: string;
    }>;
    transcribeAudio(audioBuffer: any, mimeType: any, model?: string | undefined, options?: {}): Promise<{
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
export default googleProvider;
//# sourceMappingURL=google.d.ts.map
import { Readable } from "stream";
declare const inworldProvider: {
    name: string;
    /**
     * Generate speech via Inworld TTS (MP3).
     * Returns a Node Readable stream suitable for piping to an HTTP response.
     *
     * @param {string} text - Text to synthesize.
     * @param {string} voice - Voice ID.
     * @param {object} options - Extra options (model, temperature).
     * @returns {{ stream: Readable, contentType: string }}
     */
    generateSpeech(text: any, voice?: string, options?: {}): Promise<{
        stream: Readable;
        contentType: string;
    }>;
    /**
     * Stream speech via Inworld TTS (PCM LINEAR16 + word timestamps).
     * Accepts an async text iterator (same interface as ElevenLabs) and
     * yields raw audio Buffer chunks.
     *
     * @param {AsyncIterable<string>} textStream - Iterator yielding text chunks.
     * @param {string} voice - Voice ID.
     * @param {object} options - Extra options (model, temperature).
     * @yields {Buffer} PCM audio chunks.
     */
    generateSpeechStream(textStream: any, voice?: string, options?: {}): AsyncGenerator<Buffer<ArrayBuffer>, void, unknown>;
};
export default inworldProvider;
//# sourceMappingURL=inworld.d.ts.map
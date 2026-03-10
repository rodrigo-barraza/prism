import express from "express";
import { getProvider } from "../providers/index.js";
import { ProviderError } from "../utils/errors.js";
import ConversationService from "../services/ConversationService.js";
import FileService from "../services/FileService.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * POST /text-to-speech
 * Body: { provider, text, voice?, instructions?, model?, options?, conversationId?, userMessage? }
 * Response: binary audio stream with content-type header
 *
 * When conversationId is provided, the user message and generated audio
 * are automatically appended to the conversation server-side.
 */
router.post("/", async (req, res, next) => {
    try {
        const {
            provider: providerName,
            text,
            voice,
            instructions,
            model,
            options: extraOptions,
            conversationId,
            userMessage,
        } = req.body;

        if (!providerName) {
            throw new ProviderError(
                "server",
                "Missing required field: provider",
                400,
            );
        }
        if (!text) {
            throw new ProviderError("server", "Missing required field: text", 400);
        }

        const provider = getProvider(providerName);
        if (!provider.generateSpeech) {
            throw new ProviderError(
                providerName,
                `Provider "${providerName}" does not support text-to-speech`,
                400,
            );
        }

        const options = { instructions, model, ...extraOptions };
        const requestStart = performance.now();
        const result = await provider.generateSpeech(text, voice, options);
        const totalSec = (performance.now() - requestStart) / 1000;

        const contentType = result.contentType || "audio/mpeg";
        res.setHeader("Content-Type", contentType);
        res.setHeader("Transfer-Encoding", "chunked");

        // Collect audio chunks for MinIO upload when conversationId is provided
        const audioChunks = conversationId ? [] : null;

        if (result.stream.pipe) {
            if (audioChunks) {
                result.stream.on("data", (chunk) => audioChunks.push(chunk));
            }
            result.stream.pipe(res);
            await new Promise((resolve) => result.stream.on("end", resolve));
        } else {
            // Handle web ReadableStream (from fetch)
            const reader = result.stream.getReader();
            const pump = async () => {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        res.end();
                        break;
                    }
                    if (audioChunks) audioChunks.push(Buffer.from(value));
                    res.write(value);
                }
            };
            await pump();
        }

        // Auto-append messages to conversation if conversationId is provided
        if (conversationId && audioChunks) {
            const project = req.project || "default";
            const usrname = req.username || "default";

            // Upload audio to MinIO
            let audioRef = null;
            try {
                const audioBuffer = Buffer.concat(audioChunks);
                const dataUrl = `data:${contentType};base64,${audioBuffer.toString("base64")}`;
                const { ref } = await FileService.uploadFile(
                    dataUrl,
                    "generations",
                    project,
                    usrname,
                );
                audioRef = ref;
            } catch (err) {
                logger.error(`Failed to upload TTS audio: ${err.message}`);
            }

            const messagesToAppend = [];
            if (userMessage) {
                messagesToAppend.push({
                    role: "user",
                    ...userMessage,
                    timestamp: userMessage.timestamp || new Date().toISOString(),
                });
            }

            messagesToAppend.push({
                role: "assistant",
                content: "",
                ...(audioRef && { audio: audioRef }),
                model: model || undefined,
                provider: providerName,
                voice: voice || undefined,
                timestamp: new Date().toISOString(),
                totalTime: parseFloat(totalSec.toFixed(3)),
            });

            ConversationService.appendMessages(
                conversationId,
                project,
                usrname,
                messagesToAppend,
            ).catch((err) =>
                logger.error(
                    `Failed to append messages to conversation ${conversationId}: ${err.message}`,
                ),
            );
        }
    } catch (error) {
        next(error);
    }
});

export default router;

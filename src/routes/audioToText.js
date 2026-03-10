import express from "express";
import { getProvider } from "../providers/index.js";
import { ProviderError } from "../utils/errors.js";
import RequestLogger from "../services/RequestLogger.js";
import logger from "../utils/logger.js";
import crypto from "crypto";
import { TYPES, getDefaultModels, getPricing } from "../config.js";
import { calculateAudioCost } from "../utils/CostCalculator.js";

const router = express.Router();

/**
 * POST /audio-to-text
 * Body: { provider, audio, mimeType?, model?, language?, prompt? }
 *   - audio: base64-encoded audio data (or data URL)
 *   - mimeType: e.g. "audio/wav", "audio/mp3", "audio/webm" (default: "audio/wav")
 * Response: { text, usage?, estimatedCost? }
 */
router.post("/", async (req, res, next) => {
    const requestId = crypto.randomUUID();
    const requestStart = performance.now();
    let providerName = null;
    let resolvedModel = null;

    try {
        const {
            provider: pName,
            audio,
            mimeType: rawMimeType,
            model,
            language,
            prompt,
        } = req.body;
        providerName = pName;

        if (!providerName) {
            throw new ProviderError(
                "server",
                "Missing required field: provider",
                400,
            );
        }
        if (!audio) {
            throw new ProviderError("server", "Missing required field: audio", 400);
        }

        const provider = getProvider(providerName);
        if (!provider.transcribeAudio) {
            throw new ProviderError(
                providerName,
                `Provider "${providerName}" does not support audio transcription`,
                400,
            );
        }

        // Parse audio data — support both raw base64 and data URLs
        let audioBase64 = audio;
        let mimeType = rawMimeType || "audio/wav";
        if (audio.startsWith("data:")) {
            const match = audio.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
                mimeType = match[1];
                audioBase64 = match[2];
            }
        }

        const audioBuffer = Buffer.from(audioBase64, "base64");
        resolvedModel =
            model || getDefaultModels(TYPES.AUDIO, TYPES.TEXT)[providerName];

        logger.info(
            `[audio-to-text] ${providerName} model=${resolvedModel} size=${audioBuffer.length}b`,
        );

        const result = await provider.transcribeAudio(
            audioBuffer,
            mimeType,
            resolvedModel,
            { language, prompt },
        );
        const totalSec = (performance.now() - requestStart) / 1000;

        // Estimate cost
        const pricing = getPricing(TYPES.AUDIO, TYPES.TEXT)[resolvedModel];
        const estimatedCost = calculateAudioCost(result.usage, pricing);

        logger.info(
            `[audio-to-text] ${providerName} ${resolvedModel} — ` +
            `total: ${totalSec.toFixed(2)}s` +
            (estimatedCost !== null ? `, cost: $${estimatedCost.toFixed(6)}` : ""),
        );

        // Fire-and-forget DB log
        RequestLogger.log({
            requestId,
            endpoint: "audio-to-text",
            project: req.project,
            username: req.username,
            provider: providerName,
            model: resolvedModel,
            success: true,
            inputTokens: result.usage?.inputTokens || 0,
            outputTokens: result.usage?.outputTokens || 0,
            estimatedCost,
            outputCharacters: result.text ? result.text.length : 0,
            totalTime: parseFloat(totalSec.toFixed(3)),
        });

        res.json({
            text: result.text,
            usage: result.usage || null,
            estimatedCost,
            totalTime: totalSec,
        });
    } catch (error) {
        const totalSec = (performance.now() - requestStart) / 1000;
        RequestLogger.log({
            requestId,
            endpoint: "audio-to-text",
            project: req.project,
            username: req.username,
            provider: providerName,
            model: resolvedModel,
            success: false,
            errorMessage: error.message,
            totalTime: totalSec,
        });
        next(error);
    }
});

export default router;

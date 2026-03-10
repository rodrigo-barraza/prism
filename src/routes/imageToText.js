import express from "express";
import crypto from "crypto";
import { getProvider } from "../providers/index.js";
import { ProviderError } from "../utils/errors.js";
import { TYPES, getDefaultModels, getPricing } from "../config.js";
import { calculateTextCost } from "../utils/CostCalculator.js";
import RequestLogger from "../services/RequestLogger.js";
import ConversationService from "../services/ConversationService.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * POST /image-to-text
 * Body: { provider, model?, image (URL or base64), prompt?, conversationId?, userMessage? }
 * Response: { text, provider, model, usage, estimatedCost }
 *
 * When conversationId is provided, the user message and caption result
 * are automatically appended to the conversation server-side.
 */
router.post("/", async (req, res, next) => {
    const requestId = crypto.randomUUID();
    const requestStart = performance.now();
    let providerName = null;
    let resolvedModel = null;

    try {
        const {
            provider: pName,
            model,
            image,
            prompt,
            conversationId,
            userMessage,
        } = req.body;
        providerName = pName;

        if (!providerName) {
            throw new ProviderError(
                "server",
                "Missing required field: provider",
                400,
            );
        }
        if (!image) {
            throw new ProviderError(
                "server",
                "Missing required field: image (URL or base64)",
                400,
            );
        }

        const provider = getProvider(providerName);
        if (!provider.captionImage) {
            throw new ProviderError(
                providerName,
                `Provider "${providerName}" does not support image captioning`,
                400,
            );
        }

        resolvedModel =
            model || getDefaultModels(TYPES.IMAGE, TYPES.TEXT)[providerName] || null;

        const result = await provider.captionImage(
            image,
            prompt,
            resolvedModel || model,
        );
        const totalSec = (performance.now() - requestStart) / 1000;

        const usage = result.usage || { inputTokens: 0, outputTokens: 0 };
        const pricing = getPricing(TYPES.IMAGE, TYPES.TEXT)[resolvedModel];
        const estimatedCost = calculateTextCost(usage, pricing);

        logger.info(
            `[image-to-text] ${providerName} model=${resolvedModel} — ` +
            `in: ${usage.inputTokens} tokens, out: ${usage.outputTokens} tokens, ` +
            `total: ${totalSec.toFixed(2)}s` +
            (estimatedCost !== null ? `, cost: $${estimatedCost.toFixed(6)}` : ""),
        );

        // Fire-and-forget DB log
        RequestLogger.log({
            requestId,
            endpoint: "image-to-text",
            project: req.project,
            username: req.username,
            provider: providerName,
            model: resolvedModel,
            success: true,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            estimatedCost,
            outputCharacters: result.text ? result.text.length : 0,
            totalTime: parseFloat(totalSec.toFixed(3)),
        });

        res.json({
            text: result.text,
            provider: providerName,
            model: resolvedModel,
            usage,
            estimatedCost,
        });

        // Auto-append messages to conversation if conversationId is provided
        if (conversationId) {
            const project = req.project || "default";
            const usrname = req.username || "default";
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
                content: result.text,
                model: resolvedModel,
                provider: providerName,
                timestamp: new Date().toISOString(),
                usage,
                totalTime: parseFloat(totalSec.toFixed(3)),
                estimatedCost,
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
        const totalSec = (performance.now() - requestStart) / 1000;
        RequestLogger.log({
            requestId,
            endpoint: "image-to-text",
            project: req.project,
            username: req.username,
            provider: providerName,
            model: resolvedModel,
            success: false,
            errorMessage: error.message,
            totalTime: parseFloat(totalSec.toFixed(3)),
        });
        next(error);
    }
});

export default router;

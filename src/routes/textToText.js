import express from "express";
import crypto from "crypto";
import { getProvider } from "../providers/index.js";
import { ProviderError } from "../utils/errors.js";
import { TYPES, getDefaultModels, getPricing } from "../config.js";
import { calculateTextCost } from "../utils/CostCalculator.js";
import logger from "../utils/logger.js";
import RequestLogger from "../services/RequestLogger.js";
import ConversationService from "../services/ConversationService.js";

const router = express.Router();

/**
 * POST /text-to-text
 * Body: { provider, model?, messages, options?, conversationId?, userMessage? }
 * Response: { text, provider, model, usage, estimatedCost }
 *
 * When conversationId is provided, the user message and assistant response
 * are automatically appended to the conversation server-side.
 */
router.post("/", async (req, res, next) => {
    const requestStart = performance.now();
    const requestId = crypto.randomUUID();
    let providerName = null;
    let resolvedModel = null;

    try {
        const {
            provider: pName,
            model,
            messages,
            options,
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
        if (!messages || !Array.isArray(messages)) {
            throw new ProviderError(
                "server",
                "Missing or invalid field: messages (must be an array)",
                400,
            );
        }

        const provider = getProvider(providerName);
        if (!provider.generateText) {
            throw new ProviderError(
                providerName,
                `Provider "${providerName}" does not support text generation`,
                400,
            );
        }

        resolvedModel =
            model || getDefaultModels(TYPES.TEXT, TYPES.TEXT)[providerName];
        const generationStart = performance.now();
        const result = await provider.generateText(
            messages,
            resolvedModel,
            options || {},
        );
        const now = performance.now();
        const timeToGenerationSec = (generationStart - requestStart) / 1000;
        const generationSec = (now - generationStart) / 1000;
        const totalSec = (now - requestStart) / 1000;

        const usage = result.usage || { inputTokens: 0, outputTokens: 0 };
        const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
        const estimatedCost = calculateTextCost(usage, pricing);
        const tokensPerSec =
            generationSec > 0
                ? (usage.outputTokens / generationSec).toFixed(1)
                : "N/A";

        logger.info(
            `[${providerName}] ${resolvedModel} — ` +
            `in: ${usage.inputTokens} tokens, out: ${usage.outputTokens} tokens, ` +
            `speed: ${tokensPerSec} tok/s, ` +
            `ttg: ${timeToGenerationSec.toFixed(2)}s, ` +
            `generation: ${generationSec.toFixed(2)}s, ` +
            `total: ${totalSec.toFixed(2)}s` +
            (estimatedCost !== null ? `, cost: $${estimatedCost.toFixed(6)}` : ""),
        );

        // Fire-and-forget DB log
        RequestLogger.log({
            requestId,
            endpoint: "text-to-text",
            project: req.project,
            username: req.username,
            provider: providerName,
            model: resolvedModel,
            success: true,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            estimatedCost,
            tokensPerSec: parseFloat(tokensPerSec) || null,
            temperature: options?.temperature ?? null,
            maxTokens: options?.maxTokens ?? null,
            topP: options?.topP ?? null,
            topK: options?.topK ?? null,
            frequencyPenalty: options?.frequencyPenalty ?? null,
            presencePenalty: options?.presencePenalty ?? null,
            stopSequences: options?.stopSequences ?? null,
            messageCount: messages.length,
            inputCharacters: messages.reduce(
                (sum, m) =>
                    sum + (typeof m.content === "string" ? m.content.length : 0),
                0,
            ),
            outputCharacters: result.text ? result.text.length : 0,
            timeToGeneration: parseFloat(timeToGenerationSec.toFixed(3)),
            generationTime: parseFloat(generationSec.toFixed(3)),
            totalTime: parseFloat(totalSec.toFixed(3)),
        });

        res.json({
            text: result.text,
            thinking: result.thinking || null,
            provider: providerName,
            model: resolvedModel,
            usage,
            estimatedCost,
        });

        // Auto-append messages to conversation if conversationId is provided
        if (conversationId) {
            const project = req.project || "default";
            const username = req.username || "default";
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
                thinking: result.thinking || undefined,
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
                username,
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
            endpoint: "text-to-text",
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

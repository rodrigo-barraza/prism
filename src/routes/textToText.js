import express from 'express';
import { getProvider } from '../providers/index.js';
import { ProviderError } from '../utils/errors.js';
import { TEXT2TEXT_PRICING } from '../pricing.js';
import { TEXT2TEXT_DEFAULT_MODELS } from '../config.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * POST /text-to-text
 * Body: { provider, model?, messages, options? }
 * Response: { text, provider, model, usage, estimatedCost }
 */
router.post('/', async (req, res, next) => {
    try {
        const { provider: providerName, model, messages, options } = req.body;

        if (!providerName) {
            throw new ProviderError('server', 'Missing required field: provider', 400);
        }
        if (!messages || !Array.isArray(messages)) {
            throw new ProviderError('server', 'Missing or invalid field: messages (must be an array)', 400);
        }

        const provider = getProvider(providerName);
        if (!provider.generateText) {
            throw new ProviderError(providerName, `Provider "${providerName}" does not support text generation`, 400);
        }

        const resolvedModel = model || TEXT2TEXT_DEFAULT_MODELS[providerName];
        const startTime = performance.now();
        const result = await provider.generateText(messages, resolvedModel, options || {});
        const elapsedSec = (performance.now() - startTime) / 1000;

        const usage = result.usage || { inputTokens: 0, outputTokens: 0 };
        const pricing = TEXT2TEXT_PRICING[resolvedModel];
        let estimatedCost = null;
        if (pricing) {
            estimatedCost =
                (usage.inputTokens / 1_000_000) * pricing.inputPerMillion +
                (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
        }
        const tokensPerSec = elapsedSec > 0 ? (usage.outputTokens / elapsedSec).toFixed(1) : "N/A";

        logger.info(
            `[${providerName}] ${resolvedModel} — ` +
            `in: ${usage.inputTokens} tokens, out: ${usage.outputTokens} tokens, ` +
            `speed: ${tokensPerSec} tok/s` +
            (estimatedCost !== null ? `, cost: $${estimatedCost.toFixed(6)}` : ""),
        );

        res.json({
            text: result.text,
            provider: providerName,
            model: resolvedModel,
            usage,
            estimatedCost,
        });
    } catch (error) {
        next(error);
    }
});

export default router;

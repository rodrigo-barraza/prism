import express from 'express';
import crypto from 'crypto';
import { getProvider } from '../providers/index.js';
import { ProviderError } from '../utils/errors.js';
import { TYPES, getDefaultModels, getPricing } from '../config.js';
import logger from '../utils/logger.js';
import RequestLogger from '../services/RequestLogger.js';

const router = express.Router();

/**
 * POST /text-to-text
 * Body: { provider, model?, messages, options? }
 * Response: { text, provider, model, usage, estimatedCost }
 */
router.post('/', async (req, res, next) => {
  const requestStart = performance.now();
  const requestId = crypto.randomUUID();
  let providerName = null;
  let resolvedModel = null;

  try {
    const { provider: pName, model, messages, options } = req.body;
    providerName = pName;

    if (!providerName) {
      throw new ProviderError(
        'server',
        'Missing required field: provider',
        400,
      );
    }
    if (!messages || !Array.isArray(messages)) {
      throw new ProviderError(
        'server',
        'Missing or invalid field: messages (must be an array)',
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
    let estimatedCost = null;
    if (pricing) {
      estimatedCost =
        (usage.inputTokens / 1_000_000) * pricing.inputPerMillion +
        (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
    }
    const tokensPerSec =
      generationSec > 0
        ? (usage.outputTokens / generationSec).toFixed(1)
        : 'N/A';

    logger.info(
      `[${providerName}] ${resolvedModel} — ` +
        `in: ${usage.inputTokens} tokens, out: ${usage.outputTokens} tokens, ` +
        `speed: ${tokensPerSec} tok/s, ` +
        `ttg: ${timeToGenerationSec.toFixed(2)}s, ` +
        `generation: ${generationSec.toFixed(2)}s, ` +
        `total: ${totalSec.toFixed(2)}s` +
        (estimatedCost !== null ? `, cost: $${estimatedCost.toFixed(6)}` : ''),
    );

    // Fire-and-forget DB log
    RequestLogger.log({
      requestId,
      endpoint: 'text-to-text',
      project: req.project,
      provider: providerName,
      model: resolvedModel,
      success: true,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCost,
      tokensPerSec: parseFloat(tokensPerSec) || null,
      temperature: options?.temperature ?? null,
      maxTokens: options?.maxTokens ?? null,
      messageCount: messages.length,
      inputCharacters: messages.reduce(
        (sum, m) =>
          sum + (typeof m.content === 'string' ? m.content.length : 0),
        0,
      ),
      outputCharacters: result.text ? result.text.length : 0,
      timeToGeneration: timeToGenerationSec,
      generationTime: generationSec,
      totalTime: totalSec,
    });

    res.json({
      text: result.text,
      provider: providerName,
      model: resolvedModel,
      usage,
      estimatedCost,
    });
  } catch (error) {
    const totalSec = (performance.now() - requestStart) / 1000;
    RequestLogger.log({
      requestId,
      endpoint: 'text-to-text',
      project: req.project,
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

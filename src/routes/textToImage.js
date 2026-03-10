import express from 'express';
import { getProvider } from '../providers/index.js';
import { ProviderError } from '../utils/errors.js';
import RequestLogger from '../services/RequestLogger.js';
import logger from '../utils/logger.js';
import crypto from 'crypto';

const router = express.Router();

/**
 * POST /text-to-image
 * Body: { provider, model?, prompt, images? }
 * Response: { imageData (base64), mimeType, text?, provider }
 */
router.post('/', async (req, res, next) => {
  const requestId = crypto.randomUUID();
  const requestStart = performance.now();
  let providerName = null;
  let resolvedModel = null;

  try {
    const { provider: pName, model, prompt, images } = req.body;
    providerName = pName;
    resolvedModel = model || null;

    if (!providerName) {
      throw new ProviderError(
        'server',
        'Missing required field: provider',
        400,
      );
    }
    if (!prompt) {
      throw new ProviderError('server', 'Missing required field: prompt', 400);
    }

    const provider = getProvider(providerName);
    if (!provider.generateImage) {
      throw new ProviderError(
        providerName,
        `Provider "${providerName}" does not support image generation`,
        400,
      );
    }

    const result = await provider.generateImage(prompt, images || [], model);
    const totalSec = (performance.now() - requestStart) / 1000;

    logger.info(
      `[text-to-image] ${providerName} model=${resolvedModel} — ` +
        `total: ${totalSec.toFixed(2)}s`,
    );

    // Fire-and-forget DB log
    RequestLogger.log({
      requestId,
      endpoint: 'text-to-image',
      project: req.project,
      username: req.username,
      provider: providerName,
      model: resolvedModel,
      success: true,
      inputCharacters: prompt.length,
      outputCharacters: result.text ? result.text.length : 0,
      totalTime: totalSec,
    });

    res.json({
      imageData: result.imageData,
      mimeType: result.mimeType || 'image/png',
      text: result.text || null,
      provider: providerName,
    });
  } catch (error) {
    const totalSec = (performance.now() - requestStart) / 1000;
    RequestLogger.log({
      requestId,
      endpoint: 'text-to-image',
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

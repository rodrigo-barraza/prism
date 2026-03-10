import express from 'express';
import { getProvider } from '../providers/index.js';
import { ProviderError } from '../utils/errors.js';
import RequestLogger from '../services/RequestLogger.js';
import logger from '../utils/logger.js';
import crypto from 'crypto';

const router = express.Router();

/**
 * POST /image-to-text
 * Body: { provider, model?, image (URL or base64), prompt? }
 * Response: { text, provider }
 */
router.post('/', async (req, res, next) => {
  const requestId = crypto.randomUUID();
  const requestStart = performance.now();
  let providerName = null;
  let resolvedModel = null;

  try {
    const { provider: pName, model, image, prompt } = req.body;
    providerName = pName;
    resolvedModel = model || null;

    if (!providerName) {
      throw new ProviderError(
        'server',
        'Missing required field: provider',
        400,
      );
    }
    if (!image) {
      throw new ProviderError(
        'server',
        'Missing required field: image (URL or base64)',
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

    const result = await provider.captionImage(image, prompt, model);
    const totalSec = (performance.now() - requestStart) / 1000;

    logger.info(
      `[image-to-text] ${providerName} model=${resolvedModel} — ` +
        `total: ${totalSec.toFixed(2)}s`,
    );

    // Fire-and-forget DB log
    RequestLogger.log({
      requestId,
      endpoint: 'image-to-text',
      project: req.project,
      username: req.username,
      provider: providerName,
      model: resolvedModel,
      success: true,
      outputCharacters: result.text ? result.text.length : 0,
      totalTime: totalSec,
    });

    res.json({
      text: result.text,
      provider: providerName,
    });
  } catch (error) {
    const totalSec = (performance.now() - requestStart) / 1000;
    RequestLogger.log({
      requestId,
      endpoint: 'image-to-text',
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

import express from 'express';
import { getProvider } from '../providers/index.js';
import { ProviderError } from '../utils/errors.js';

const router = express.Router();

/**
 * POST /text-to-image
 * Body: { provider, model?, prompt, images? }
 * Response: { imageData (base64), mimeType, text?, provider }
 */
router.post('/', async (req, res, next) => {
    try {
        const { provider: providerName, model, prompt, images } = req.body;

        if (!providerName) {
            throw new ProviderError('server', 'Missing required field: provider', 400);
        }
        if (!prompt) {
            throw new ProviderError('server', 'Missing required field: prompt', 400);
        }

        const provider = getProvider(providerName);
        if (!provider.generateImage) {
            throw new ProviderError(providerName, `Provider "${providerName}" does not support image generation`, 400);
        }

        const result = await provider.generateImage(prompt, images || [], model);
        res.json({
            imageData: result.imageData,
            mimeType: result.mimeType || 'image/png',
            text: result.text || null,
            provider: providerName,
        });
    } catch (error) {
        next(error);
    }
});

export default router;

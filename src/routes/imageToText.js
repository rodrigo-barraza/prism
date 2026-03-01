import express from 'express';
import { getProvider } from '../providers/index.js';
import { ProviderError } from '../utils/errors.js';

const router = express.Router();

/**
 * POST /image-to-text
 * Body: { provider, model?, image (URL or base64), prompt? }
 * Response: { text, provider }
 */
router.post('/', async (req, res, next) => {
    try {
        const { provider: providerName, model, image, prompt } = req.body;

        if (!providerName) {
            throw new ProviderError('server', 'Missing required field: provider', 400);
        }
        if (!image) {
            throw new ProviderError('server', 'Missing required field: image (URL or base64)', 400);
        }

        const provider = getProvider(providerName);
        if (!provider.captionImage) {
            throw new ProviderError(providerName, `Provider "${providerName}" does not support image captioning`, 400);
        }

        const result = await provider.captionImage(image, prompt, model);
        res.json({
            text: result.text,
            provider: providerName,
        });
    } catch (error) {
        next(error);
    }
});

export default router;

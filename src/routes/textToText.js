import express from 'express';
import { getProvider } from '../providers/index.js';
import { ProviderError } from '../utils/errors.js';

const router = express.Router();

/**
 * POST /text-to-text
 * Body: { provider, model?, messages, options? }
 * Response: { text, provider, model }
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

        const result = await provider.generateText(messages, model, options || {});
        res.json({
            text: result.text,
            provider: providerName,
            model: model || 'default',
        });
    } catch (error) {
        next(error);
    }
});

export default router;

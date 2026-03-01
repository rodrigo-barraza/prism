import express from 'express';
import { getProvider } from '../providers/index.js';
import { ProviderError } from '../utils/errors.js';

const router = express.Router();

/**
 * POST /text-to-speech
 * Body: { provider, text, voice?, instructions?, model?, options? }
 * Response: binary audio stream with content-type header
 */
router.post('/', async (req, res, next) => {
    try {
        const { provider: providerName, text, voice, instructions, model, options: extraOptions } = req.body;

        if (!providerName) {
            throw new ProviderError('server', 'Missing required field: provider', 400);
        }
        if (!text) {
            throw new ProviderError('server', 'Missing required field: text', 400);
        }

        const provider = getProvider(providerName);
        if (!provider.generateSpeech) {
            throw new ProviderError(providerName, `Provider "${providerName}" does not support text-to-speech`, 400);
        }

        const options = { instructions, model, ...extraOptions };
        const result = await provider.generateSpeech(text, voice, options);

        res.setHeader('Content-Type', result.contentType || 'audio/mpeg');
        res.setHeader('Transfer-Encoding', 'chunked');

        if (result.stream.pipe) {
            result.stream.pipe(res);
        } else {
            // Handle web ReadableStream (from fetch)
            const reader = result.stream.getReader();
            const pump = async () => {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        res.end();
                        break;
                    }
                    res.write(value);
                }
            };
            await pump();
        }
    } catch (error) {
        next(error);
    }
});

export default router;

import express from 'express';
import { getProvider } from '../providers/index.js';
import { ProviderError } from '../utils/errors.js';
import { TYPES, getPricing } from '../config.js';
import { calculateImageCost } from '../utils/CostCalculator.js';
import RequestLogger from '../services/RequestLogger.js';
import FileService from '../services/FileService.js';
import logger from '../utils/logger.js';
import crypto from 'crypto';

const router = express.Router();

/**
 * POST /text-to-image
 * Body: { provider, model?, prompt, images? }
 * Response: { imageData (base64), mimeType, text?, provider, minioRef? }
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

        // Calculate estimated cost
        // Output image tokens by provider's hardcoded size: OpenAI 1024×1024 ≈ 1056, Google 1K ≈ 258
        const pricing = getPricing(TYPES.TEXT, TYPES.IMAGE)[resolvedModel];
        const outputImageTokens = providerName === 'openai' ? 1056 : 258;
        const estimatedCost = calculateImageCost(prompt, pricing, (images || []).length, outputImageTokens);

        logger.info(
            `[text-to-image] ${providerName} model=${resolvedModel} — ` +
            `total: ${totalSec.toFixed(2)}s` +
            (estimatedCost !== null ? `, cost: $${estimatedCost.toFixed(6)}` : ''),
        );

        // Store generated image in MinIO (fire-and-forget)
        let minioRef = null;
        if (result.imageData) {
            try {
                const mimeType = result.mimeType || 'image/png';
                const dataUrl = `data:${mimeType};base64,${result.imageData}`;
                const project = req.project || 'default';
                const username = req.username || 'default';
                const { ref } = await FileService.uploadFile(dataUrl, 'generations', project, username);
                minioRef = ref;
            } catch (uploadErr) {
                logger.error(`[text-to-image] MinIO upload failed: ${uploadErr.message}`);
            }
        }

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
            estimatedCost,
            totalTime: parseFloat(totalSec.toFixed(3)),
        });

        res.json({
            imageData: result.imageData,
            mimeType: result.mimeType || 'image/png',
            text: result.text || null,
            provider: providerName,
            minioRef,
            estimatedCost,
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
            totalTime: parseFloat(totalSec.toFixed(3)),
        });
        next(error);
    }
});

export default router;

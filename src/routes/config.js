import express from 'express';
import * as config from '../config.js';

const router = express.Router();

/**
 * GET /config
 * Returns the full catalog of providers, models, voices, and capabilities.
 */
router.get('/', (_req, res) => {
    res.json({
        providers: config.PROVIDERS,
        providerList: config.PROVIDER_LIST,
        capabilities: config.PROVIDER_CAPABILITIES,
        textToText: {
            models: config.TEXT2TEXT_MODEL_OPTIONS,
            defaults: config.TEXT2TEXT_DEFAULT_MODELS,
        },
        textToSpeech: {
            models: config.TEXT2SPEECH_MODEL_OPTIONS,
            defaults: config.TEXT2SPEECH_DEFAULT_MODELS,
            voices: config.TEXT2SPEECH_VOICES,
            defaultVoices: config.TEXT2SPEECH_DEFAULT_VOICES,
        },
        textToImage: {
            models: config.TEXT2IMAGE_MODEL_OPTIONS,
            defaults: config.TEXT2IMAGE_DEFAULT_MODELS,
        },
        imageToText: {
            models: config.IMAGE2TEXT_MODEL_OPTIONS,
            defaults: config.IMAGE2TEXT_DEFAULT_MODELS,
        },
        embedding: {
            models: config.EMBEDDING_MODEL_OPTIONS,
            defaults: config.EMBEDDING_DEFAULT_MODELS,
        },
    });
});

export default router;

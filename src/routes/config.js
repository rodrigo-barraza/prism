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
      models: config.TEXT2TEXT.MODEL_OPTIONS,
      defaults: config.TEXT2TEXT.DEFAULT_MODELS,
    },
    textToSpeech: {
      models: config.TEXT2SPEECH.MODEL_OPTIONS,
      defaults: config.TEXT2SPEECH.DEFAULT_MODELS,
      voices: config.TEXT2SPEECH.VOICES,
      defaultVoices: config.TEXT2SPEECH.DEFAULT_VOICES,
    },
    textToImage: {
      models: config.TEXT2IMAGE.MODEL_OPTIONS,
      defaults: config.TEXT2IMAGE.DEFAULT_MODELS,
    },
    imageToText: {
      models: config.IMAGE2TEXT.MODEL_OPTIONS,
      defaults: config.IMAGE2TEXT.DEFAULT_MODELS,
    },
    embedding: {
      models: config.EMBEDDING.MODEL_OPTIONS,
      defaults: config.EMBEDDING.DEFAULT_MODELS,
    },
  });
});

export default router;

import express from 'express';
import {
  PROVIDERS,
  PROVIDER_LIST,
  TYPES,
  VOICES,
  DEFAULT_VOICES,
  getModelOptions,
  getDefaultModels,
} from '../config.js';

const router = express.Router();

/**
 * GET /config
 * Returns the full catalog of providers, models, voices, and capabilities.
 */
router.get('/', (_req, res) => {
  res.json({
    providers: PROVIDERS,
    providerList: PROVIDER_LIST,
    textToText: {
      models: getModelOptions(TYPES.TEXT, TYPES.TEXT),
      defaults: getDefaultModels(TYPES.TEXT, TYPES.TEXT),
    },
    textToSpeech: {
      models: getModelOptions(TYPES.TEXT, TYPES.AUDIO),
      defaults: getDefaultModels(TYPES.TEXT, TYPES.AUDIO),
      voices: VOICES,
      defaultVoices: DEFAULT_VOICES,
    },
    textToImage: {
      models: getModelOptions(TYPES.TEXT, TYPES.IMAGE),
      defaults: getDefaultModels(TYPES.TEXT, TYPES.IMAGE),
    },
    imageToText: {
      models: getModelOptions(TYPES.IMAGE, TYPES.TEXT),
      defaults: getDefaultModels(TYPES.IMAGE, TYPES.TEXT),
    },
    embedding: {
      models: getModelOptions(TYPES.TEXT, TYPES.EMBEDDING),
      defaults: getDefaultModels(TYPES.TEXT, TYPES.EMBEDDING),
    },
    audioToText: {
      models: getModelOptions(TYPES.AUDIO, TYPES.TEXT),
      defaults: getDefaultModels(TYPES.AUDIO, TYPES.TEXT),
    },
  });
});

export default router;

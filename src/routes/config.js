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
import { getProvider } from '../providers/index.js';
import { ARENA_SCORES } from '../arrays.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Look up arena scores for a model name from ARENA_SCORES.
 * Tries exact match first, then checks if an arena entry name
 * is contained within the model name (for versioned names like
 * "claude-haiku-4-5-20251001" matching "claude-haiku-4-5-20251001").
 *
 * Returns an arena object like { text: 1406, code: 1310, ... } or null.
 */
function lookupArenaScores(modelName) {
  const arena = {};
  const key = modelName.toLowerCase();

  // Strip path prefix (e.g. "google/gemma-3-12b" → "gemma-3-12b")
  // and quantization suffix (e.g. "qwen3-32b@q4_k_m" → "qwen3-32b")
  const stripped = key.includes('/') ? key.split('/').pop() : key;
  const cleaned = stripped.includes('@') ? stripped.split('@')[0] : stripped;

  for (const [category, scores] of Object.entries(ARENA_SCORES)) {
    if (!scores || typeof scores !== 'object') continue;

    let bestMatch = null;
    let bestLen = 0;

    for (const [arenaName, score] of Object.entries(scores)) {
      const an = arenaName.toLowerCase();

      // Exact match on raw key or cleaned key
      if (key === an || cleaned === an) {
        bestMatch = score;
        break;
      }

      // Check both directions of startsWith/includes using cleaned key
      const matched =
        cleaned.startsWith(an) || an.startsWith(cleaned) ||
        key.includes(an) || an.includes(cleaned);

      if (matched && an.length > bestLen) {
        bestMatch = score;
        bestLen = an.length;
      }
    }

    if (bestMatch !== null) {
      arena[category] = bestMatch;
    }
  }

  return Object.keys(arena).length > 0 ? arena : null;
}

/**
 * Enrich all models in a provider map with arena scores from ARENA_SCORES.
 * Merges with any existing arena data on the model (existing takes priority).
 */
function enrichModelsWithArenaScores(modelsMap) {
  for (const provider of Object.keys(modelsMap)) {
    for (const model of modelsMap[provider]) {
      const scores = lookupArenaScores(model.name);
      if (scores) {
        // Merge: existing hardcoded arena data takes priority
        model.arena = { ...scores, ...(model.arena || {}) };
      }
    }
  }
  return modelsMap;
}

/**
 * Format a byte count into a human-readable size string.
 */
function formatBytes(bytes) {
  if (!bytes) return null;
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * Fetch LM Studio models and convert them to the config model format.
 * Returns an array of model option objects for the 'lm-studio' provider.
 */
async function getLmStudioModelOptions() {
  try {
    const provider = getProvider('lm-studio');
    const { models } = await provider.listModels();
    if (!models || !Array.isArray(models)) return [];

    return models
      .filter((m) => m.type === 'llm')
      .map((m) => {
        // Build label with quantization suffix to disambiguate
        let label = m.display_name || m.key;
        if (m.quantization?.name) {
          label += ` (${m.quantization.name})`;
        }

        const entry = {
          name: m.key,
          label,
          inputTypes: [TYPES.TEXT],
          outputTypes: [TYPES.TEXT],
          streaming: true,
          defaultTemperature: 0.7,
          pricing: { inputPerMillion: 0, outputPerMillion: 0 },
        };
        if (m.capabilities?.vision) {
          entry.vision = true;
          entry.inputTypes = [TYPES.TEXT, TYPES.IMAGE];
        }
        if (m.max_context_length) {
          entry.contextLength = m.max_context_length;
        }
        if (m.size_bytes) {
          entry.size = formatBytes(m.size_bytes);
        }
        if (m.params_string) {
          entry.params = m.params_string;
        }
        if (m.quantization?.name) {
          entry.quantization = m.quantization.name;
        }
        if (m.architecture) {
          entry.architecture = m.architecture;
        }
        if (m.loaded_instances?.length > 0) {
          entry.loaded = true;
        }
        return entry;
      });
  } catch (err) {
    logger.warn(`Could not fetch LM Studio models for config: ${err.message}`);
    return [];
  }
}

/**
 * GET /config
 * Returns the full catalog of providers, models, voices, and capabilities.
 */
router.get('/', async (_req, res) => {
  // Get static model options
  const textToTextModels = getModelOptions(TYPES.TEXT, TYPES.TEXT);
  const textToImageModels = getModelOptions(TYPES.TEXT, TYPES.IMAGE);

  // Merge dynamic LM Studio models into lm-studio provider
  try {
    const lmModels = await getLmStudioModelOptions();
    if (lmModels.length > 0) {
      const staticLmModels = textToTextModels['lm-studio'] || [];
      const staticKeys = new Set(staticLmModels.map((m) => m.name));
      // Add dynamically discovered models that aren't already in the static list
      for (const m of lmModels) {
        if (!staticKeys.has(m.name)) {
          staticLmModels.push(m);
        }
      }
      textToTextModels['lm-studio'] = staticLmModels;
    }
  } catch {
    // Ignore — use static models only
  }

  // Enrich ALL model lists with arena scores from the scraped leaderboard data
  enrichModelsWithArenaScores(textToTextModels);
  enrichModelsWithArenaScores(textToImageModels);

  res.json({
    providers: PROVIDERS,
    providerList: PROVIDER_LIST,
    textToText: {
      models: textToTextModels,
      defaults: getDefaultModels(TYPES.TEXT, TYPES.TEXT),
    },
    textToSpeech: {
      models: getModelOptions(TYPES.TEXT, TYPES.AUDIO),
      defaults: getDefaultModels(TYPES.TEXT, TYPES.AUDIO),
      voices: VOICES,
      defaultVoices: DEFAULT_VOICES,
    },
    textToImage: {
      models: textToImageModels,
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

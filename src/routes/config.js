import express from "express";
import {
  PROVIDERS,
  PROVIDER_LIST,
  TYPES,
  VOICES,
  DEFAULT_VOICES,
  getModelOptions,
  getDefaultModels,
} from "../config.js";
import { getProvider } from "../providers/index.js";
import { ARENA_SCORES } from "../arrays.js";
import logger from "../utils/logger.js";
import ToolOrchestratorService from "../services/ToolOrchestratorService.js";
import {
  OPENAI_API_KEY,
  ANTHROPIC_API_KEY,
  GOOGLE_API_KEY,
  ELEVENLABS_API_KEY,
  INWORLD_BASIC,
  LM_STUDIO_BASE_URL,
  VLLM_BASE_URL,
  OLLAMA_BASE_URL,
} from "../../secrets.js";

const router = express.Router();

// Map each provider to its secret — provider is "available" when secret is truthy
const PROVIDER_SECRETS = {
  [PROVIDERS.OPENAI]: OPENAI_API_KEY,
  [PROVIDERS.ANTHROPIC]: ANTHROPIC_API_KEY,
  [PROVIDERS.GOOGLE]: GOOGLE_API_KEY,
  [PROVIDERS.ELEVENLABS]: ELEVENLABS_API_KEY,
  [PROVIDERS.INWORLD]: INWORLD_BASIC,
  [PROVIDERS.LM_STUDIO]: LM_STUDIO_BASE_URL,
  [PROVIDERS.VLLM]: VLLM_BASE_URL,
  [PROVIDERS.OLLAMA]: OLLAMA_BASE_URL,
};

const AVAILABLE_PROVIDERS = new Set(
  Object.entries(PROVIDER_SECRETS)
    .filter(([, secret]) => !!secret)
    .map(([provider]) => provider),
);

/** Keep only available provider keys in a models map. */
function filterByAvailableProviders(modelsMap) {
  const filtered = {};
  for (const [provider, models] of Object.entries(modelsMap)) {
    if (AVAILABLE_PROVIDERS.has(provider)) {
      filtered[provider] = models;
    }
  }
  return filtered;
}

/** Filter defaults to only include available providers. */
function filterDefaults(defaults) {
  const filtered = {};
  for (const [provider, model] of Object.entries(defaults)) {
    if (AVAILABLE_PROVIDERS.has(provider)) {
      filtered[provider] = model;
    }
  }
  return filtered;
}

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
  const stripped = key.includes("/") ? key.split("/").pop() : key;
  const cleaned = stripped.includes("@") ? stripped.split("@")[0] : stripped;

  for (const [category, scores] of Object.entries(ARENA_SCORES)) {
    if (!scores || typeof scores !== "object") continue;

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
        cleaned.startsWith(an) ||
        an.startsWith(cleaned) ||
        key.includes(an) ||
        an.includes(cleaned);

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

// ── Model capability detection patterns ─────────────────────────
// Used by getLmStudioModelOptions, getVllmModelOptions, getOllamaModelOptions

const THINKING_PATTERNS = ["qwen3", "deepseek-r1", "deepseek-v3", "gpt-oss"];

const FC_PATTERNS = [
  "qwen", "deepseek", "llama", "mistral", "gemma",
  "phi", "command", "hermes", "functionary",
];

const VISION_PATTERNS = [
  "vl", "vision", "llava", "pixtral", "minicpm-v",
  "internvl", "cogvlm", "qwen2.5-vl", "qwen2-vl", "qwen3-vl",
  "molmo", "paligemma", "llama-3.2-vision", "llama-vision",
  "idefics", "phi-3-vision", "phi-3.5-vision", "phi-4-vision",
  "phi4mm", "minicpmv", "ovis", "deepseek-vl",
];

const VIDEO_PATTERNS = [
  "qwen2.5-vl", "qwen2-vl", "qwen3-vl",
  "llava-next-video", "llava-onevision",
  "internvl", "phi4mm",
];

const AUDIO_PATTERNS = [
  "qwen2-audio", "qwen-audio", "salmonn",
  "ultravox", "phi4mm", "minicpmo",
  "whisper", "granite-speech", "kimi-audio",
  "qwen2.5-omni", "qwen3-omni",
];

/** Check if a lowercased model name matches any pattern in a list. */
function matchesAny(nameLower, patterns) {
  return patterns.some((p) => nameLower.includes(p));
}

/**
 * Merge dynamic models into the static models map for a provider.
 * Skips models whose name already exists in the static list.
 */
function mergeDynamicModels(modelsMap, providerKey, dynamicModels) {
  if (!dynamicModels || dynamicModels.length === 0) return;
  const existing = modelsMap[providerKey] || [];
  const existingKeys = new Set(existing.map((m) => m.name));
  for (const m of dynamicModels) {
    if (!existingKeys.has(m.name)) {
      existing.push(m);
    }
  }
  modelsMap[providerKey] = existing;
}

/**
 * Fetch LM Studio models and convert them to the config model format.
 * Returns an array of model option objects for the 'lm-studio' provider.
 */
async function getLmStudioModelOptions() {
  try {
    const provider = getProvider("lm-studio");
    const { models } = await provider.listModels();
    if (!models || !Array.isArray(models)) return [];

    return models
      .filter((m) => m.type === "llm")
      .map((m) => {
        // Build label with quantization suffix to disambiguate
        let label = m.display_name || m.key;
        if (m.quantization?.name) {
          label += ` (${m.quantization.name})`;
        }

        const nameLower = (m.key || "").toLowerCase();

        // Detect thinking-capable models by name/family
        const supportsThinking = matchesAny(nameLower, THINKING_PATTERNS);

        // Detect function calling support — LM Studio API: capabilities.trained_for_tool_use
        const supportsFunctionCalling = !!m.capabilities?.trained_for_tool_use;

        const tools = [];
        if (supportsThinking) tools.push("Thinking");
        if (supportsFunctionCalling) tools.push("Function Calling");

        const entry = {
          name: m.key,
          label,
          modelType: "conversation",
          inputTypes: [TYPES.TEXT],
          outputTypes: [TYPES.TEXT],
          supportsSystemPrompt: true,
          streaming: true,
          defaultTemperature: 0.7,
          pricing: { inputPerMillion: 0, outputPerMillion: 0 },
        };
        if (tools.length > 0) {
          entry.tools = tools;
        }
        if (supportsThinking) {
          entry.thinking = true;
        }
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
        if (m.quantization?.bits_per_weight != null) {
          entry.bitsPerWeight = m.quantization.bits_per_weight;
        }
        if (m.architecture) {
          entry.architecture = m.architecture;
        }
        if (m.publisher) {
          entry.publisher = m.publisher;
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

// ── HuggingFace Hub metadata cache ──────────────────────────────
// TTL-based in-memory cache so we don't hit HF on every /config request.
const _hfCache = new Map(); // key → { data, timestamp }
const HF_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch model metadata from HuggingFace Hub API.
 * Returns null on any failure (gated models, network errors, etc.).
 * Results are cached in-memory with a 30-minute TTL.
 */
async function fetchHuggingFaceMetadata(modelId) {
  // Check cache first
  const cached = _hfCache.get(modelId);
  if (cached && Date.now() - cached.timestamp < HF_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const res = await fetch(`https://huggingface.co/api/models/${modelId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000), // 5s timeout
    });
    if (!res.ok) {
      _hfCache.set(modelId, { data: null, timestamp: Date.now() });
      return null;
    }
    const data = await res.json();
    const meta = {
      architectures: data.config?.architectures || [],
      modelType: data.config?.model_type || null,
      pipelineTag: data.pipeline_tag || null,
      tags: data.tags || [],
      author: data.author || null,
      totalParams: data.safetensors?.total || null,
      totalSize: data.usedStorage || null,
      paramsByDtype: data.safetensors?.parameters || null,
    };
    _hfCache.set(modelId, { data: meta, timestamp: Date.now() });
    return meta;
  } catch {
    _hfCache.set(modelId, { data: null, timestamp: Date.now() });
    return null;
  }
}

// ── Name-based model attribute parsing ──────────────────────────

/** Extract parameter count from model name (e.g. "qwen3-8b" → "8B"). */
function parseParamsFromName(name) {
  // Match patterns like "8b", "70b", "1.6b", "0.5b", "8x7b" (MoE)
  const match = name.match(/[-_](\d+(?:\.\d+)?[bB])\b/);
  if (match) return match[1].toUpperCase();
  // MoE pattern: "8x7b"
  const moeMatch = name.match(/[-_](\d+x\d+(?:\.\d+)?[bB])\b/);
  if (moeMatch) return moeMatch[1].toUpperCase();
  return null;
}

/** Extract quantization from model name (e.g. "model-AWQ" → "AWQ"). */
function parseQuantFromName(name) {
  // Common quantization suffixes
  const quantPatterns = [
    /[-_](AWQ)\b/i,
    /[-_](GPTQ)\b/i,
    /[-_](GGUF)\b/i,
    /[-_](EXL2)\b/i,
    /[-_](FP8)\b/i,
    /[-_](FP16)\b/i,
    /[-_](BF16)\b/i,
    /[-_](INT8)\b/i,
    /[-_](INT4)\b/i,
    /[@](q\d+_k(?:_[sml])?)\b/i, // LM Studio style: @q4_k_m
  ];
  for (const pattern of quantPatterns) {
    const match = name.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

/** Extract publisher/org from a namespaced model ID (e.g. "Qwen/Qwen3-8B" → "Qwen"). */
function parsePublisherFromName(name) {
  if (name.includes("/")) return name.split("/")[0];
  return null;
}

/** Format a total parameter count into a human-readable string. */
function formatParams(totalParams) {
  if (!totalParams) return null;
  if (totalParams >= 1_000_000_000) {
    const b = totalParams / 1_000_000_000;
    return b % 1 === 0 ? `${b}B` : `${b.toFixed(1)}B`;
  }
  if (totalParams >= 1_000_000) {
    return `${(totalParams / 1_000_000).toFixed(0)}M`;
  }
  return `${totalParams}`;
}

/**
 * Fetch vLLM models and convert them to the config model format.
 * Enriches with name-parsed attributes and HuggingFace Hub metadata.
 * Returns an array of model option objects for the 'vllm' provider.
 */
async function getVllmModelOptions() {
  try {
    const provider = getProvider("vllm");
    const { models } = await provider.listModels();
    if (!models || !Array.isArray(models)) return [];

    // Fetch HF metadata for all models in parallel (best-effort)
    const hfPromises = models
      .filter((m) => m.type === "llm")
      .map((m) => {
        // vLLM model IDs are often HF-style: "org/model-name"
        const modelId = m.key || "";
        return fetchHuggingFaceMetadata(modelId).catch(() => null);
      });
    const hfResults = await Promise.allSettled(hfPromises);

    return models
      .filter((m) => m.type === "llm")
      .map((m, idx) => {
        const nameLower = (m.key || "").toLowerCase();
        const hf =
          hfResults[idx]?.status === "fulfilled"
            ? hfResults[idx].value
            : null;

        // ── Layer 1: Name-based detection ──────────────────
        const supportsThinking = matchesAny(nameLower, THINKING_PATTERNS);
        const supportsFunctionCalling = matchesAny(nameLower, FC_PATTERNS);

        const tools = [];
        if (supportsThinking) tools.push("Thinking");
        if (supportsFunctionCalling) tools.push("Function Calling");

        // Detect multimodal capabilities by name patterns
        let supportsVision = matchesAny(nameLower, VISION_PATTERNS);
        let supportsVideo = matchesAny(nameLower, VIDEO_PATTERNS);
        let supportsAudio = matchesAny(nameLower, AUDIO_PATTERNS);

        // Name-parsed attributes
        const parsedParams = parseParamsFromName(m.key || "");
        const parsedQuant = parseQuantFromName(m.key || "");
        const parsedPublisher = parsePublisherFromName(m.key || "");

        // ── Layer 2: HuggingFace enrichment ────────────────
        if (hf) {
          // HF pipeline_tag is authoritative for multimodal detection
          if (
            hf.pipelineTag === "image-text-to-text" ||
            hf.tags.includes("multimodal") ||
            hf.tags.includes("vision")
          ) {
            supportsVision = true;
          }
          if (
            hf.pipelineTag === "video-text-to-text" ||
            hf.tags.includes("video")
          ) {
            supportsVideo = true;
          }
          if (
            hf.pipelineTag === "audio-text-to-text" ||
            hf.tags.includes("audio")
          ) {
            supportsAudio = true;
          }
        }

        // Build input types
        const inputTypes = [TYPES.TEXT];
        if (supportsVision) inputTypes.push(TYPES.IMAGE);
        if (supportsVideo) inputTypes.push(TYPES.VIDEO);
        if (supportsAudio) inputTypes.push(TYPES.AUDIO);

        // Build label with quantization suffix
        let label = m.display_name || m.key;
        if (parsedQuant) {
          label += ` (${parsedQuant})`;
        }

        const entry = {
          name: m.key,
          label,
          modelType: "conversation",
          inputTypes,
          outputTypes: [TYPES.TEXT],
          supportsSystemPrompt: true,
          streaming: true,
          defaultTemperature: 0.7,
          pricing: { inputPerMillion: 0, outputPerMillion: 0 },
        };

        // Capability flags
        if (tools.length > 0) entry.tools = tools;
        if (supportsThinking) entry.thinking = true;
        if (supportsVision) entry.vision = true;

        // Name-parsed metadata
        if (parsedParams) entry.params = parsedParams;
        if (parsedQuant) entry.quantization = parsedQuant;
        if (parsedPublisher) entry.publisher = parsedPublisher;

        // HF-enriched metadata (overrides name-based where available)
        if (hf) {
          if (hf.totalParams) {
            entry.params = formatParams(hf.totalParams);
          }
          if (hf.totalSize) {
            entry.size = formatBytes(hf.totalSize);
          }
          if (hf.architectures?.length > 0) {
            entry.architecture = hf.architectures[0];
          }
          if (hf.author) {
            entry.publisher = hf.author;
          }
        }

        return entry;
      });
  } catch (err) {
    logger.warn(`Could not fetch vLLM models for config: ${err.message}`);
    return [];
  }
}

/**
 * Fetch Ollama models and convert them to the config model format.
 * Returns an array of model option objects for the 'ollama' provider.
 */
async function getOllamaModelOptions() {
  try {
    const provider = getProvider("ollama");
    const { models } = await provider.listModels();
    if (!models || !Array.isArray(models)) return [];

    return models.map((m) => {
      // Ollama returns { name, model, size, details: { family, parameter_size, ... } }
      const name = m.model || m.name;
      const label = m.name || name;
      const details = m.details || {};
      const nameLower = name.toLowerCase();

      // Detect thinking-capable models by name/family
      const supportsThinking = matchesAny(nameLower, THINKING_PATTERNS);

      const tools = [];
      if (supportsThinking) tools.push("Thinking");

      const entry = {
        name,
        label,
        modelType: "conversation",
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.TEXT],
        supportsSystemPrompt: true,
        streaming: true,
        defaultTemperature: 0.7,
        pricing: { inputPerMillion: 0, outputPerMillion: 0 },
      };
      if (tools.length > 0) {
        entry.tools = tools;
      }
      if (supportsThinking) {
        entry.thinking = true;
      }
      if (details.parameter_size) {
        entry.params = details.parameter_size;
      }
      if (details.family) {
        entry.architecture = details.family;
      }
      if (m.size) {
        entry.size = formatBytes(m.size);
      }
      return entry;
    });
  } catch (err) {
    logger.warn(`Could not fetch Ollama models for config: ${err.message}`);
    return [];
  }
}
/**
 * GET /config
 * Returns the full catalog of providers, models, voices, and capabilities.
 */
router.get("/", async (_req, res) => {
  // Get static model options
  let textToTextModels = getModelOptions(TYPES.TEXT, TYPES.TEXT);
  let textToImageModels = getModelOptions(TYPES.TEXT, TYPES.IMAGE);

  // Merge dynamic models from local/self-hosted providers
  const dynamicProviders = [
    { key: PROVIDERS.LM_STUDIO, fetch: getLmStudioModelOptions },
    { key: PROVIDERS.VLLM, fetch: getVllmModelOptions },
    { key: PROVIDERS.OLLAMA, fetch: getOllamaModelOptions },
  ];
  for (const { key, fetch } of dynamicProviders) {
    if (AVAILABLE_PROVIDERS.has(key)) {
      try {
        mergeDynamicModels(textToTextModels, key, await fetch());
      } catch {
        // Ignore — use static models only
      }
    }
  }

  // Enrich ALL model lists with arena scores from the scraped leaderboard data
  enrichModelsWithArenaScores(textToTextModels);
  enrichModelsWithArenaScores(textToImageModels);

  // Filter to only available providers
  textToTextModels = filterByAvailableProviders(textToTextModels);
  textToImageModels = filterByAvailableProviders(textToImageModels);

  const availableProviderList = PROVIDER_LIST.filter((p) =>
    AVAILABLE_PROVIDERS.has(p),
  );
  const availableProviderMap = {};
  for (const [key, val] of Object.entries(PROVIDERS)) {
    if (AVAILABLE_PROVIDERS.has(val)) availableProviderMap[key] = val;
  }

  // Build the dynamic Function Calling system prompt
  const schemas = ToolOrchestratorService.getToolSchemas() || [];
  const toolNames = schemas.map(s => s.name || s.function?.name).filter(Boolean).map(name => {
    return name.replace(/^get_/, "").replace(/_/g, " ");
  });
  const toolList = toolNames.length > 0 ? toolNames.join(", ") : "general web search and computation";
  
  const fcSystemPrompt = `You are a helpful AI assistant with access to real-time data APIs. You have tools for ${toolList}.

Guidelines:
- When asked about weather, events, prices, trends, or similar data, ALWAYS use the appropriate tool to fetch real-time data. Never guess or make up data.
- You may call multiple tools in a single response if the question requires data from multiple sources.
- Present data clearly with relevant formatting — use tables, bullet points, and emojis where appropriate.
- When data includes numbers, format them appropriately (currencies, percentages, temperatures).
- If a tool returns an error, inform the user and suggest alternatives.
- Be conversational and helpful, not just a data dump.
- For questions that don't require API data, respond naturally without tool calls.
- The current local date/time is: {{CURRENT_DATE_TIME}}`;

  res.json({
    fcSystemPrompt,
    providers: availableProviderMap,
    providerList: availableProviderList,
    availableProviders: availableProviderList,
    textToText: {
      models: textToTextModels,
      defaults: filterDefaults(getDefaultModels(TYPES.TEXT, TYPES.TEXT)),
    },
    textToSpeech: {
      models: filterByAvailableProviders(
        getModelOptions(TYPES.TEXT, TYPES.AUDIO),
      ),
      defaults: filterDefaults(getDefaultModels(TYPES.TEXT, TYPES.AUDIO)),
      voices: VOICES,
      defaultVoices: DEFAULT_VOICES,
    },
    textToImage: {
      models: textToImageModels,
      defaults: filterDefaults(getDefaultModels(TYPES.TEXT, TYPES.IMAGE)),
    },
    imageToText: {
      models: filterByAvailableProviders(
        getModelOptions(TYPES.IMAGE, TYPES.TEXT),
      ),
      defaults: filterDefaults(getDefaultModels(TYPES.IMAGE, TYPES.TEXT)),
    },
    embedding: {
      models: filterByAvailableProviders(
        getModelOptions(TYPES.TEXT, TYPES.EMBEDDING),
      ),
      defaults: filterDefaults(getDefaultModels(TYPES.TEXT, TYPES.EMBEDDING)),
    },
    audioToText: {
      models: filterByAvailableProviders(
        getModelOptions(TYPES.AUDIO, TYPES.TEXT),
      ),
      defaults: filterDefaults(getDefaultModels(TYPES.AUDIO, TYPES.TEXT)),
    },
  });
});

/**
 * GET /config/tools
 * Returns the tool schemas fetched on startup.
 */
router.get("/tools", (_req, res) => {
  const schemas = ToolOrchestratorService.getToolSchemas();
  res.json(schemas || []);
});

export default router;

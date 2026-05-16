/** All recognized local provider types. */
declare const LOCAL_PROVIDER_TYPES: Set<string>;
/**
 * Providers that use native MCP tool execution (the provider's own
 * internal loop handles multi-step tool calling via native events).
 * These providers only need tools on the first pass — subsequent
 * passes should omit tools to force an eventual text response.
 */
declare const NATIVE_MCP_TYPES: Set<string>;
/**
 * Providers that emit thinking tokens (<think> tags) by default.
 * When the client doesn't explicitly set thinkingEnabled, these
 * providers default to thinkingEnabled=true.
 */
declare const DEFAULT_THINKING_TYPES: Set<string>;
/**
 * Providers that support model management (load/unload/ensure).
 * Only applicable to servers that can hot-swap models.
 */
declare const MODEL_MANAGEMENT_TYPES: Set<string>;
/**
 * Models that support extended thinking / chain-of-thought reasoning.
 * Matched against the lowercased model key.
 */
declare const THINKING_PATTERNS: string[];
/**
 * Models trained for function calling / tool use.
 * Matched against the lowercased model key.
 */
declare const FC_PATTERNS: string[];
/**
 * Models that support image/vision input.
 * Matched against the lowercased model key.
 */
declare const VISION_PATTERNS: string[];
/**
 * Models that support video input.
 * Matched against the lowercased model key.
 */
declare const VIDEO_PATTERNS: string[];
/**
 * Models that support audio input.
 * Matched against the lowercased model key.
 */
declare const AUDIO_PATTERNS: string[];
/** Check if a lowercased model name matches any pattern in a list. */
declare function matchesAny(nameLower: any, patterns: any): any;
/**
 * Detect capabilities for a model based on its name and provider metadata.
 * @param {string} modelKey - Model identifier (e.g. "qwen3-8b@q4_k_m")
 * @param {object} [providerMeta] - Provider-specific metadata (e.g. LM Studio capabilities)
 * @returns {object} Detected capabilities
 */
declare function detectCapabilities(modelKey: any, providerMeta?: {}): {
    thinking: any;
    functionCalling: any;
    vision: any;
    video: any;
    audio: any;
    tools: string[];
    inputTypes: string[];
    outputTypes: string[];
};
/** Format a byte count into a human-readable size string. */
declare const formatBytes: any;
/** Format a total parameter count into a human-readable string. */
declare function formatParams(totalParams: any): string | null;
/** Extract parameter count from model name (e.g. "qwen3-8b" → "8B"). */
declare function parseParamsFromName(name: any): any;
/** Extract quantization from model name (e.g. "model-AWQ" → "AWQ"). */
declare function parseQuantFromName(name: any): any;
/** Extract publisher/org from a namespaced model ID (e.g. "Qwen/Qwen3-8B" → "Qwen"). */
declare function parsePublisherFromName(name: any): any;
/**
 * Fetch model metadata from HuggingFace Hub API.
 * Returns null on any failure (gated models, network errors, etc.).
 * Results are cached in-memory with a 30-minute TTL.
 */
declare function fetchHuggingFaceMetadata(modelId: any): Promise<any>;
/**
 * Enrich a model entry with HuggingFace metadata if the model ID
 * looks like a HF model path (has a slash: "org/model-name").
 */
declare function enrichWithHuggingFace(entry: any, modelKey: any): Promise<any>;
/**
 * Normalize an LM Studio model into a canonical model entry.
 * LM Studio's /api/v1/models returns rich metadata including
 * type, capabilities, quantization, architecture, and load state.
 */
declare function normalizeLmStudioModel(raw: any): {
    name: any;
    label: any;
    modelType: string;
    inputTypes: string[];
    outputTypes: string[];
    supportsSystemPrompt: boolean;
    streaming: boolean;
    defaultTemperature: number | undefined;
    pricing: {
        inputPerMillion: number;
        outputPerMillion: number;
    };
};
/**
 * Normalize an Ollama model into a canonical model entry.
 * Ollama's /api/tags returns { name, model, size, details: { family, parameter_size, ... } }.
 */
declare function normalizeOllamaModel(raw: any): {
    name: any;
    label: any;
    modelType: string;
    inputTypes: string[];
    outputTypes: string[];
    supportsSystemPrompt: boolean;
    streaming: boolean;
    defaultTemperature: number;
    pricing: {
        inputPerMillion: number;
        outputPerMillion: number;
    };
};
/**
 * Normalize a vLLM or llama.cpp model into a canonical model entry.
 * Both use the OpenAI-compatible /v1/models which returns { id, object, owned_by }.
 * Enriches with name-parsed attributes; HF enrichment is done separately.
 */
declare function normalizeOpenAICompatModel(raw: any): {
    name: any;
    label: any;
    modelType: string;
    inputTypes: string[];
    outputTypes: string[];
    supportsSystemPrompt: boolean;
    streaming: boolean;
    defaultTemperature: number;
    pricing: {
        inputPerMillion: number;
        outputPerMillion: number;
    };
};
/**
 * vLLM-specific normalizer.
 * vLLM containers are launched with --enable-auto-tool-choice and a
 * --tool-call-parser, so every served model supports tool calling at
 * the server level regardless of name. Force "Tool Calling" onto all
 * vLLM models, then delegate the rest to the shared normalizer.
 */
declare function normalizeVllmModel(raw: any): {
    name: any;
    label: any;
    modelType: string;
    inputTypes: string[];
    outputTypes: string[];
    supportsSystemPrompt: boolean;
    streaming: boolean;
    defaultTemperature: number;
    pricing: {
        inputPerMillion: number;
        outputPerMillion: number;
    };
};
/** Select the normalizer function for a provider type. */
declare const NORMALIZER_BY_TYPE: {
    "lm-studio": typeof normalizeLmStudioModel;
    ollama: typeof normalizeOllamaModel;
    vllm: typeof normalizeVllmModel;
    "llama-cpp": typeof normalizeOpenAICompatModel;
};
/** Provider types that should get HuggingFace metadata enrichment. */
declare const HF_ENRICHED_TYPES: Set<string>;
declare class LocalProviderGateway {
    constructor();
    /**
     * Check whether a provider/instance ID represents a local provider.
     * Handles both base types ("lm-studio") and multi-instance IDs ("lm-studio-2").
     * @param {string} providerOrInstanceId
     * @returns {boolean}
     */
    isLocal(providerOrInstanceId: any): boolean;
    /**
     * Check whether a provider uses native MCP tool execution.
     * These providers handle multi-step tool calling internally — the
     * agentic loop should only feed tools on the first pass.
     * @param {string} providerOrInstanceId
     * @returns {boolean}
     */
    isNativeMCP(providerOrInstanceId: any): boolean;
    /**
     * Check whether a provider should default thinkingEnabled=true
     * when the client doesn't explicitly set it.
     * @param {string} providerOrInstanceId
     * @returns {boolean}
     */
    defaultsThinkingEnabled(providerOrInstanceId: any): boolean;
    /**
     * Check whether a provider supports model management (load/unload).
     * @param {string} providerOrInstanceId
     * @returns {boolean}
     */
    supportsModelManagement(providerOrInstanceId: any): boolean;
    /**
     * Resolve the base provider type from any instance ID.
     * e.g. "lm-studio-2" → "lm-studio", "ollama" → "ollama"
     * Returns null for non-local providers.
     * @param {string} providerOrInstanceId
     * @returns {string|null}
     */
    getProviderType(providerOrInstanceId: any): any;
    /**
     * Get all registered local provider instances.
     * @returns {Array<{ id: string, type: string, instanceNumber: number, concurrency: number }>}
     */
    getInstances(): {
        id: any;
        type: any;
        instanceNumber: any;
        concurrency: any;
    }[];
    /**
     * Get instances of a specific provider type.
     * @param {string} type - Provider type (e.g. "lm-studio", "ollama")
     * @returns {Array}
     */
    getInstancesByType(type: any): any[];
    /**
     * Get all unique provider types that have at least one registered instance.
     * @returns {string[]}
     */
    getRegisteredTypes(): any[];
    /**
     * Get total concurrency capacity across all local instances.
     * @returns {{ total: number, byType: { [type: string]: number }, byInstance: { [id: string]: number } }}
     */
    getConcurrencyCapacity(): {
        total: number;
        byType: {};
        byInstance: {};
    };
    /**
     * Discover all models across all local provider instances.
     * Results are normalized into a canonical format and enriched
     * with capability detection and (optionally) HuggingFace metadata.
     *
     * @param {object} [options]
     * @param {number} [options.timeoutMs=3000] - Timeout per provider
     * @param {boolean} [options.enrich=true] - Whether to enrich with HF metadata
     * @returns {Promise<{ [instanceId: string]: object[] }>} Normalized models grouped by instance
     */
    discoverModels({ timeoutMs, enrich }?: {
        timeoutMs?: number | undefined;
        enrich?: boolean | undefined;
    }): Promise<{}>;
    /**
     * Discover models for a single instance.
     * @param {string} instanceId - Provider instance ID (e.g. "lm-studio", "vllm-2")
     * @param {object} [options]
     * @returns {Promise<object[]>} Normalized model entries
     */
    discoverModelsForInstance(instanceId: any, { timeoutMs, enrich }?: {
        timeoutMs?: number | undefined;
        enrich?: boolean | undefined;
    }): Promise<any[]>;
    /**
     * Internal: Fetch, normalize, and optionally enrich models for an instance.
     * @private
     */
    _fetchModelsForInstance(inst: any, timeoutMs: any, enrich: any): Promise<any[]>;
    /**
     * Search for models across all local providers matching a capability filter.
     *
     * @param {object} [filter]
     * @param {boolean} [filter.thinking] - Only models that support thinking
     * @param {boolean} [filter.functionCalling] - Only models that support FC
     * @param {boolean} [filter.vision] - Only models with vision input
     * @param {boolean} [filter.video] - Only models with video input
     * @param {boolean} [filter.audio] - Only models with audio input
     * @param {string} [filter.modelType] - Filter by modelType ("conversation" or "embed")
     * @param {boolean} [filter.loaded] - Only currently loaded models
     * @param {string} [filter.query] - Free-text substring search on name/label
     * @returns {Promise<Array<{ instanceId: string, model: object }>>}
     */
    searchModels(filter?: {}): Promise<{
        instanceId: string;
        model: any;
    }[]>;
    /**
     * Check if a model entry matches the given filter criteria.
     * @private
     */
    _matchesFilter(model: any, filter: any): boolean;
    /**
     * Get aggregate statistics across all local providers.
     * @returns {Promise<object>}
     */
    getStats(): Promise<{
        instances: number;
        totalModels: number;
        loadedModels: number;
        conversationModels: number;
        embeddingModels: number;
        modelsByInstance: {};
        modelsByType: {};
        capabilityDistribution: {
            thinking: number;
            functionCalling: number;
            vision: number;
            video: number;
            audio: number;
        };
        concurrency: {
            total: number;
            byType: {};
            byInstance: {};
        };
    }>;
    /**
     * Resolve which provider instance serves a given model.
     * Queries each instance's model list and returns the first match.
     *
     * @param {string} modelName - The model key to find
     * @param {object} [options]
     * @param {number} [options.timeoutMs=3000] - Timeout per provider health check
     * @returns {Promise<{ instanceId: string, type: string, provider: object } | null>}
     */
    resolveProvider(modelName: any, { timeoutMs }?: {
        timeoutMs?: number | undefined;
    }): Promise<{
        instanceId: any;
        type: any;
        provider: any;
    } | null>;
    /**
     * Check health of all local provider instances.
     * Returns a map of instance ID → health status.
     *
     * For providers that expose checkHealth() (llama.cpp), uses that.
     * For others, performs a lightweight listModels() probe.
     *
     * @param {number} [timeoutMs=3000] - Timeout per instance
     * @returns {Promise<{ [instanceId: string]: { ok: boolean, status: string, type: string, models?: number } }>}
     */
    checkHealth(timeoutMs?: number): Promise<{}>;
    /**
     * Estimate VRAM usage for a GGUF model served by a local provider.
     * Primarily useful for LM Studio models that report GGUF metadata.
     *
     * @param {object} modelData - Raw model data from the provider's listModels
     * @param {object} [options]
     * @param {number} [options.contextLength=4096] - Target context length
     * @param {number} [options.gpuLayers] - GPU layers (defaults to all layers)
     * @param {boolean} [options.flashAttention=true] - Whether flash attention is enabled
     * @param {boolean} [options.offloadKvCache=true] - Whether KV cache is on GPU
     * @param {number} [options.gpuTotalGiB] - Total GPU VRAM for auto-offload clamping
     * @param {number} [options.gpuBaselineGiB=0] - Baseline VRAM usage
     * @returns {{ gpuGiB: number, totalGiB: number, cpuOffloaded: boolean, archParams: object, totalLayers: number } | null}
     */
    estimateVRAM(modelData: any, options?: {}): {
        archParams: {
            layers: any;
            kvHeads: any;
            headDim: any;
            attnRatio: any;
            isKnown: boolean;
        };
        totalLayers: any;
        gpuGiB: number;
        totalGiB: number;
        cpuOffloaded: boolean;
    } | null;
    /**
     * Estimate VRAM for a model by its key on a specific instance.
     * Fetches model metadata from the provider, then runs estimateVRAM.
     *
     * @param {string} instanceId - Provider instance ID
     * @param {string} modelKey - Model key to look up
     * @param {object} [options] - VRAM estimation options (see estimateVRAM)
     * @returns {Promise<object|null>}
     */
    estimateVRAMForModel(instanceId: any, modelKey: any, options?: {}): Promise<{
        archParams: {
            layers: any;
            kvHeads: any;
            headDim: any;
            attnRatio: any;
            isKnown: boolean;
        };
        totalLayers: any;
        gpuGiB: number;
        totalGiB: number;
        cpuOffloaded: boolean;
    } | null>;
    /**
     * Load a model on a specific instance.
     * Only supported by providers that expose loadModel (LM Studio).
     *
     * @param {string} instanceId - Target instance
     * @param {string} modelKey - Model to load
     * @param {object} [options] - Load options (context_length, etc.)
     * @param {AbortSignal} [signal] - Optional abort signal
     * @returns {Promise<object>}
     */
    loadModel(instanceId: any, modelKey: any, options: {} | undefined, signal: any): Promise<any>;
    /**
     * Ensure a specific model is loaded on a specific instance.
     * Handles unloading of other models if necessary (single-model enforcement).
     *
     * @param {string} instanceId - Target instance
     * @param {string} modelKey - Model to ensure is loaded
     * @param {object} [options] - Load options
     * @param {AbortSignal} [signal] - Optional abort signal
     * @param {function} [onStatus] - Optional status callback
     * @returns {Promise<{ alreadyLoaded: boolean, contextLength: number|null }>}
     */
    ensureModelLoaded(instanceId: any, modelKey: any, options: {} | undefined, signal: any, onStatus: any): Promise<any>;
    /**
     * Unload a model from a specific instance.
     *
     * @param {string} instanceId - Target instance
     * @param {string} modelInstanceId - The loaded model instance ID to unload
     * @returns {Promise<object>}
     */
    unloadModel(instanceId: any, modelInstanceId: any): Promise<any>;
    /**
     * Apply local provider defaults to the options object.
     * This handles the "thinking enabled by default" behavior
     * and any other provider-specific option normalization.
     *
     * Call this during request preparation (prepareGenerationContext).
     *
     * @param {string} providerName - Provider/instance ID
     * @param {object} options - Mutable options object
     * @param {object} [clientParams] - Raw client parameters for checking explicit vs undefined
     * @returns {object} The mutated options object (for chaining)
     */
    applyLocalDefaults(providerName: any, options: any, clientParams?: {}): any;
    /**
     * Generate text (non-streaming) via a local provider.
     * Auto-resolves the provider if only a model name is given.
     *
     * @param {Array} messages - Chat messages
     * @param {string} model - Model key
     * @param {object} [options] - Generation options (canonical format)
     * @param {string} [instanceId] - Explicit instance ID (skips auto-routing)
     * @returns {Promise<{ text: string, thinking: string|null, usage: object }>}
     */
    generateText(messages: any, model: any, options: {} | undefined, instanceId: any): Promise<any>;
    /**
     * Generate text (streaming) via a local provider.
     * Auto-resolves the provider if only a model name is given.
     *
     * @param {Array} messages - Chat messages
     * @param {string} model - Model key
     * @param {object} [options] - Generation options (canonical format)
     * @param {string} [instanceId] - Explicit instance ID (skips auto-routing)
     * @returns {AsyncGenerator}
     */
    generateTextStream(messages: any, model: any, options: {} | undefined, instanceId: any): AsyncGenerator<any, void, any>;
    /**
     * Generate an embedding via a local provider.
     *
     * @param {string} content - Text to embed
     * @param {string} model - Embedding model key
     * @param {object} [options] - Optional { dimensions }
     * @param {string} [instanceId] - Explicit instance ID
     * @returns {Promise<{ embedding: number[], dimensions: number }>}
     */
    generateEmbedding(content: any, model: any, options: {} | undefined, instanceId: any): Promise<any>;
    /**
     * Caption an image via a local provider.
     *
     * @param {string[]} images - Image data URLs
     * @param {string} [prompt] - Caption prompt
     * @param {string} [model] - Vision model key
     * @param {string} [systemPrompt] - System prompt
     * @param {string} [instanceId] - Explicit instance ID
     * @returns {Promise<{ text: string, usage: object }>}
     */
    captionImage(images: any, prompt: any, model: any, systemPrompt: any, instanceId: any): Promise<any>;
    /**
     * Get the provider for a model, either by explicit instance or auto-routing.
     * @private
     */
    _getProviderForModel(model: any, instanceId: any): Promise<any>;
}
declare const gateway: LocalProviderGateway;
export default gateway;
export { LOCAL_PROVIDER_TYPES, NATIVE_MCP_TYPES, DEFAULT_THINKING_TYPES, MODEL_MANAGEMENT_TYPES, THINKING_PATTERNS, FC_PATTERNS, VISION_PATTERNS, VIDEO_PATTERNS, AUDIO_PATTERNS, matchesAny, detectCapabilities, formatBytes, formatParams, parseParamsFromName, parseQuantFromName, parsePublisherFromName, fetchHuggingFaceMetadata, enrichWithHuggingFace, normalizeLmStudioModel, normalizeOllamaModel, normalizeOpenAICompatModel, normalizeVllmModel, NORMALIZER_BY_TYPE, HF_ENRICHED_TYPES, };
//# sourceMappingURL=LocalProviderGateway.d.ts.map
import express from "express";
import { getProvider } from "../providers/index.js";
import logger from "../utils/logger.js";
import { resolveArchParams, estimateMemory } from "../utils/gguf-arch.js";

const router = express.Router();

/**
 * GET /lm-studio/models
 * List all models available from LM Studio.
 */
router.get("/models", async (_req, res, next) => {
  try {
    const provider = getProvider("lm-studio");
    const data = await provider.listModels();
    res.json(data);
  } catch (error) {
    logger.error(`GET /lm-studio/models error: ${error.message}`);
    next(error);
  }
});

/**
 * POST /lm-studio/load
 * Load a model into LM Studio.
 * Body: { model: "model-key" }
 */
router.post("/load", async (req, res, next) => {
  try {
    const { model, context_length, flash_attention, offload_kv_cache_to_gpu } = req.body;
    if (!model) {
      return res
        .status(400)
        .json({ error: true, message: "Missing 'model' in request body" });
    }

    const provider = getProvider("lm-studio");

    // Enforce single model — unload anything currently loaded that isn't the requested model
    try {
      const { models } = await provider.listModels();
      for (const m of models || []) {
        for (const instance of m.loaded_instances || []) {
          if (instance.id !== model) {
            logger.info(
              `Auto-unloading ${instance.id} before loading ${model}`,
            );
            await provider.unloadModel(instance.id);
          }
        }
      }
    } catch (listErr) {
      logger.warn(`Could not list models before loading: ${listErr.message}`);
    }

    // Build load options from request body
    const loadOptions = {};
    if (context_length != null) loadOptions.context_length = context_length;
    if (flash_attention != null) loadOptions.flash_attention = flash_attention;
    if (offload_kv_cache_to_gpu != null) loadOptions.offload_kv_cache_to_gpu = offload_kv_cache_to_gpu;

    const data = await provider.loadModel(model, loadOptions);
    res.json(data);
  } catch (error) {
    logger.error(`POST /lm-studio/load error: ${error.message}`);
    next(error);
  }
});

/**
 * POST /lm-studio/unload
 * Unload a model from LM Studio memory.
 * Body: { instance_id: "model-instance-id" }
 */
router.post("/unload", async (req, res, next) => {
  try {
    const { instance_id } = req.body;
    if (!instance_id) {
      return res.status(400).json({
        error: true,
        message: "Missing 'instance_id' in request body",
      });
    }

    const provider = getProvider("lm-studio");
    const data = await provider.unloadModel(instance_id);
    res.json(data);
  } catch (error) {
    logger.error(`POST /lm-studio/unload error: ${error.message}`);
    next(error);
  }
});

/**
 * POST /lm-studio/estimate
 * Estimate VRAM usage for a model with given configuration.
 * Body: { model, contextLength, gpuLayers, flashAttention, offloadKvCache }
 */
router.post("/estimate", async (req, res, next) => {
  try {
    const { model, contextLength, gpuLayers, flashAttention, offloadKvCache } = req.body;
    if (!model) {
      return res.status(400).json({ error: true, message: "Missing 'model' in request body" });
    }

    // Fetch model metadata from LM Studio
    const provider = getProvider("lm-studio");
    const result = await provider.listModels();
    const allModels = result?.data || result?.models || [];
    const modelData = allModels.find((m) => m.id === model || m.path === model || m.key === model);

    if (!modelData) {
      return res.status(404).json({ error: true, message: `Model '${model}' not found` });
    }

    const sizeBytes = modelData.size_bytes || 0;
    const bpw = modelData.quantization?.bits_per_weight || 4;
    const archParams = resolveArchParams(
      modelData.architecture,
      modelData.params_string,
      sizeBytes,
      bpw,
    );
    const totalLayers = archParams.layers;

    const memory = estimateMemory({
      sizeBytes,
      archParams,
      gpuLayers: gpuLayers ?? totalLayers,
      contextLength: contextLength ?? 4096,
      offloadKvCache: offloadKvCache ?? true,
      flashAttention: flashAttention ?? true,
      vision: modelData.capabilities?.vision || false,
    });

    res.json({
      ...memory,
      archParams,
      totalLayers,
    });
  } catch (error) {
    logger.error(`POST /lm-studio/estimate error: ${error.message}`);
    next(error);
  }
});

export default router;

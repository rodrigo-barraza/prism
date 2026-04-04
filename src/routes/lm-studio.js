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
 * POST /lm-studio/load-stream
 * Load a model into LM Studio with SSE progress streaming.
 * Fires the blocking load in the background and emits progress events.
 *
 * SSE events:
 *   { type: "start", model }
 *   { type: "unloading", model: "previous-model-key" }
 *   { type: "progress", progress: 0.0–1.0 }
 *   { type: "complete" }
 *   { type: "error", message: "..." }
 */
router.post("/load-stream", async (req, res) => {
  const { model, context_length, flash_attention, offload_kv_cache_to_gpu } = req.body;
  if (!model) {
    return res
      .status(400)
      .json({ error: true, message: "Missing 'model' in request body" });
  }

  // Set up SSE — use setHeader pattern (not writeHead) to match /chat endpoint
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (data) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  let aborted = false;
  req.on("close", () => { aborted = true; });

  try {
    const provider = getProvider("lm-studio");
    send({ type: "start", model });

    // Build load options
    const loadOptions = {};
    if (context_length != null) loadOptions.context_length = context_length;
    if (flash_attention != null) loadOptions.flash_attention = flash_attention;
    if (offload_kv_cache_to_gpu != null) loadOptions.offload_kv_cache_to_gpu = offload_kv_cache_to_gpu;

    if (aborted) return res.end();

    send({ type: "progress", progress: 0 });

    // Fire load in background, poll for synthetic progress
    let loadDone = false;
    let loadError = null;
    const loadPromise = provider.loadModel(model, loadOptions)
      .then(() => { loadDone = true; })
      .catch((err) => { loadDone = true; loadError = err; });

    const startTime = Date.now();
    const EXPECTED_LOAD_MS = 15_000;
    let lastPct = 0;

    while (!loadDone && !aborted) {
      await new Promise((r) => setTimeout(r, 300));
      if (loadDone || aborted) break;

      const elapsed = Date.now() - startTime;
      const pct = Math.min(0.95, elapsed / (elapsed + EXPECTED_LOAD_MS));
      if (pct > lastPct + 0.005) {
        lastPct = pct;
        send({ type: "progress", progress: parseFloat(pct.toFixed(3)) });
      }
    }

    await loadPromise;

    if (aborted) return res.end();

    if (loadError) {
      logger.error(`[load-stream] loadModel failed: ${loadError.message}`);
      send({ type: "error", message: loadError.message });
    } else {
      send({ type: "progress", progress: 1 });
      send({ type: "complete" });
      logger.info(`[load-stream] Model ${model} loaded successfully`);
    }
  } catch (error) {
    logger.error(`POST /lm-studio/load-stream error: ${error.message}`);
    send({ type: "error", message: error.message });
  } finally {
    if (!res.writableEnded) res.end();
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

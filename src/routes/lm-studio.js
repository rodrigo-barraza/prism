import express from "express";
import { getProvider } from "../providers/index.js";
import logger from "../utils/logger.js";

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
    const { model } = req.body;
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

    const data = await provider.loadModel(model);
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

export default router;

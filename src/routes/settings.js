import express from "express";
import SettingsService from "../services/SettingsService.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * GET /settings
 * Returns the current server-side settings, merged with defaults.
 */
router.get("/", async (_req, res, next) => {
  try {
    const settings = await SettingsService.get();
    res.json(settings);
  } catch (err) {
    logger.error(`GET /settings error: ${err.message}`);
    next(err);
  }
});

/**
 * PUT /settings
 * Upsert settings. Accepts a partial object — deep-merged with existing.
 */
router.put("/", async (req, res, next) => {
  try {
    const data = req.body;
    if (!data || typeof data !== "object") {
      return res.status(400).json({ error: "Request body must be an object" });
    }

    const updated = await SettingsService.update(data);
    res.json(updated);
  } catch (err) {
    logger.error(`PUT /settings error: ${err.message}`);
    next(err);
  }
});

/**
 * GET /settings/defaults
 * Returns the compiled defaults for reference (useful for "Reset" buttons).
 */
router.get("/defaults", (_req, res) => {
  res.json(SettingsService.getDefaults());
});

export default router;

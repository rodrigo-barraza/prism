// @ts-ignore
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import SettingsService from "../services/SettingsService.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * GET /settings
 * Returns the current server-side settings, merged with defaults.
 */
router.get(
  "/",
  asyncHandler(async (_req: any, res: any, next: any) => {
    try {
      const settings = await SettingsService.get();
      res.json(settings);
    } catch (error: any) {
      logger.error(`GET /settings error: ${error.message}`);
      next(error);
    }
  }),
);

/**
 * PUT /settings
 * Upsert settings. Accepts a partial object — deep-merged with existing.
 */
router.put(
  "/",
  asyncHandler(async (req: any, res: any, next: any) => {
    try {
      const data = req.body;
      if (!data || typeof data !== "object") {
        return res
          .status(400)
          .json({ error: "Request body must be an object" });
      }

      const updated = await SettingsService.update(data);
      res.json(updated);
    } catch (error: any) {
      logger.error(`PUT /settings error: ${error.message}`);
      next(error);
    }
  }),
);

/**
 * GET /settings/defaults
 * Returns the compiled defaults for reference (useful for "Reset" buttons).
 */
router.get("/defaults", (_req: any, res: any) => {
  res.json(SettingsService.getDefaults());
});

/**
 * GET /settings/harnesses
 * Returns the list of available agentic harnesses.
 */
router.get(
  "/harnesses",
  asyncHandler(async (_req: any, res: any) => {
    const { default: AgenticLoopService } =
      await import("../services/AgenticLoopService.js");
    res.json(AgenticLoopService.listHarnesses());
  }),
);

export default router;

import express from "express";
import { basename } from "node:path";
import ToolOrchestratorService from "../services/ToolOrchestratorService.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * GET /workspaces
 * Returns the list of configured workspace roots from tools-api.
 * Each entry has: { id, name, path, isPinned }
 *   - id: the full absolute path (used as stable identifier)
 *   - name: last path segment (e.g. "sun")
 *   - path: full absolute path
 *   - isPinned: true if from secrets.js (non-removable)
 */
router.get("/", (_req, res) => {
  try {
    const roots = ToolOrchestratorService.getWorkspaceRoots();
    const staticRoots = ToolOrchestratorService.getStaticRoots();

    const workspaces = roots.map((rootPath) => ({
      id: rootPath,
      name: basename(rootPath),
      path: rootPath,
      isPinned: staticRoots.includes(rootPath),
    }));

    res.json(workspaces);
  } catch (err) {
    logger.error(`GET /workspaces error: ${err.message}`);
    res.status(500).json({ error: "Failed to retrieve workspace roots" });
  }
});

/**
 * PUT /workspaces
 * Update user-configured workspace roots. Proxies to tools-api.
 * Body: { roots: string[] }
 * Returns the updated workspace list with isPinned metadata.
 */
router.put("/", async (req, res) => {
  try {
    const result = await ToolOrchestratorService.updateWorkspaceRoots(req.body?.roots || []);
    res.json(result);
  } catch (err) {
    logger.error(`PUT /workspaces error: ${err.message}`);
    res.status(500).json({ error: "Failed to update workspace roots" });
  }
});

/**
 * POST /workspaces/validate
 * Validate a single workspace path without persisting.
 * Body: { path: string }
 */
router.post("/validate", async (req, res) => {
  try {
    const result = await ToolOrchestratorService.validateWorkspacePath(req.body?.path);
    res.json(result);
  } catch (err) {
    logger.error(`POST /workspaces/validate error: ${err.message}`);
    res.status(500).json({ error: "Failed to validate workspace path" });
  }
});

export default router;


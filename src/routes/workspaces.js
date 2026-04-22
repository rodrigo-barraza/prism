import express from "express";
import { basename } from "node:path";
import ToolOrchestratorService from "../services/ToolOrchestratorService.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * GET /workspaces
 * Returns the list of configured workspace roots from tools-api.
 * Each entry has: { id, name, path }
 *   - id: the full absolute path (used as stable identifier)
 *   - name: last path segment (e.g. "sun")
 *   - path: full absolute path
 */
router.get("/", (_req, res) => {
  try {
    const roots = ToolOrchestratorService.getWorkspaceRoots();

    const workspaces = roots.map((rootPath) => ({
      id: rootPath,
      name: basename(rootPath),
      path: rootPath,
    }));

    res.json(workspaces);
  } catch (err) {
    logger.error(`GET /workspaces error: ${err.message}`);
    res.status(500).json({ error: "Failed to retrieve workspace roots" });
  }
});

export default router;

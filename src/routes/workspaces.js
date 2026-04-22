import express from "express";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";

const router = express.Router();
const COLLECTION = "workspaces";

/**
 * GET /workspaces
 * List all workspaces for the current project + username.
 */
router.get("/", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) return res.status(503).json({ error: "Database not available" });

    const { project, username } = req;
    const workspaces = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .find({ project, username })
      .sort({ createdAt: 1 })
      .toArray();

    res.json(workspaces);
  } catch (err) {
    logger.error(`GET /workspaces error: ${err.message}`);
    next(err);
  }
});

/**
 * POST /workspaces
 * Create a new workspace.
 * Body: { name: string }
 */
router.post("/", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) return res.status(503).json({ error: "Database not available" });

    const { project, username } = req;
    const { name } = req.body || {};

    if (!name?.trim()) {
      return res.status(400).json({ error: "name is required" });
    }

    const workspace = {
      id: crypto.randomUUID(),
      name: name.trim(),
      project,
      username,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await client.db(MONGO_DB_NAME).collection(COLLECTION).insertOne(workspace);
    logger.info(`Workspace created: ${workspace.id} (${workspace.name}) for ${project}/${username}`);
    res.status(201).json(workspace);
  } catch (err) {
    logger.error(`POST /workspaces error: ${err.message}`);
    next(err);
  }
});

/**
 * PUT /workspaces/:id
 * Update a workspace's name.
 * Body: { name: string }
 */
router.put("/:id", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) return res.status(503).json({ error: "Database not available" });

    const { project, username } = req;
    const { id } = req.params;
    const { name } = req.body || {};

    if (!name?.trim()) {
      return res.status(400).json({ error: "name is required" });
    }

    const result = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .findOneAndUpdate(
        { id, project, username },
        { $set: { name: name.trim(), updatedAt: new Date() } },
        { returnDocument: "after" },
      );

    if (!result) return res.status(404).json({ error: "Workspace not found" });
    res.json(result);
  } catch (err) {
    logger.error(`PUT /workspaces/${req.params.id} error: ${err.message}`);
    next(err);
  }
});

/**
 * DELETE /workspaces/:id
 * Delete a workspace.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) return res.status(503).json({ error: "Database not available" });

    const { project, username } = req;
    const { id } = req.params;

    const result = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .findOneAndDelete({ id, project, username });

    if (!result) return res.status(404).json({ error: "Workspace not found" });
    res.json({ deleted: true, id });
  } catch (err) {
    logger.error(`DELETE /workspaces/${req.params.id} error: ${err.message}`);
    next(err);
  }
});

export default router;

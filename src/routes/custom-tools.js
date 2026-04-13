import express from "express";
import { ObjectId } from "mongodb";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";

const router = express.Router();
import { COLLECTIONS } from "../constants.js";

const COLLECTION = COLLECTIONS.CUSTOM_TOOLS;

/**
 * GET /custom-tools
 * List all custom tools for the given project + username.
 */
router.get("/", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;

    const tools = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .find({ project, username })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(tools.map((t) => ({ ...t, id: t._id.toString() })));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /custom-tools
 * Create a new custom tool.
 */
router.post("/", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;

    const doc = {
      project,
      username,
      name: req.body.name,
      description: req.body.description || "",
      endpoint: req.body.endpoint,
      method: req.body.method || "GET",
      parameters: req.body.parameters || [],
      enabled: req.body.enabled !== false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .insertOne(doc);

    logger.info(`Custom tool created: ${doc.name} (${result.insertedId})`);
    res.status(201).json({ ...doc, id: result.insertedId.toString() });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /custom-tools/:id
 * Update an existing custom tool.
 */
router.put("/:id", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const updates = {
      ...(req.body.name !== undefined && { name: req.body.name }),
      ...(req.body.description !== undefined && {
        description: req.body.description,
      }),
      ...(req.body.endpoint !== undefined && { endpoint: req.body.endpoint }),
      ...(req.body.method !== undefined && { method: req.body.method }),
      ...(req.body.parameters !== undefined && {
        parameters: req.body.parameters,
      }),
      ...(req.body.enabled !== undefined && { enabled: req.body.enabled }),
      updatedAt: new Date(),
    };

    const result = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .findOneAndUpdate(
        { _id: new ObjectId(req.params.id) },
        { $set: updates },
        { returnDocument: "after" },
      );

    if (!result) {
      return res.status(404).json({ error: "Tool not found" });
    }

    logger.info(`Custom tool updated: ${result.name} (${req.params.id})`);
    res.json({ ...result, id: result._id.toString() });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /custom-tools/:id
 * Delete a custom tool.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const result = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .findOneAndDelete({ _id: new ObjectId(req.params.id) });

    if (!result) {
      return res.status(404).json({ error: "Tool not found" });
    }

    logger.info(`Custom tool deleted: ${result.name} (${req.params.id})`);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;

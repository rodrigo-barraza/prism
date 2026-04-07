import express from "express";
import { ObjectId } from "mongodb";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";

const router = express.Router();
const COLLECTION = "agent_skills";

/**
 * GET /skills
 * List all skills for the given project + username.
 */
router.get("/", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.query.project || req.project || "default";
    const username = req.username;

    const skills = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .find({ project, username })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(skills.map((s) => ({ ...s, id: s._id.toString() })));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /skills
 * Create a new skill.
 */
router.post("/", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.body.project || req.project || "default";
    const username = req.username;

    const doc = {
      project,
      username,
      name: req.body.name,
      description: req.body.description || "",
      content: req.body.content || "",
      enabled: req.body.enabled !== false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .insertOne(doc);

    logger.info(`Skill created: ${doc.name} (${result.insertedId})`);
    res.status(201).json({ ...doc, id: result.insertedId.toString() });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /skills/:id
 * Update an existing skill.
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
      ...(req.body.content !== undefined && { content: req.body.content }),
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
      return res.status(404).json({ error: "Skill not found" });
    }

    logger.info(`Skill updated: ${result.name} (${req.params.id})`);
    res.json({ ...result, id: result._id.toString() });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /skills/:id
 * Delete a skill.
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
      return res.status(404).json({ error: "Skill not found" });
    }

    logger.info(`Skill deleted: ${result.name} (${req.params.id})`);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;

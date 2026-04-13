import express from "express";
import { ObjectId } from "mongodb";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import EmbeddingService from "../services/EmbeddingService.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";

const router = express.Router();
import { COLLECTIONS } from "../constants.js";

const COLLECTION = COLLECTIONS.AGENT_SKILLS;

/**
 * Generate an embedding vector for skill content.
 * Combines name + description + content for richer semantic representation.
 */
async function generateSkillEmbedding(skill) {
  const text = [skill.name, skill.description, skill.content]
    .filter(Boolean)
    .join("\n");
  return EmbeddingService.embed(text, { source: "skill-creation", endpoint: "/skills" });
}

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

    const project = req.project;
    const username = req.username;

    const skills = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .find({ project, username })
      .sort({ createdAt: -1 })
      // Don't return embedding vectors to the client — they're large
      .project({ embedding: 0 })
      .toArray();

    res.json(skills.map((s) => ({ ...s, id: s._id.toString() })));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /skills
 * Create a new skill. Generates an embedding vector at creation time.
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
      content: req.body.content || "",
      enabled: req.body.enabled !== false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Generate embedding for semantic similarity search
    try {
      doc.embedding = await generateSkillEmbedding(doc);
    } catch (err) {
      logger.warn(`[Skills] Embedding generation failed: ${err.message}`);
      doc.embedding = null;
    }

    const result = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .insertOne(doc);

    logger.info(`Skill created: ${doc.name} (${result.insertedId})`);
    const { embedding: _, ...response } = doc;
    res.status(201).json({ ...response, id: result.insertedId.toString() });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /skills/:id
 * Update an existing skill. Re-generates embedding if content changes.
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

    // Re-generate embedding if any semantic content changed
    const contentChanged =
      req.body.name !== undefined ||
      req.body.description !== undefined ||
      req.body.content !== undefined;

    if (contentChanged) {
      try {
        // Need current doc to merge fields for embedding
        const db = client.db(MONGO_DB_NAME);
        const current = await db
          .collection(COLLECTION)
          .findOne({ _id: new ObjectId(req.params.id) });

        if (current) {
          const merged = {
            name: updates.name ?? current.name,
            description: updates.description ?? current.description,
            content: updates.content ?? current.content,
          };
          updates.embedding = await generateSkillEmbedding(merged);
        }
      } catch (err) {
        logger.warn(`[Skills] Embedding re-generation failed: ${err.message}`);
      }
    }

    const result = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .findOneAndUpdate(
        { _id: new ObjectId(req.params.id) },
        { $set: updates },
        { returnDocument: "after", projection: { embedding: 0 } },
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

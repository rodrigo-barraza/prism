import { Router } from "express";
import { ObjectId } from "mongodb";
import logger from "../utils/logger.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";

const router = Router();
const WORKFLOWS_COL = "workflows";

function getDb() {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) return null;
    return client.db(MONGO_DB_NAME);
}

/**
 * GET /workflows
 * List all saved workflows (metadata only).
 */
router.get("/", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const source = req.query.source || "retina";
        const query = source === "all" ? {} : { source };

        const workflows = await db
            .collection(WORKFLOWS_COL)
            .find(query)
            .sort({ updatedAt: -1 })
            .project({ nodes: 0, connections: 0, nodeResults: 0, nodeStatuses: 0 })
            .toArray();

        res.json(workflows);
    } catch (error) {
        logger.error(`GET /workflows error: ${error.message}`);
        next(error);
    }
});

/**
 * GET /workflows/:id
 * Get a single workflow by ID (full document).
 */
router.get("/:id", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        let filter;
        try {
            filter = { _id: new ObjectId(req.params.id) };
        } catch {
            filter = { workflowId: req.params.id };
        }

        const workflow = await db.collection(WORKFLOWS_COL).findOne(filter);
        if (!workflow) return res.status(404).json({ error: "Workflow not found" });

        res.json(workflow);
    } catch (error) {
        logger.error(`GET /workflows/:id error: ${error.message}`);
        next(error);
    }
});

/**
 * POST /workflows
 * Save a new workflow document.
 */
router.post("/", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const now = new Date().toISOString();
        const workflow = {
            ...req.body,
            source: req.body.source || "retina",
            createdAt: now,
            updatedAt: now,
        };

        const result = await db.collection(WORKFLOWS_COL).insertOne(workflow);
        res.json({ success: true, id: result.insertedId.toString() });
    } catch (error) {
        logger.error(`POST /workflows error: ${error.message}`);
        next(error);
    }
});

/**
 * PUT /workflows/:id
 * Update an existing workflow.
 */
router.put("/:id", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        let filter;
        try {
            filter = { _id: new ObjectId(req.params.id) };
        } catch {
            filter = { workflowId: req.params.id };
        }

        const update = {
            $set: {
                ...req.body,
                updatedAt: new Date().toISOString(),
            },
        };
        delete update.$set._id; // prevent overwriting _id

        const result = await db.collection(WORKFLOWS_COL).updateOne(filter, update);
        if (result.matchedCount === 0) return res.status(404).json({ error: "Workflow not found" });

        res.json({ success: true });
    } catch (error) {
        logger.error(`PUT /workflows/:id error: ${error.message}`);
        next(error);
    }
});

/**
 * DELETE /workflows/:id
 * Delete a workflow by ID.
 */
router.delete("/:id", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        let filter;
        try {
            filter = { _id: new ObjectId(req.params.id) };
        } catch {
            filter = { workflowId: req.params.id };
        }

        await db.collection(WORKFLOWS_COL).deleteOne(filter);
        res.json({ success: true });
    } catch (error) {
        logger.error(`DELETE /workflows/:id error: ${error.message}`);
        next(error);
    }
});

export default router;

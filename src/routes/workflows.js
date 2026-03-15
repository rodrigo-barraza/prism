import { Router } from "express";
import { ObjectId } from "mongodb";
import logger from "../utils/logger.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import FileService from "../services/FileService.js";
import { MONGO_DB_NAME } from "../../secrets.js";

const router = Router();
const WORKFLOWS_COL = "workflows";

/** Media fields on messages that may contain base64 data URLs. */
const MEDIA_FIELDS = ["images", "audio", "video", "pdf"];

function getDb() {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) return null;
    return client.db(MONGO_DB_NAME);
}

/**
 * Upload a single value if it's a base64 data URL, returning the minio:// ref.
 * Non-data-URL strings (minio://, http://, etc.) pass through unchanged.
 */
async function uploadIfDataUrl(value, category = "uploads", project = null, username = null) {
    if (typeof value === "string" && value.startsWith("data:")) {
        try {
            const { ref } = await FileService.uploadFile(value, category, project, username);
            return ref;
        } catch (err) {
            logger.error(`Workflow file upload failed: ${err.message}`);
            return value;
        }
    }
    return value;
}

/**
 * Walk all workflow nodes and upload any base64 data URLs to MinIO,
 * replacing them with minio:// refs.  Mirrors the extractFiles pattern
 * used by ConversationService for chat messages.
 */
async function extractWorkflowFiles(nodes, project = null, username = null) {
    if (!Array.isArray(nodes) || !FileService.isExternalStorage()) return nodes;

    const processed = [];
    for (const node of nodes) {
        const updated = { ...node };

        // 1. Node-level content (asset input nodes store content as a data URL)
        if (typeof updated.content === "string" && updated.content.startsWith("data:")) {
            updated.content = await uploadIfDataUrl(updated.content, "uploads", project, username);
        }

        // 2. Messages array (conversation / model nodes)
        if (Array.isArray(updated.messages)) {
            const newMessages = [];
            for (const msg of updated.messages) {
                const m = { ...msg };
                for (const field of MEDIA_FIELDS) {
                    const val = m[field];
                    if (Array.isArray(val)) {
                        const arr = [];
                        for (const item of val) {
                            arr.push(await uploadIfDataUrl(item, "uploads", project, username));
                        }
                        m[field] = arr;
                    } else if (typeof val === "string" && val.startsWith("data:")) {
                        m[field] = await uploadIfDataUrl(val, "uploads", project, username);
                    }
                }
                newMessages.push(m);
            }
            updated.messages = newMessages;
        }

        // 3. nodeResults may hold data URLs from prior executions
        // We intentionally skip them — results are regenerated on re-run.

        processed.push(updated);
    }
    return processed;
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

        const project = req.headers["x-project"] || null;
        const username = req.headers["x-username"] || null;
        const processedNodes = await extractWorkflowFiles(req.body.nodes, project, username);

        const now = new Date().toISOString();
        const workflow = {
            ...req.body,
            nodes: processedNodes || req.body.nodes,
            source: req.body.source || "retina",
            nodeCount: Array.isArray(req.body.nodes) ? req.body.nodes.length : 0,
            connectionCount: Array.isArray(req.body.connections) ? req.body.connections.length : 0,
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

        const project = req.headers["x-project"] || null;
        const username = req.headers["x-username"] || null;
        const body = { ...req.body };
        if (Array.isArray(body.nodes)) {
            body.nodes = await extractWorkflowFiles(body.nodes, project, username);
            body.nodeCount = body.nodes.length;
        }
        if (Array.isArray(body.connections)) body.connectionCount = body.connections.length;
        const update = {
            $set: {
                ...body,
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

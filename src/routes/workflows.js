import { Router } from "express";
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
 * POST /workflows
 * Save a workflow document (called by any Prism client after each reply).
 */
router.post("/", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const workflow = {
            ...req.body,
            createdAt: new Date().toISOString(),
        };

        await db.collection(WORKFLOWS_COL).insertOne(workflow);
        res.json({ success: true, messageId: workflow.messageId });
    } catch (error) {
        logger.error(`POST /workflows error: ${error.message}`);
        next(error);
    }
});

export default router;

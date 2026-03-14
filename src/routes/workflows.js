import { Router } from "express";
import logger from "../utils/logger.js";
import { getDb } from "../wrappers/MongoWrapper.js";

const router = Router();
const WORKFLOWS_COL = "workflows";

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

import express from "express";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";

const router = express.Router();
const CONVERSATIONS_COL = "conversations";

function getDb() {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) return null;
    return client.db(MONGO_DB_NAME);
}

// ============================================================
// GET /media — extract media from the caller's project conversations
// ============================================================
router.get("/", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const { page = 1, limit = 100, type, origin, search } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const lim = parseInt(limit, 10);

        // Always scope to the caller's project
        const preMatch = { project: req.project };
        if (search) preMatch.title = { $regex: search, $options: "i" };

        const pipeline = [
            { $match: preMatch },
            { $unwind: "$messages" },
            {
                $project: {
                    convId: "$id",
                    convTitle: "$title",
                    project: 1,
                    username: 1,
                    role: "$messages.role",
                    images: { $ifNull: ["$messages.images", []] },
                    audio: "$messages.audio",
                    timestamp: { $ifNull: ["$messages.timestamp", "$updatedAt"] },
                    model: "$messages.model",
                },
            },
            {
                $facet: {
                    imageItems: [
                        { $unwind: "$images" },
                        {
                            $project: {
                                url: "$images",
                                mediaType: "image",
                                convId: 1,
                                convTitle: 1,
                                project: 1,
                                username: 1,
                                role: 1,
                                timestamp: 1,
                                model: 1,
                            },
                        },
                    ],
                    audioItems: [
                        { $match: { audio: { $ne: null, $exists: true } } },
                        {
                            $project: {
                                url: "$audio",
                                mediaType: "audio",
                                convId: 1,
                                convTitle: 1,
                                project: 1,
                                username: 1,
                                role: 1,
                                timestamp: 1,
                                model: 1,
                            },
                        },
                    ],
                },
            },
            {
                $project: {
                    allMedia: { $concatArrays: ["$imageItems", "$audioItems"] },
                },
            },
            { $unwind: "$allMedia" },
            { $replaceRoot: { newRoot: "$allMedia" } },
            { $sort: { timestamp: -1 } },
        ];

        if (type) {
            pipeline.push({ $match: { mediaType: type } });
        }
        if (origin === "user") {
            pipeline.push({ $match: { role: "user" } });
        } else if (origin === "ai") {
            pipeline.push({ $match: { role: "assistant" } });
        }

        const countPipeline = [...pipeline, { $count: "total" }];
        const [countResult] = await db.collection(CONVERSATIONS_COL).aggregate(countPipeline).toArray();
        const total = countResult?.total || 0;

        pipeline.push({ $skip: skip }, { $limit: lim });

        const items = await db.collection(CONVERSATIONS_COL).aggregate(pipeline).toArray();

        const data = items.map((item) => ({
            url: item.url,
            mediaType: item.mediaType,
            origin: item.role === "assistant" ? "ai" : "user",
            convId: item.convId,
            convTitle: item.convTitle || "Untitled",
            project: item.project,
            username: item.username,
            model: item.model,
            timestamp: item.timestamp,
        }));

        res.json({ data, total, page: parseInt(page, 10), limit: lim });
    } catch (error) {
        logger.error(`GET /media error: ${error.message}`);
        next(error);
    }
});

export default router;

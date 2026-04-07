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

    const {
      page = 1,
      limit = 100,
      type,
      origin,
      search,
      provider,
      model,
      from,
      to,
    } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const lim = parseInt(limit, 10);

    // Always scope to the caller's project
    const preMatch = { project: req.project };
    if (from || to) {
      preMatch.updatedAt = {};
      if (from) preMatch.updatedAt.$gte = from;
      if (to) preMatch.updatedAt.$lte = to;
    }

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
          content: "$messages.content",
          images: { $ifNull: ["$messages.images", []] },
          audio: "$messages.audio",
          toolCalls: { $ifNull: ["$messages.toolCalls", []] },
          timestamp: { $ifNull: ["$messages.timestamp", "$updatedAt"] },
          model: "$messages.model",
          provider: "$messages.provider",
        },
      },
      // Search across conversation title AND message content
      ...(search
        ? [
            {
              $match: {
                $or: [
                  { convTitle: { $regex: search, $options: "i" } },
                  { content: { $regex: search, $options: "i" } },
                ],
              },
            },
          ]
        : []),
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
                provider: 1,
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
                provider: 1,
              },
            },
          ],
          // Extract browser screenshots from toolCalls[].result.screenshotRef
          screenshotItems: [
            { $unwind: "$toolCalls" },
            { $match: { "toolCalls.result.screenshotRef": { $exists: true, $ne: null } } },
            {
              $project: {
                url: "$toolCalls.result.screenshotRef",
                mediaType: "image",
                convId: 1,
                convTitle: 1,
                project: 1,
                username: 1,
                role: 1,
                timestamp: 1,
                model: 1,
                provider: 1,
              },
            },
          ],
        },
      },
      {
        $project: {
          allMedia: { $concatArrays: ["$imageItems", "$audioItems", "$screenshotItems"] },
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
    if (provider) {
      pipeline.push({ $match: { provider } });
    }
    if (model) {
      pipeline.push({ $match: { model } });
    }

    const countPipeline = [...pipeline, { $count: "total" }];
    const [countResult] = await db
      .collection(CONVERSATIONS_COL)
      .aggregate(countPipeline)
      .toArray();
    const total = countResult?.total || 0;

    pipeline.push({ $skip: skip }, { $limit: lim });

    const items = await db
      .collection(CONVERSATIONS_COL)
      .aggregate(pipeline)
      .toArray();

    // Derive filter options from the full (non-paginated, non-provider/model-filtered) media set
    const filterPipeline = [
      { $match: preMatch },
      { $unwind: "$messages" },
      {
        $project: {
          role: "$messages.role",
          images: { $ifNull: ["$messages.images", []] },
          audio: "$messages.audio",
          toolCalls: { $ifNull: ["$messages.toolCalls", []] },
          model: "$messages.model",
          provider: "$messages.provider",
        },
      },
      {
        $facet: {
          imageModels: [
            { $unwind: "$images" },
            { $project: { mediaType: "image", role: 1, model: 1, provider: 1 } },
          ],
          audioModels: [
            { $match: { audio: { $ne: null, $exists: true } } },
            { $project: { mediaType: "audio", role: 1, model: 1, provider: 1 } },
          ],
          screenshotModels: [
            { $unwind: "$toolCalls" },
            { $match: { "toolCalls.result.screenshotRef": { $exists: true, $ne: null } } },
            { $project: { mediaType: "image", role: 1, model: 1, provider: 1 } },
          ],
        },
      },
      {
        $project: {
          allMedia: { $concatArrays: ["$imageModels", "$audioModels", "$screenshotModels"] },
        },
      },
      { $unwind: "$allMedia" },
      { $replaceRoot: { newRoot: "$allMedia" } },
    ];

    // Apply type / origin filters (but NOT provider/model filters)
    if (type) filterPipeline.push({ $match: { mediaType: type } });
    if (origin === "user") filterPipeline.push({ $match: { role: "user" } });
    else if (origin === "ai")
      filterPipeline.push({ $match: { role: "assistant" } });

    filterPipeline.push({
      $group: {
        _id: null,
        allProviders: { $addToSet: "$provider" },
        allModels: { $addToSet: "$model" },
      },
    });

    const [filterResult] = await db
      .collection(CONVERSATIONS_COL)
      .aggregate(filterPipeline)
      .toArray();
    const allProviders = (filterResult?.allProviders || [])
      .filter(Boolean)
      .sort();
    const allModels = (filterResult?.allModels || []).filter(Boolean).sort();

    const data = items.map((item) => ({
      url: item.url,
      mediaType: item.mediaType,
      origin: item.role === "assistant" ? "ai" : "user",
      convId: item.convId,
      convTitle: item.convTitle || "Untitled",
      project: item.project,
      username: item.username,
      model: item.model,
      provider: item.provider,
      timestamp: item.timestamp,
    }));

    res.json({
      data,
      total,
      page: parseInt(page, 10),
      limit: lim,
      providers: allProviders,
      models: allModels,
    });
  } catch (error) {
    logger.error(`GET /media error: ${error.message}`);
    next(error);
  }
});

export default router;

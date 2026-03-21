import express from "express";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import { getProvider } from "../providers/index.js";
import logger from "../utils/logger.js";
import os from "os";

const router = express.Router();
const REQUESTS_COL = "requests";
const CONVERSATIONS_COL = "conversations";
const WORKFLOWS_COL = "workflows";



// ── Helper: get DB handle ────────────────────────────────────
function getDb() {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) return null;
    return client.db(MONGO_DB_NAME);
}

// ============================================================
// GET /admin/requests — paginated, filtered request logs
// ============================================================
router.get("/requests", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const {
            page = 1,
            limit = 50,
            project,
            username,
            provider,
            model,
            endpoint,
            success,
            from,
            to,
            sort = "timestamp",
            order = "desc",
        } = req.query;

        const filter = {};
        if (project) filter.project = project;
        if (username) filter.username = username;
        if (provider) filter.provider = provider;
        if (model) filter.model = model;
        if (endpoint) filter.endpoint = endpoint;
        if (success !== undefined) filter.success = success === "true";
        if (from || to) {
            filter.timestamp = {};
            if (from) filter.timestamp.$gte = from;
            if (to) filter.timestamp.$lte = to;
        }

        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const lim = parseInt(limit, 10);
        const sortDir = order === "asc" ? 1 : -1;

        const [docs, total] = await Promise.all([
            db
                .collection(REQUESTS_COL)
                .find(filter)
                .sort({ [sort]: sortDir })
                .skip(skip)
                .limit(lim)
                .toArray(),
            db.collection(REQUESTS_COL).countDocuments(filter),
        ]);

        res.json({ data: docs, total, page: parseInt(page, 10), limit: lim });
    } catch (error) {
        logger.error(`Admin /requests error: ${error.message}`);
        next(error);
    }
});

// ============================================================
// GET /admin/requests/:id — single request detail
// ============================================================
router.get("/requests/:id", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const doc = await db
            .collection(REQUESTS_COL)
            .findOne({ requestId: req.params.id });
        if (!doc) return res.status(404).json({ error: "Request not found" });

        res.json(doc);
    } catch (error) {
        logger.error(`Admin /requests/:id error: ${error.message}`);
        next(error);
    }
});

// ============================================================
// GET /admin/requests/:id/associations — conversations & workflows
// ============================================================
router.get("/requests/:id/associations", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const request = await db
            .collection(REQUESTS_COL)
            .findOne({ requestId: req.params.id });
        if (!request) return res.status(404).json({ error: "Request not found" });

        let conversations = [];
        let workflows = [];

        if (request.conversationId) {
            // Find conversations matching this conversationId
            conversations = await db
                .collection(CONVERSATIONS_COL)
                .find({ id: request.conversationId })
                .project({ id: 1, title: 1, project: 1 })
                .toArray();

            // Find workflows that contain this conversationId
            workflows = await db
                .collection(WORKFLOWS_COL)
                .find({ conversationIds: request.conversationId })
                .project({ _id: 1, name: 1, nodeCount: 1, edgeCount: 1, source: 1 })
                .toArray();

            // Normalize _id to string id
            workflows = workflows.map((w) => ({
                id: w._id.toString(),
                name: w.name || "Untitled Workflow",
                nodeCount: w.nodeCount || 0,
                edgeCount: w.edgeCount || 0,
                source: w.source || "retina",
            }));
        }

        res.json({ conversations, workflows });
    } catch (error) {
        logger.error(`Admin /requests/:id/associations error: ${error.message}`);
        next(error);
    }
});

// ============================================================
// GET /admin/stats — aggregate stats
// ============================================================
router.get("/stats", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const { from, to } = req.query;
        const match = {};
        if (from || to) {
            match.timestamp = {};
            if (from) match.timestamp.$gte = from;
            if (to) match.timestamp.$lte = to;
        }

        const pipeline = [
            ...(Object.keys(match).length ? [{ $match: match }] : []),
            {
                $group: {
                    _id: null,
                    totalRequests: { $sum: 1 },
                    totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                    totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                    totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    avgTokensPerSec: { $avg: { $ifNull: ["$tokensPerSec", 0] } },
                    successCount: {
                        $sum: { $cond: [{ $eq: ["$success", true] }, 1, 0] },
                    },
                    errorCount: {
                        $sum: { $cond: [{ $eq: ["$success", false] }, 1, 0] },
                    },
                },
            },
        ];

        const [result] = await db
            .collection(REQUESTS_COL)
            .aggregate(pipeline)
            .toArray();

        res.json(
            result || {
                totalRequests: 0,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalCost: 0,
                avgLatency: 0,
                avgTokensPerSec: 0,
                successCount: 0,
                errorCount: 0,
            },
        );
    } catch (error) {
        logger.error(`Admin /stats error: ${error.message}`);
        next(error);
    }
});

// ============================================================
// GET /admin/stats/projects — per-project breakdown
// ============================================================
router.get("/stats/projects", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const { from, to } = req.query;
        const match = {};
        if (from || to) {
            match.timestamp = {};
            if (from) match.timestamp.$gte = from;
            if (to) match.timestamp.$lte = to;
        }

        const pipeline = [
            ...(Object.keys(match).length ? [{ $match: match }] : []),
            {
                $group: {
                    _id: "$project",
                    totalRequests: { $sum: 1 },
                    totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                    totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                    totalTokens: {
                        $sum: {
                            $add: [
                                { $ifNull: ["$inputTokens", 0] },
                                { $ifNull: ["$outputTokens", 0] },
                            ],
                        },
                    },
                    totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    avgTokensPerSec: { $avg: { $ifNull: ["$tokensPerSec", null] } },
                    lastRequest: { $max: "$timestamp" },
                    _models: { $addToSet: "$model" },
                    _providers: { $addToSet: "$provider" },
                },
            },
            {
                $addFields: {
                    modelCount: { $size: "$_models" },
                    providerCount: { $size: "$_providers" },
                },
            },
            { $sort: { totalRequests: -1 } },
        ];

        // Count workflows per project via conversationIds → conversations.project
        const workflowPipeline = [
            { $match: { conversationIds: { $exists: true, $ne: [] } } },
            { $lookup: {
                from: CONVERSATIONS_COL,
                localField: "conversationIds",
                foreignField: "id",
                as: "_convs",
                pipeline: [{ $project: { project: 1 } }],
            }},
            { $unwind: "$_convs" },
            { $group: { _id: "$_convs.project", workflowIds: { $addToSet: "$_id" } } },
            { $project: { _id: 1, workflowCount: { $size: "$workflowIds" } } },
        ];

        // Count conversations per project
        const convPipeline = [
            { $group: { _id: "$project", conversationCount: { $sum: 1 } } },
        ];

        const [results, workflowCounts, convCounts] = await Promise.all([
            db.collection(REQUESTS_COL).aggregate(pipeline).toArray(),
            db.collection(WORKFLOWS_COL).aggregate(workflowPipeline).toArray(),
            db.collection(CONVERSATIONS_COL).aggregate(convPipeline).toArray(),
        ]);

        // Build a project → workflowCount map
        const wfMap = {};
        for (const wc of workflowCounts) {
            wfMap[wc._id || "unknown"] = wc.workflowCount;
        }

        // Build a project → conversationCount map
        const convMap = {};
        for (const cc of convCounts) {
            convMap[cc._id || "unknown"] = cc.conversationCount;
        }

        res.json(
            results.map((r) => ({
                project: r._id || "unknown",
                totalRequests: r.totalRequests,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                totalTokens: r.totalTokens,
                totalCost: r.totalCost,
                avgLatency: r.avgLatency,
                avgTokensPerSec: r.avgTokensPerSec,
                lastRequest: r.lastRequest,
                modelCount: r.modelCount,
                providerCount: r.providerCount,
                workflowCount: wfMap[r._id || "unknown"] || 0,
                conversationCount: convMap[r._id || "unknown"] || 0,
            })),
        );
    } catch (error) {
        logger.error(`Admin /stats/projects error: ${error.message}`);
        next(error);
    }
});

// ============================================================
// GET /admin/stats/users — per-user breakdown
// ============================================================
router.get("/stats/users", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const pipeline = [
            {
                $group: {
                    _id: "$username",
                    totalRequests: { $sum: 1 },
                    totalTokens: {
                        $sum: {
                            $add: [
                                { $ifNull: ["$inputTokens", 0] },
                                { $ifNull: ["$outputTokens", 0] },
                            ],
                        },
                    },
                    totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    lastRequest: { $max: "$timestamp" },
                },
            },
            { $sort: { totalRequests: -1 } },
        ];

        const results = await db
            .collection(REQUESTS_COL)
            .aggregate(pipeline)
            .toArray();

        res.json(
            results.map((r) => ({
                username: r._id || "unknown",
                totalRequests: r.totalRequests,
                totalTokens: r.totalTokens,
                totalCost: r.totalCost,
                avgLatency: r.avgLatency,
                lastRequest: r.lastRequest,
            })),
        );
    } catch (error) {
        logger.error(`Admin /stats/users error: ${error.message}`);
        next(error);
    }
});

// ============================================================
// GET /admin/stats/models — per-model breakdown
// ============================================================
router.get("/stats/models", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const { from, to } = req.query;
        const match = {};
        if (from || to) {
            match.timestamp = {};
            if (from) match.timestamp.$gte = from;
            if (to) match.timestamp.$lte = to;
        }

        const pipeline = [
            ...(Object.keys(match).length ? [{ $match: match }] : []),
            {
                $group: {
                    _id: { model: "$model", provider: "$provider" },
                    totalRequests: { $sum: 1 },
                    totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                    totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                    totalTokens: {
                        $sum: {
                            $add: [
                                { $ifNull: ["$inputTokens", 0] },
                                { $ifNull: ["$outputTokens", 0] },
                            ],
                        },
                    },
                    totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    avgTokensPerSec: { $avg: { $ifNull: ["$tokensPerSec", null] } },
                },
            },
            { $sort: { totalRequests: -1 } },
        ];

        const results = await db
            .collection(REQUESTS_COL)
            .aggregate(pipeline)
            .toArray();

        res.json(
            results.map((r) => ({
                model: r._id.model,
                provider: r._id.provider,
                totalRequests: r.totalRequests,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                totalTokens: r.totalTokens,
                totalCost: r.totalCost,
                avgLatency: r.avgLatency,
                avgTokensPerSec: r.avgTokensPerSec,
            })),
        );
    } catch (error) {
        logger.error(`Admin /stats/models error: ${error.message}`);
        next(error);
    }
});

// ============================================================
// GET /admin/stats/endpoints — per-endpoint breakdown
// ============================================================
router.get("/stats/endpoints", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const { from, to } = req.query;
        const match = {};
        if (from || to) {
            match.timestamp = {};
            if (from) match.timestamp.$gte = from;
            if (to) match.timestamp.$lte = to;
        }

        const pipeline = [
            ...(Object.keys(match).length ? [{ $match: match }] : []),
            {
                $group: {
                    _id: "$endpoint",
                    totalRequests: { $sum: 1 },
                    totalTokens: {
                        $sum: {
                            $add: [
                                { $ifNull: ["$inputTokens", 0] },
                                { $ifNull: ["$outputTokens", 0] },
                            ],
                        },
                    },
                    totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    successRate: { $avg: { $cond: [{ $eq: ["$success", true] }, 1, 0] } },
                },
            },
            { $sort: { totalRequests: -1 } },
        ];

        const results = await db
            .collection(REQUESTS_COL)
            .aggregate(pipeline)
            .toArray();

        res.json(
            results.map((r) => ({
                endpoint: r._id || "unknown",
                totalRequests: r.totalRequests,
                totalTokens: r.totalTokens,
                totalCost: r.totalCost,
                avgLatency: r.avgLatency,
                successRate: r.successRate,
            })),
        );
    } catch (error) {
        logger.error(`Admin /stats/endpoints error: ${error.message}`);
        next(error);
    }
});

// ============================================================
// GET /admin/stats/costs — comprehensive cost breakdown
// ============================================================
router.get("/stats/costs", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const { from, to } = req.query;
        const match = {};
        if (from || to) {
            match.timestamp = {};
            if (from) match.timestamp.$gte = from;
            if (to) match.timestamp.$lte = to;
        }
        const matchStage = Object.keys(match).length ? [{ $match: match }] : [];

        // Run all aggregations in parallel
        const [totals, byProject, byProvider, byModel, byEndpoint, byProjectProvider, byProjectEndpoint, byProjectModel] =
            await Promise.all([
                // Totals
                db
                    .collection(REQUESTS_COL)
                    .aggregate([
                        ...matchStage,
                        {
                            $group: {
                                _id: null,
                                totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                                totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                                totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                                totalRequests: { $sum: 1 },
                                avgTokensPerSec: { $avg: { $ifNull: ["$tokensPerSec", null] } },
                            },
                        },
                    ])
                    .toArray(),

                // By project
                db
                    .collection(REQUESTS_COL)
                    .aggregate([
                        ...matchStage,
                        {
                            $group: {
                                _id: "$project",
                                totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                                totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                                totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                                totalRequests: { $sum: 1 },
                                avgTokensPerSec: { $avg: { $ifNull: ["$tokensPerSec", null] } },
                            },
                        },
                        { $sort: { totalCost: -1 } },
                    ])
                    .toArray(),

                // By provider
                db
                    .collection(REQUESTS_COL)
                    .aggregate([
                        ...matchStage,
                        {
                            $group: {
                                _id: "$provider",
                                totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                                totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                                totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                                totalRequests: { $sum: 1 },
                                avgTokensPerSec: { $avg: { $ifNull: ["$tokensPerSec", null] } },
                            },
                        },
                        { $sort: { totalCost: -1 } },
                    ])
                    .toArray(),

                // By model
                db
                    .collection(REQUESTS_COL)
                    .aggregate([
                        ...matchStage,
                        {
                            $group: {
                                _id: { model: "$model", provider: "$provider" },
                                totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                                totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                                totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                                totalRequests: { $sum: 1 },
                                avgTokensPerSec: { $avg: { $ifNull: ["$tokensPerSec", null] } },
                            },
                        },
                        { $sort: { totalCost: -1 } },
                    ])
                    .toArray(),

                // By endpoint (modality)
                db
                    .collection(REQUESTS_COL)
                    .aggregate([
                        ...matchStage,
                        {
                            $group: {
                                _id: "$endpoint",
                                totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                                totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                                totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                                totalRequests: { $sum: 1 },
                                avgTokensPerSec: { $avg: { $ifNull: ["$tokensPerSec", null] } },
                            },
                        },
                        { $sort: { totalCost: -1 } },
                    ])
                    .toArray(),

                // By project + provider (for nested breakdown)
                db
                    .collection(REQUESTS_COL)
                    .aggregate([
                        ...matchStage,
                        {
                            $group: {
                                _id: { project: "$project", provider: "$provider" },
                                totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                                totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                                totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                                totalRequests: { $sum: 1 },
                                avgTokensPerSec: { $avg: { $ifNull: ["$tokensPerSec", null] } },
                            },
                        },
                        { $sort: { totalCost: -1 } },
                    ])
                    .toArray(),

                // By project + endpoint (for nested modality breakdown)
                db
                    .collection(REQUESTS_COL)
                    .aggregate([
                        ...matchStage,
                        {
                            $group: {
                                _id: { project: "$project", endpoint: "$endpoint" },
                                totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                                totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                                totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                                totalRequests: { $sum: 1 },
                                avgTokensPerSec: { $avg: { $ifNull: ["$tokensPerSec", null] } },
                            },
                        },
                        { $sort: { totalCost: -1 } },
                    ])
                    .toArray(),

                // By project + model (for nested model breakdown)
                db
                    .collection(REQUESTS_COL)
                    .aggregate([
                        ...matchStage,
                        {
                            $group: {
                                _id: { project: "$project", model: "$model", provider: "$provider" },
                                totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                                totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                                totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                                totalRequests: { $sum: 1 },
                                avgTokensPerSec: { $avg: { $ifNull: ["$tokensPerSec", null] } },
                            },
                        },
                        { $sort: { totalCost: -1 } },
                    ])
                    .toArray(),
            ]);

        // Nest provider breakdown under each project
        const providersByProject = {};
        for (const row of byProjectProvider) {
            const proj = row._id.project || "unknown";
            if (!providersByProject[proj]) providersByProject[proj] = [];
            providersByProject[proj].push({
                provider: row._id.provider || "unknown",
                totalCost: row.totalCost,
                totalInputTokens: row.totalInputTokens,
                totalOutputTokens: row.totalOutputTokens,
                totalRequests: row.totalRequests,
                avgTokensPerSec: row.avgTokensPerSec,
            });
        }

        // Nest endpoint breakdown under each project
        const endpointsByProject = {};
        for (const row of byProjectEndpoint) {
            const proj = row._id.project || "unknown";
            if (!endpointsByProject[proj]) endpointsByProject[proj] = [];
            endpointsByProject[proj].push({
                endpoint: row._id.endpoint || "unknown",
                totalCost: row.totalCost,
                totalInputTokens: row.totalInputTokens,
                totalOutputTokens: row.totalOutputTokens,
                totalRequests: row.totalRequests,
                avgTokensPerSec: row.avgTokensPerSec,
            });
        }

        // Nest model breakdown under each project
        const modelsByProject = {};
        for (const row of byProjectModel) {
            const proj = row._id.project || "unknown";
            if (!modelsByProject[proj]) modelsByProject[proj] = [];
            modelsByProject[proj].push({
                model: row._id.model || "unknown",
                provider: row._id.provider || "unknown",
                totalCost: row.totalCost,
                totalInputTokens: row.totalInputTokens,
                totalOutputTokens: row.totalOutputTokens,
                totalRequests: row.totalRequests,
                avgTokensPerSec: row.avgTokensPerSec,
            });
        }

        const t = totals[0] || {
            totalCost: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalRequests: 0,
        };

        res.json({
            totals: {
                totalCost: t.totalCost,
                totalInputTokens: t.totalInputTokens,
                totalOutputTokens: t.totalOutputTokens,
                totalRequests: t.totalRequests,
                avgTokensPerSec: t.avgTokensPerSec,
            },
            byProject: byProject.map((r) => ({
                project: r._id || "unknown",
                totalCost: r.totalCost,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                totalRequests: r.totalRequests,
                avgTokensPerSec: r.avgTokensPerSec,
                byProvider: providersByProject[r._id || "unknown"] || [],
                byEndpoint: endpointsByProject[r._id || "unknown"] || [],
                byModel: modelsByProject[r._id || "unknown"] || [],
            })),
            byProvider: byProvider.map((r) => ({
                provider: r._id || "unknown",
                totalCost: r.totalCost,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                totalRequests: r.totalRequests,
            })),
            byModel: byModel.map((r) => ({
                model: r._id.model || "unknown",
                provider: r._id.provider || "unknown",
                totalCost: r.totalCost,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                totalRequests: r.totalRequests,
                avgTokensPerSec: r.avgTokensPerSec,
            })),
            byEndpoint: byEndpoint.map((r) => ({
                endpoint: r._id || "unknown",
                totalCost: r.totalCost,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                totalRequests: r.totalRequests,
                avgTokensPerSec: r.avgTokensPerSec,
            })),
        });
    } catch (error) {
        logger.error(`Admin /stats/costs error: ${error.message}`);
        next(error);
    }
});

// ============================================================
// GET /admin/stats/timeline — requests grouped by hour/day
// ============================================================
router.get("/stats/timeline", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const { hours = 24, from, to } = req.query;

        let sinceDate, untilDate;
        if (from) {
            sinceDate = new Date(from);
        } else {
            sinceDate = new Date(Date.now() - parseInt(hours, 10) * 60 * 60 * 1000);
        }
        if (to) {
            untilDate = new Date(to);
        }

        const spanMs = (untilDate || new Date()) - sinceDate;
        const spanDays = spanMs / (1000 * 60 * 60 * 24);
        const granularity = spanDays > 7 ? "day" : "hour";
        const substrLen = granularity === "day" ? 10 : 13; // "2026-03-21" vs "2026-03-21T14"

        const timeMatch = { $gte: sinceDate.toISOString() };
        if (untilDate) timeMatch.$lte = untilDate.toISOString();

        const pipeline = [
            { $match: { timestamp: timeMatch } },
            {
                $group: {
                    _id: { $substr: ["$timestamp", 0, substrLen] },
                    requests: { $sum: 1 },
                    tokens: {
                        $sum: {
                            $add: [
                                { $ifNull: ["$inputTokens", 0] },
                                { $ifNull: ["$outputTokens", 0] },
                            ],
                        },
                    },
                    cost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                    avgLatency: { $avg: { $ifNull: ["$totalTime", null] } },
                    successes: {
                        $sum: { $cond: [{ $eq: ["$success", true] }, 1, 0] },
                    },
                },
            },
            { $sort: { _id: 1 } },
        ];

        const results = await db
            .collection(REQUESTS_COL)
            .aggregate(pipeline)
            .toArray();

        res.json({
            granularity,
            data: results.map((r) => ({
                hour: r._id,
                requests: r.requests,
                tokens: r.tokens,
                cost: r.cost,
                avgLatency: r.avgLatency ? Math.round(r.avgLatency) : 0,
                successRate: r.requests > 0 ? Math.round((r.successes / r.requests) * 100) : 100,
            })),
        });
    } catch (error) {
        logger.error(`Admin /stats/timeline error: ${error.message}`);
        next(error);
    }
});

// ============================================================
// GET /admin/conversations — cross-project conversation list
// ============================================================
router.get("/conversations", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const {
            page = 1,
            limit = 50,
            project,
            username,
            search,
            sort = "updatedAt",
            order = "desc",
        } = req.query;

        const filter = {};
        if (project) filter.project = project;
        if (username) filter.username = username;
        if (search) filter.title = { $regex: search, $options: "i" };

        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const lim = parseInt(limit, 10);
        const sortDir = order === "asc" ? 1 : -1;

        const pipeline = [
            ...(Object.keys(filter).length ? [{ $match: filter }] : []),
            { $sort: { [sort]: sortDir } },
            {
                $project: {
                    id: 1,
                    project: 1,
                    username: 1,
                    title: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    modalities: 1,
                    providers: 1,
                    messageCount: { $size: { $ifNull: ["$messages", []] } },
                    totalCost: {
                        $ifNull: [
                            "$totalCost",
                            {
                                $reduce: {
                                    input: { $ifNull: ["$messages", []] },
                                    initialValue: 0,
                                    in: {
                                        $add: ["$$value", { $ifNull: ["$$this.estimatedCost", 0] }],
                                    },
                                },
                            },
                        ],
                    },
                },
            },
            { $skip: skip },
            { $limit: lim },
        ];

        const [docs, total] = await Promise.all([
            db.collection(CONVERSATIONS_COL).aggregate(pipeline).toArray(),
            db.collection(CONVERSATIONS_COL).countDocuments(filter),
        ]);

        res.json({ data: docs, total, page: parseInt(page, 10), limit: lim });
    } catch (error) {
        logger.error(`Admin /conversations error: ${error.message}`);
        next(error);
    }
});

// ============================================================
// GET /admin/conversations/filters — distinct project & username values
// ============================================================
router.get("/conversations/filters", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const [projects, usernames] = await Promise.all([
            db.collection(CONVERSATIONS_COL).distinct("project"),
            db.collection(CONVERSATIONS_COL).distinct("username"),
        ]);

        res.json({
            projects: projects.filter(Boolean).sort(),
            usernames: usernames.filter(Boolean).sort(),
        });
    } catch (error) {
        logger.error(`Admin /conversations/filters error: ${error.message}`);
        next(error);
    }
});

// ============================================================
// GET /admin/conversations/:id — single conversation, full msgs
// ============================================================
router.get("/conversations/:id", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const doc = await db
            .collection(CONVERSATIONS_COL)
            .findOne({ id: req.params.id });
        if (!doc) return res.status(404).json({ error: "Conversation not found" });

        res.json(doc);
    } catch (error) {
        logger.error(`Admin /conversations/:id error: ${error.message}`);
        next(error);
    }
});

// ============================================================
// GET /admin/live — conversations updated in last N minutes
// ============================================================
router.get("/live", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const { minutes = 5 } = req.query;
        const since = new Date(
            Date.now() - parseInt(minutes, 10) * 60 * 1000,
        ).toISOString();

        const [rawConversations, recentRequests] = await Promise.all([
            db
                .collection(CONVERSATIONS_COL)
                .find({ updatedAt: { $gte: since } })
                .project({
                    id: 1,
                    project: 1,
                    username: 1,
                    title: 1,
                    updatedAt: 1,
                    messages: 1,
                    modalities: 1,
                    providers: 1,
                    isGenerating: 1,
                })
                .sort({ updatedAt: -1 })
                .toArray(),
            db
                .collection(REQUESTS_COL)
                .find({ timestamp: { $gte: since } })
                .sort({ timestamp: -1 })
                .limit(20)
                .toArray(),
        ]);

        // Enrich conversations with lastMessage info and remap fields
        const conversations = rawConversations.map((c) => {
            const msgs = c.messages || [];
            const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
            let lastMessageText = null;
            if (lastMsg) {
                const content = lastMsg.content;
                if (typeof content === "string") {
                    lastMessageText = content;
                } else if (Array.isArray(content)) {
                    const textPart = content.find((p) => p.type === "text");
                    lastMessageText = textPart?.text || null;
                }
            }
            // Compute totalCost from messages (covers docs saved before totalCost field existed)
            const totalCost =
                c.totalCost || msgs.reduce((sum, m) => sum + (m.estimatedCost || 0), 0);
            return {
                id: c.id,
                project: c.project,
                username: c.username,
                title: c.title,
                lastActivity: c.updatedAt,
                messageCount: msgs.length,
                lastMessage: lastMessageText,
                lastMessageRole: lastMsg?.role || null,
                isGenerating: c.isGenerating || false,
                modalities: c.modalities || null,
                providers: c.providers || [],
                totalCost,
            };
        });

        // Calc requests per minute
        const totalRecent = await db
            .collection(REQUESTS_COL)
            .countDocuments({ timestamp: { $gte: since } });
        const requestsPerMinute = totalRecent / parseInt(minutes, 10);

        res.json({
            conversations,
            recentRequests,
            requestsPerMinute: Math.round(requestsPerMinute * 100) / 100,
            activeCount: conversations.length,
        });
    } catch (error) {
        logger.error(`Admin /live error: ${error.message}`);
        next(error);
    }
});

// ============================================================
// GET /admin/health — system health
// ============================================================
router.get("/health", async (_req, res) => {
    const db = getDb();
    const mongoStatus = db ? "connected" : "disconnected";

    let dbStats = null;
    if (db) {
        try {
            const [requestCount, conversationCount] = await Promise.all([
                db.collection(REQUESTS_COL).estimatedDocumentCount(),
                db.collection(CONVERSATIONS_COL).estimatedDocumentCount(),
            ]);
            dbStats = { requestCount, conversationCount };
        } catch {
            // ignore
        }
    }

    res.json({
        status: mongoStatus === "connected" ? "healthy" : "degraded",
        mongo: mongoStatus,
        dbStats,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        system: {
            platform: os.platform(),
            arch: os.arch(),
            cpus: os.cpus().length,
            totalMemory: os.totalmem(),
            freeMemory: os.freemem(),
        },
    });
});

// ============================================================
// LM Studio — Model Management
// ============================================================

/**
 * GET /admin/lm-studio/models
 * List all models available in LM Studio (loaded + downloaded).
 */
router.get("/lm-studio/models", async (_req, res, next) => {
    try {
        const provider = getProvider("lm-studio");
        const data = await provider.listModels();
        res.json(data);
    } catch (error) {
        logger.error(`Admin /lm-studio/models error: ${error.message}`);
        next(error);
    }
});

/**
 * POST /admin/lm-studio/load
 * Load a model into LM Studio. Auto-unloads any other loaded model first
 * to enforce single-model-at-a-time.
 * Body: { model: "model-key" }
 */
router.post("/lm-studio/load", async (req, res, next) => {
    try {
        const { model } = req.body;
        if (!model) {
            return res
                .status(400)
                .json({ error: true, message: "Missing 'model' in request body" });
        }

        const provider = getProvider("lm-studio");

        // Enforce single model — unload anything currently loaded that isn't the requested model
        try {
            const { models } = await provider.listModels();
            for (const m of models || []) {
                for (const instance of m.loaded_instances || []) {
                    if (instance.id !== model) {
                        logger.info(
                            `Auto-unloading ${instance.id} before loading ${model}`,
                        );
                        await provider.unloadModel(instance.id);
                    }
                }
            }
        } catch (listErr) {
            logger.warn(`Could not list models before loading: ${listErr.message}`);
        }

        const data = await provider.loadModel(model);
        res.json(data);
    } catch (error) {
        logger.error(`Admin /lm-studio/load error: ${error.message}`);
        next(error);
    }
});

/**
 * POST /admin/lm-studio/unload
 * Unload a model from LM Studio memory.
 * Body: { instance_id: "model-instance-id" }
 */
router.post("/lm-studio/unload", async (req, res, next) => {
    try {
        const { instance_id } = req.body;
        if (!instance_id) {
            return res.status(400).json({
                error: true,
                message: "Missing 'instance_id' in request body",
            });
        }

        const provider = getProvider("lm-studio");
        const data = await provider.unloadModel(instance_id);
        res.json(data);
    } catch (error) {
        logger.error(`Admin /lm-studio/unload error: ${error.message}`);
        next(error);
    }
});

// ============================================================
// Workflows — admin read-only views (POST lives at /workflows)
// ============================================================


/**
 * GET /admin/workflows — paginated workflow list
 */
router.get("/workflows", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const {
            page = 1,
            limit = 50,
            project,
            guildId,
            userId,
            userName,
            sort = "createdAt",
            order = "desc",
        } = req.query;

        const filter = {};
        if (guildId) filter.guildId = guildId;
        if (userId) filter.userId = userId;
        if (userName) filter.userName = { $regex: userName, $options: "i" };

        // If project is specified, find all conversation IDs for that project
        // and filter workflows that reference those conversations
        if (project) {
            const convIds = await db
                .collection(CONVERSATIONS_COL)
                .distinct("id", { project });
            filter.conversationIds = { $elemMatch: { $in: convIds } };
        }

        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const lim = parseInt(limit, 10);
        const sortDir = order === "asc" ? 1 : -1;

        const [docs, total] = await Promise.all([
            db
                .collection(WORKFLOWS_COL)
                .find(filter)
                .project({
                    _id: 1,
                    name: 1,
                    messageId: 1,
                    guildId: 1,
                    guildName: 1,
                    channelId: 1,
                    channelName: 1,
                    userId: 1,
                    userName: 1,
                    userContent: 1,
                    stepCount: 1,
                    totalDuration: 1,
                    totalCost: 1,
                    modalities: 1,
                    providers: 1,
                    source: 1,
                    createdAt: 1,
                    updatedAt: 1,
                })
                .sort({ [sort]: sortDir })
                .skip(skip)
                .limit(lim)
                .toArray(),
            db.collection(WORKFLOWS_COL).countDocuments(filter),
        ]);

        res.json({ data: docs, total, page: parseInt(page, 10), limit: lim });
    } catch (error) {
        logger.error(`Admin GET /workflows error: ${error.message}`);
        next(error);
    }
});

/**
 * GET /admin/workflows/:id — full workflow detail
 */
router.get("/workflows/:id", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const { ObjectId } = await import("mongodb");
        let objectId;
        try {
            objectId = new ObjectId(req.params.id);
        } catch {
            return res.status(400).json({ error: "Invalid workflow ID" });
        }

        const doc = await db.collection(WORKFLOWS_COL).findOne({ _id: objectId });
        if (!doc) return res.status(404).json({ error: "Workflow not found" });

        res.json(doc);
    } catch (error) {
        logger.error(`Admin GET /workflows/:id error: ${error.message}`);
        next(error);
    }
});

// ============================================================
// GET /admin/media — extract media from all conversations
// ============================================================
router.get("/media", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const { page = 1, limit = 100, type, origin, search, project, username, from, to } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const lim = parseInt(limit, 10);

        // Get distinct projects and usernames for filter dropdowns
        const [projects, usernames] = await Promise.all([
            db.collection(CONVERSATIONS_COL).distinct("project"),
            db.collection(CONVERSATIONS_COL).distinct("username"),
        ]);

        // Use aggregation to unwind messages and extract media in one query
        const preMatch = {};
        if (search) preMatch.title = { $regex: search, $options: "i" };
        if (project) preMatch.project = project;
        if (username) preMatch.username = username;
        if (from || to) {
            preMatch.updatedAt = {};
            if (from) preMatch.updatedAt.$gte = from;
            if (to) preMatch.updatedAt.$lte = to;
        }

        const pipeline = [
            ...(Object.keys(preMatch).length ? [{ $match: preMatch }] : []),
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
            // Expand images array into individual items
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
            // Merge both streams
            {
                $project: {
                    allMedia: { $concatArrays: ["$imageItems", "$audioItems"] },
                },
            },
            { $unwind: "$allMedia" },
            { $replaceRoot: { newRoot: "$allMedia" } },
            { $sort: { timestamp: -1 } },
        ];

        // Apply filters
        if (type) {
            pipeline.push({ $match: { mediaType: type } });
        }
        if (origin === "user") {
            pipeline.push({ $match: { role: "user" } });
        } else if (origin === "ai") {
            pipeline.push({ $match: { role: "assistant" } });
        }

        // Count total before pagination
        const countPipeline = [...pipeline, { $count: "total" }];
        const [countResult] = await db.collection(CONVERSATIONS_COL).aggregate(countPipeline).toArray();
        const total = countResult?.total || 0;

        // Apply pagination
        pipeline.push({ $skip: skip }, { $limit: lim });

        const items = await db.collection(CONVERSATIONS_COL).aggregate(pipeline).toArray();

        // Categorize origin
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

        res.json({ data, total, page: parseInt(page, 10), limit: lim, projects: projects.filter(Boolean).sort(), usernames: usernames.filter(Boolean).sort() });
    } catch (error) {
        logger.error(`Admin /media error: ${error.message}`);
        next(error);
    }
});

// ============================================================
// GET /admin/text — extract text content from conversations
// ============================================================
router.get("/text", async (req, res, next) => {
    try {
        const db = getDb();
        if (!db) return res.status(503).json({ error: "Database not available" });

        const { page = 1, limit = 50, origin, search, project, from, to } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const lim = parseInt(limit, 10);

        const preMatch = {};
        if (project) preMatch.project = project;
        if (from || to) {
            preMatch.updatedAt = {};
            if (from) preMatch.updatedAt.$gte = from;
            if (to) preMatch.updatedAt.$lte = to;
        }

        const pipeline = [
            ...(Object.keys(preMatch).length ? [{ $match: preMatch }] : []),
            { $unwind: "$messages" },
            {
                $match: {
                    "messages.content": { $exists: true, $nin: [null, ""] },
                },
            },
            {
                $project: {
                    convId: "$id",
                    convTitle: "$title",
                    project: 1,
                    username: 1,
                    role: "$messages.role",
                    content: "$messages.content",
                    timestamp: { $ifNull: ["$messages.timestamp", "$updatedAt"] },
                    model: "$messages.model",
                    estimatedCost: "$messages.estimatedCost",
                    images: { $size: { $ifNull: ["$messages.images", []] } },
                },
            },
            { $sort: { timestamp: -1 } },
        ];

        // Filters
        if (origin === "user") {
            pipeline.push({ $match: { role: "user" } });
        } else if (origin === "ai") {
            pipeline.push({ $match: { role: "assistant" } });
        }
        if (search) {
            pipeline.push({
                $match: { content: { $regex: search, $options: "i" } },
            });
        }

        const countPipeline = [...pipeline, { $count: "total" }];
        const [countResult] = await db.collection(CONVERSATIONS_COL).aggregate(countPipeline).toArray();
        const total = countResult?.total || 0;

        pipeline.push({ $skip: skip }, { $limit: lim });

        const items = await db.collection(CONVERSATIONS_COL).aggregate(pipeline).toArray();

        const data = items.map((item) => ({
            content: item.content,
            origin: item.role === "assistant" ? "ai" : "user",
            role: item.role,
            convId: item.convId,
            convTitle: item.convTitle || "Untitled",
            project: item.project,
            username: item.username,
            model: item.model,
            estimatedCost: item.estimatedCost,
            hasImages: item.images > 0,
            timestamp: item.timestamp,
        }));

        res.json({ data, total, page: parseInt(page, 10), limit: lim });
    } catch (error) {
        logger.error(`Admin /text error: ${error.message}`);
        next(error);
    }
});

export default router;

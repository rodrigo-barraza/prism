import express from "express";
import { ObjectId } from "mongodb";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import MCPClientService from "../services/MCPClientService.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";

const router = express.Router();
import { COLLECTIONS } from "../constants.js";

const COLLECTION = COLLECTIONS.MCP_SERVERS;

/**
 * GET /mcp-servers
 * List all MCP server configs + live connection status.
 */
router.get("/", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const project = req.project;
    const username = req.username;

    const servers = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .find({ project, username })
      .sort({ createdAt: -1 })
      .toArray();

    // Enrich with live connection status
    const connectedServers = MCPClientService.getConnectedServers();
    const connectedMap = new Map(connectedServers.map((s) => [s.name, s]));

    const enriched = servers.map((s) => {
      const conn = connectedMap.get(s.name);
      return {
        ...s,
        id: s._id.toString(),
        connected: !!conn,
        toolCount: conn?.toolCount || 0,
        tools: conn?.tools || [],
        connectedAt: conn?.connectedAt || null,
      };
    });

    res.json(enriched);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /mcp-servers
 * Add a new MCP server config.
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
      displayName: req.body.displayName || req.body.name,
      transport: req.body.transport || "stdio",
      command: req.body.command || "",
      args: req.body.args || [],
      env: req.body.env || {},
      url: req.body.url || "",
      headers: req.body.headers || {},
      enabled: req.body.enabled !== false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .insertOne(doc);

    logger.info(`MCP server added: ${doc.name} (${result.insertedId})`);
    res.status(201).json({ ...doc, id: result.insertedId.toString() });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /mcp-servers/:id
 * Update an MCP server config.
 */
router.put("/:id", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const updates = {
      ...(req.body.name !== undefined && { name: req.body.name }),
      ...(req.body.displayName !== undefined && { displayName: req.body.displayName }),
      ...(req.body.transport !== undefined && { transport: req.body.transport }),
      ...(req.body.command !== undefined && { command: req.body.command }),
      ...(req.body.args !== undefined && { args: req.body.args }),
      ...(req.body.env !== undefined && { env: req.body.env }),
      ...(req.body.url !== undefined && { url: req.body.url }),
      ...(req.body.headers !== undefined && { headers: req.body.headers }),
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
      return res.status(404).json({ error: "MCP server not found" });
    }

    logger.info(`MCP server updated: ${result.name} (${req.params.id})`);
    res.json({ ...result, id: result._id.toString() });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /mcp-servers/:id
 * Delete an MCP server config (disconnects if connected).
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
      return res.status(404).json({ error: "MCP server not found" });
    }

    // Disconnect if connected
    if (MCPClientService.isConnected(result.name)) {
      await MCPClientService.disconnect(result.name);
    }

    logger.info(`MCP server deleted: ${result.name} (${req.params.id})`);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /mcp-servers/:id/connect
 * Connect to an MCP server.
 */
router.post("/:id/connect", async (req, res, _next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const server = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!server) {
      return res.status(404).json({ error: "MCP server not found" });
    }

    const result = await MCPClientService.connect(server);
    res.json({
      success: true,
      serverName: result.serverName,
      toolCount: result.tools.length,
      tools: result.tools.map((t) => ({
        name: t.name,
        description: t.description,
      })),
    });
  } catch (error) {
    logger.error(`MCP connect failed for ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: `Connection failed: ${error.message}` });
  }
});

/**
 * POST /mcp-servers/:id/disconnect
 * Disconnect from an MCP server.
 */
router.post("/:id/disconnect", async (req, res, next) => {
  try {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      return res.status(503).json({ error: "Database not available" });
    }

    const server = await client
      .db(MONGO_DB_NAME)
      .collection(COLLECTION)
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!server) {
      return res.status(404).json({ error: "MCP server not found" });
    }

    await MCPClientService.disconnect(server.name);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import logger from "../utils/logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Tool name delimiter — MCP tools are namespaced as `mcp__{serverName}__{toolName}`.
 * Double underscore avoids collisions since neither server names nor tool names use it.
 */
const MCP_DELIMITER = "__";
const MCP_PREFIX = "mcp" + MCP_DELIMITER;

// ─── Connection Store ─────────────────────────────────────────────────────────

/**
 * Map of serverName → { client: Client, transport, tools: [], config, status }
 * @type {Map<string, object>}
 */
const connections = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert an MCP tool schema (JSON Schema) to OpenAI function-calling format.
 * Namespaces the tool name with the server prefix.
 */
function mcpToolToSchema(serverName, mcpTool) {
  return {
    name: `${MCP_PREFIX}${serverName}${MCP_DELIMITER}${mcpTool.name}`,
    description: mcpTool.description || "",
    parameters: mcpTool.inputSchema || { type: "object", properties: {} },
    // Metadata for UI display
    _mcpServer: serverName,
    _mcpOriginalName: mcpTool.name,
  };
}

/**
 * Parse a namespaced MCP tool name back into { serverName, toolName }.
 * Returns null if the name doesn't match the MCP pattern.
 */
function parseMCPToolName(fullName) {
  if (!fullName.startsWith(MCP_PREFIX)) return null;
  const rest = fullName.slice(MCP_PREFIX.length);
  const delimIdx = rest.indexOf(MCP_DELIMITER);
  if (delimIdx === -1) return null;
  return {
    serverName: rest.slice(0, delimIdx),
    toolName: rest.slice(delimIdx + MCP_DELIMITER.length),
  };
}

/**
 * Create the appropriate transport based on server config.
 */
function createTransport(config) {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: { ...process.env, ...(config.env || {}) },
    });
  }

  if (config.transport === "streamable-http") {
    const url = new URL(config.url);
    return new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: config.headers || {},
      },
    });
  }

  throw new Error(`Unsupported MCP transport: ${config.transport}`);
}

// ─── Service ──────────────────────────────────────────────────────────────────

const MCPClientService = {
  /**
   * Connect to an MCP server and discover its tools.
   *
   * @param {object} config - Server configuration from DB
   * @param {string} config.name - Unique server slug
   * @param {string} config.transport - "stdio" | "streamable-http"
   * @param {string} [config.command] - Command for stdio transport
   * @param {string[]} [config.args] - Args for stdio transport
   * @param {object} [config.env] - Extra env vars for stdio
   * @param {string} [config.url] - URL for streamable-http transport
   * @param {object} [config.headers] - Headers for streamable-http
   * @returns {Promise<{ tools: Array, serverName: string }>}
   */
  async connect(config) {
    const { name: serverName } = config;

    // Disconnect existing connection if any
    if (connections.has(serverName)) {
      await this.disconnect(serverName);
    }

    logger.info(`[MCP] Connecting to "${serverName}" (${config.transport})...`);

    const transport = createTransport(config);
    const client = new Client(
      { name: "prism-mcp-client", version: "1.0.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
    } catch (err) {
      logger.error(`[MCP] Failed to connect to "${serverName}": ${err.message}`);
      throw err;
    }

    // Discover tools
    let mcpTools = [];
    try {
      const result = await client.listTools();
      mcpTools = result.tools || [];
    } catch (err) {
      logger.warn(`[MCP] Failed to list tools for "${serverName}": ${err.message}`);
    }

    // Convert to our schema format
    const schemas = mcpTools.map((t) => mcpToolToSchema(serverName, t));

    connections.set(serverName, {
      client,
      transport,
      tools: schemas,
      mcpTools,
      config,
      status: "connected",
      connectedAt: new Date(),
    });

    logger.info(
      `[MCP] Connected to "${serverName}" — ${schemas.length} tools: ${mcpTools.map((t) => t.name).join(", ")}`,
    );

    return { tools: schemas, serverName };
  },

  /**
   * Disconnect from an MCP server.
   * @param {string} serverName
   */
  async disconnect(serverName) {
    const conn = connections.get(serverName);
    if (!conn) return;

    try {
      await conn.client.close();
    } catch (err) {
      logger.warn(`[MCP] Error closing "${serverName}": ${err.message}`);
    }

    // For stdio, ensure child process is killed
    if (conn.transport?.close) {
      try {
        await conn.transport.close();
      } catch {
        // Best-effort cleanup
      }
    }

    connections.delete(serverName);
    logger.info(`[MCP] Disconnected from "${serverName}"`);
  },

  /**
   * Reconnect to an MCP server (disconnect then connect).
   * @param {string} serverName
   * @returns {Promise<{ tools: Array, serverName: string }>}
   */
  async reconnect(serverName) {
    const conn = connections.get(serverName);
    if (!conn) throw new Error(`Server "${serverName}" is not connected`);
    return this.connect(conn.config);
  },

  /**
   * Call a tool on a connected MCP server.
   *
   * @param {string} serverName - Server slug
   * @param {string} toolName - Original MCP tool name (not namespaced)
   * @param {object} args - Tool arguments
   * @returns {Promise<object>} Tool result
   */
  async callTool(serverName, toolName, args = {}) {
    const conn = connections.get(serverName);
    if (!conn) {
      return { error: `MCP server "${serverName}" is not connected` };
    }

    try {
      const result = await conn.client.callTool({
        name: toolName,
        arguments: args,
      });

      // MCP returns { content: [{ type: "text", text: "..." }, ...], isError? }
      if (result.isError) {
        const errorText = result.content
          ?.filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n") || "MCP tool returned an error";
        return { error: errorText };
      }

      // Flatten content to a usable format
      const textParts = result.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text) || [];

      // If there's only one text part, return it directly for cleaner output
      if (textParts.length === 1) {
        // Try to parse as JSON (many MCP tools return JSON as text)
        try {
          return JSON.parse(textParts[0]);
        } catch {
          return { result: textParts[0] };
        }
      }

      return { result: textParts.join("\n") };
    } catch (err) {
      // Attempt reconnect once on connection errors
      if (err.message?.includes("closed") || err.message?.includes("transport")) {
        logger.warn(`[MCP] Connection lost to "${serverName}", attempting reconnect...`);
        try {
          await this.reconnect(serverName);
          return this.callTool(serverName, toolName, args);
        } catch (reconnectErr) {
          return { error: `MCP server "${serverName}" connection lost and reconnect failed: ${reconnectErr.message}` };
        }
      }
      return { error: `MCP tool call failed: ${err.message}` };
    }
  },

  /**
   * Get all tool schemas from all connected MCP servers.
   * @returns {Array} Namespaced tool schemas
   */
  getToolSchemas() {
    const allSchemas = [];
    for (const conn of connections.values()) {
      allSchemas.push(...conn.tools);
    }
    return allSchemas;
  },

  /**
   * Get connection info for all servers.
   * @returns {Array<{ name, status, toolCount, transport, connectedAt }>}
   */
  getConnectedServers() {
    const servers = [];
    for (const [name, conn] of connections) {
      servers.push({
        name,
        status: conn.status,
        toolCount: conn.tools.length,
        tools: conn.mcpTools.map((t) => ({ name: t.name, description: t.description })),
        transport: conn.config.transport,
        connectedAt: conn.connectedAt,
      });
    }
    return servers;
  },

  /**
   * Check if a specific server is connected.
   * @param {string} serverName
   * @returns {boolean}
   */
  isConnected(serverName) {
    return connections.has(serverName);
  },

  /**
   * Check if a tool name is an MCP tool.
   * @param {string} toolName
   * @returns {boolean}
   */
  isMCPTool(toolName) {
    return toolName.startsWith(MCP_PREFIX);
  },

  /**
   * Parse an MCP-namespaced tool name.
   * @param {string} fullName
   * @returns {{ serverName: string, toolName: string } | null}
   */
  parseMCPToolName(fullName) {
    return parseMCPToolName(fullName);
  },

  /**
   * Auto-connect all enabled MCP servers from the database.
   * @param {object} db - MongoDB database reference
   * @param {string} project - Project identifier
   * @param {string} username - Username
   */
  async connectAllFromDB(db, project, username) {
    if (!db) return;

    try {
      const servers = await db
        .collection("mcp_servers")
        .find({ project, username, enabled: true })
        .toArray();

      if (servers.length === 0) return;

      logger.info(`[MCP] Auto-connecting ${servers.length} enabled server(s)...`);

      const results = await Promise.allSettled(
        servers.map((s) => this.connect(s)),
      );

      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "rejected") {
          logger.warn(
            `[MCP] Auto-connect failed for "${servers[i].name}": ${results[i].reason?.message}`,
          );
        }
      }
    } catch (err) {
      logger.warn(`[MCP] Auto-connect DB query failed: ${err.message}`);
    }
  },

  /**
   * Disconnect all connected servers. Called on shutdown.
   */
  async disconnectAll() {
    const names = [...connections.keys()];
    await Promise.allSettled(names.map((n) => this.disconnect(n)));
  },
};

export default MCPClientService;

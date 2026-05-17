declare const MCPClientService: {
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
    connect(config: any): Promise<{
        tools: {
            name: string;
            description: any;
            parameters: any;
            _mcpServer: any;
            _mcpOriginalName: any;
        }[];
        serverName: any;
    }>;
    /**
     * Disconnect from an MCP server.
     * @param {string} serverName
     */
    disconnect(serverName: any): Promise<void>;
    /**
     * Reconnect to an MCP server (disconnect then connect).
     * @param {string} serverName
     * @returns {Promise<{ tools: Array, serverName: string }>}
     */
    reconnect(serverName: any): Promise<any>;
    /**
     * Call a tool on a connected MCP server.
     *
     * @param {string} serverName - Server slug
     * @param {string} toolName - Original MCP tool name (not namespaced)
     * @param {object} args - Tool arguments
     * @returns {Promise<object>} Tool result
     */
    callTool(serverName: any, toolName: any, args?: {}): Promise<any>;
    /**
     * Get all tool schemas from all connected MCP servers.
     * @returns {Array} Namespaced tool schemas
     */
    getToolSchemas(): any[];
    /**
     * Get connection info for all servers.
     * @returns {Array<{ name, status, toolCount, transport, connectedAt }>}
     */
    getConnectedServers(): any[];
    /**
     * Check if a specific server is connected.
     * @param {string} serverName
     * @returns {boolean}
     */
    isConnected(serverName: any): boolean;
    /**
     * Check if a tool name is an MCP tool.
     * @param {string} toolName
     * @returns {boolean}
     */
    isMCPTool(toolName: any): any;
    /**
     * Parse an MCP-namespaced tool name.
     * @param {string} fullName
     * @returns {{ serverName: string, toolName: string } | null}
     */
    parseMCPToolName(fullName: any): {
        serverName: any;
        toolName: any;
    };
    /**
     * List available resources from a connected MCP server.
     * MCP Resources are read-only data sources (files, DB rows, API data)
     * that can be fetched by URI.
     *
     * @param {string} serverName - Server slug
     * @returns {Promise<{ resources: Array<{ uri: string, name: string, description?: string, mimeType?: string }> }>}
     */
    listResources(serverName: any): Promise<{
        error: string;
        resources?: undefined;
        serverName?: undefined;
        count?: undefined;
        note?: undefined;
    } | {
        resources: any;
        serverName: any;
        count: any;
        error?: undefined;
        note?: undefined;
    } | {
        resources: any[];
        serverName: any;
        count: number;
        note: string;
        error?: undefined;
    }>;
    /**
     * Read a specific resource from a connected MCP server by URI.
     *
     * @param {string} serverName - Server slug
     * @param {string} uri - Resource URI (from listResources)
     * @returns {Promise<object>} Resource content
     */
    readResource(serverName: any, uri: any): Promise<{
        error: string;
        uri?: undefined;
        mimeType?: undefined;
        content?: undefined;
        serverName?: undefined;
        contents?: undefined;
    } | {
        uri: any;
        mimeType: any;
        content: any;
        serverName: any;
        error?: undefined;
        contents?: undefined;
    } | {
        contents: any;
        serverName: any;
        error?: undefined;
        uri?: undefined;
        mimeType?: undefined;
        content?: undefined;
    }>;
    /**
     * Authenticate with an MCP server by updating its connection headers/env.
     * Reconnects the server with the new credentials.
     *
     * Supports:
     * - Bearer token auth (most common for HTTP MCP servers)
     * - API key header auth
     * - Environment variable injection (for stdio servers)
     *
     * @param {string} serverName - Server slug
     * @param {object} auth - Authentication details
     * @param {string} [auth.token] - Bearer token
     * @param {string} [auth.apiKey] - API key value
     * @param {string} [auth.apiKeyHeader] - Header name for API key (default: "X-API-Key")
     * @param {object} [auth.env] - Additional env vars to inject (for stdio servers)
     * @param {object} [auth.headers] - Additional headers to inject (for HTTP servers)
     * @returns {Promise<object>} Reconnection result
     */
    authenticate(serverName: any, auth?: {}): Promise<{
        error: string;
        acknowledged?: undefined;
        serverName?: undefined;
        toolCount?: undefined;
        message?: undefined;
    } | {
        acknowledged: boolean;
        serverName: any;
        toolCount: any;
        message: string;
        error?: undefined;
    }>;
    /**
     * Auto-connect all enabled MCP servers from the database.
     * @param {object} db - MongoDB database reference
     * @param {string} project - Project identifier
     * @param {string} username - Username
     */
    connectAllFromDB(db: any, project: any, username: any): Promise<void>;
    /**
     * Disconnect all connected servers. Called on shutdown.
     */
    disconnectAll(): Promise<void>;
};
export default MCPClientService;
//# sourceMappingURL=MCPClientService.d.ts.map
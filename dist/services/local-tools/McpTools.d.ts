declare const _default: ({
    name: string;
    schema: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                server_name: {
                    type: string;
                    description: string;
                };
            };
            required: any[];
        };
    };
    domain: string;
    labels: string[];
    execute(args: any): Promise<{
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
    } | {
        resources: any[];
        count: number;
        message: string;
        servers?: undefined;
    } | {
        resources: any[];
        count: number;
        servers: any[];
        message?: undefined;
    }>;
} | {
    name: string;
    schema: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                server_name: {
                    type: string;
                    description: string;
                };
                uri: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    domain: string;
    labels: string[];
    execute(args: any): Promise<{
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
} | {
    name: string;
    schema: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                server_name: {
                    type: string;
                    description: string;
                };
                token: {
                    type: string;
                    description: string;
                };
                api_key: {
                    type: string;
                    description: string;
                };
                api_key_header: {
                    type: string;
                    description: string;
                };
                env: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    domain: string;
    labels: string[];
    execute(args: any): Promise<{
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
})[];
export default _default;
//# sourceMappingURL=McpTools.d.ts.map
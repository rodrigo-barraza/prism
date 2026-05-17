export declare class ProviderError extends Error {
    constructor(provider: any, message: any, statusCode?: number, originalError?: any);
    toJSON(): {
        errorType: any;
        error: boolean;
        provider: any;
        message: string;
        statusCode: any;
    };
}
export declare function errorHandler(err: any, _req: any, res: any, _next: any): any;
//# sourceMappingURL=errors.d.ts.map
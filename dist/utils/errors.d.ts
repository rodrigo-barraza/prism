export declare class ProviderError extends Error {
    constructor(provider: any, message: any, statusCode?: number, originalError?: null);
    toJSON(): any;
}
export declare function errorHandler(error: any, _req: any, res: any, _next: any): any;
//# sourceMappingURL=errors.d.ts.map
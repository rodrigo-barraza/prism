/**
 * Express middleware that:
 *   1. Sets AsyncLocalStorage context (project, username, clientIp)
 *      so deep call-stack code (providers, services) can read it.
 *   2. Logs every completed request with identity, IP, method, path,
 *      status, timing, and transfer sizes.
 */
export declare function requestLoggerMiddleware(req: any, res: any, next: any): void;
//# sourceMappingURL=RequestLoggerMiddleware.d.ts.map
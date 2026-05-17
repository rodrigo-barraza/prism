import logger from "./logger.js";

export class ProviderError extends Error {
  constructor(
    provider: any,
    message: any,
    statusCode = 500,
    originalError = null,
  ) {
    super(message);
    this.name = "ProviderError";
    // @ts-ignore
    this.provider = provider;
    // @ts-ignore
    this.statusCode = statusCode;
    // @ts-ignore
    this.originalError = originalError;
    // Structured error type from provider SDKs (e.g. Anthropic's "rate_limit_error")
    // @ts-ignore
    this.errorType = originalError?.type || null;
  }

  toJSON() {
    return {
      error: true,
      // @ts-ignore
      provider: this.provider,
      message: this.message,
      // @ts-ignore
      statusCode: this.statusCode,
      // @ts-ignore
      ...(this.errorType && { errorType: this.errorType }),
    };
  }
}

export function errorHandler(error: any, _req: any, res: any, _next: any) {
  logger.error(`${error.provider || "Server"}: ${error.message}`);

  if (error instanceof ProviderError) {
    // @ts-ignore
    return res.status(error.statusCode).json(error.toJSON());
  }

  return res.status(500).json({
    error: true,
    message: error.message || "Internal server error",
    statusCode: 500,
  });
}

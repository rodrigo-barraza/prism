export class ProviderError extends Error {
  constructor(provider, message, statusCode = 500, originalError = null) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.statusCode = statusCode;
    this.originalError = originalError;
    // Structured error type from provider SDKs (e.g. Anthropic's "rate_limit_error")
    this.errorType = originalError?.type || null;
  }

  toJSON() {
    return {
      error: true,
      provider: this.provider,
      message: this.message,
      statusCode: this.statusCode,
      ...(this.errorType && { errorType: this.errorType }),
    };
  }
}

export function errorHandler(err, _req, res, _next) {
  console.error(`[ERROR] ${err.provider || "Server"}:`, err.message);

  if (err instanceof ProviderError) {
    return res.status(err.statusCode).json(err.toJSON());
  }

  return res.status(500).json({
    error: true,
    message: err.message || "Internal server error",
    statusCode: 500,
  });
}

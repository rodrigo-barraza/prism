import { GATEWAY_SECRET } from '../../secrets.js';
import logger from '../utils/logger.js';

/**
 * Express middleware that validates the x-api-secret header
 * and attaches the x-project header to the request.
 */
export function authMiddleware(req, res, next) {
  const secret = req.headers['x-api-secret'];

  if (!secret || secret !== GATEWAY_SECRET) {
    logger.error(
      `Auth failed from ${req.ip} — ${req.method} ${req.originalUrl}`,
    );
    return res.status(401).json({
      error: true,
      message: 'Unauthorized — missing or invalid x-api-secret header',
      statusCode: 401,
    });
  }

  // Attach project identifier for downstream logging / tracking
  req.project = req.headers['x-project'] || 'unknown';

  next();
}

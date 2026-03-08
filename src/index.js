import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';

import { errorHandler } from './utils/errors.js';
import logger from './utils/logger.js';
import { listProviders } from './providers/index.js';
import { setupWebSocket } from './websocket/index.js';
import { authMiddleware } from './middleware/AuthMiddleware.js';
import { PORT, MONGO_URI, MONGO_DB_NAME } from '../secrets.js';
import MongoWrapper from './wrappers/MongoWrapper.js';

// Routes
import textToTextRouter from './routes/textToText.js';
import textToImageRouter from './routes/textToImage.js';
import imageToTextRouter from './routes/imageToText.js';
import textToSpeechRouter from './routes/textToSpeech.js';
import textToEmbeddingRouter from './routes/textToEmbedding.js';
import audioToTextRouter from './routes/audioToText.js';
import configRouter from './routes/config.js';
import conversationsRouter from './routes/conversations.js';
import adminRouter from './routes/admin.js';

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Endpoint registry (single source of truth for health check + startup logs)
const ENDPOINTS = {
  rest: [
    '/config',
    '/text-to-text',
    '/text-to-image',
    '/image-to-text',
    '/text-to-speech',
    '/text-to-embedding',
    '/audio-to-text',
    '/conversations',
  ],
  websocket: ['/text-to-text/stream', '/text-to-speech/stream'],
  admin: ['/admin', '/admin/lm-studio'],
};

// Health check (public — no auth required)
app.get('/', (_req, res) => {
  res.json({
    name: 'Prism the AI Gateway',
    version: '1.0.0',
    providers: listProviders(),
    endpoints: ENDPOINTS,
  });
});

// Admin routes (own auth via x-admin-secret)
app.use('/admin', adminRouter);

// Auth gate — everything below requires a valid x-api-secret header
app.use(authMiddleware);

// REST routes
app.use('/config', configRouter);
app.use('/text-to-text', textToTextRouter);
app.use('/text-to-image', textToImageRouter);
app.use('/image-to-text', imageToTextRouter);
app.use('/text-to-speech', textToSpeechRouter);
app.use('/text-to-embedding', textToEmbeddingRouter);
app.use('/audio-to-text', audioToTextRouter);
app.use('/conversations', conversationsRouter);

// Error handler (must be last)
app.use(errorHandler);

// WebSocket server
const wss = new WebSocketServer({ server });
setupWebSocket(wss);

// Start
(async () => {
  await MongoWrapper.createClient(MONGO_DB_NAME, MONGO_URI);

  server.listen(PORT, () => {
    logger.success(`Prism the AI Gateway is running on port ${PORT}`);
    logger.info('Available providers:', listProviders().join(', '));
    ENDPOINTS.rest.forEach((ep) =>
      logger.info(`  REST  →  http://localhost:${PORT}${ep}`),
    );
    ENDPOINTS.websocket.forEach((ep) =>
      logger.info(`  WS    →  ws://localhost:${PORT}${ep}`),
    );
  });
})();

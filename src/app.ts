import express from 'express';
import mongoose from 'mongoose';
import { httpLogger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { openapiRouter } from './openapi/routes.js';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(httpLogger);
  app.use(express.json());

  app.get('/api/v1/health', (_req, res) => {
    const dbState =
      mongoose.connection.readyState === mongoose.ConnectionStates.connected
        ? 'connected'
        : 'disconnected';
    res.status(dbState === 'connected' ? 200 : 503).json({ status: 'ok', db: dbState });
  });

  app.use('/api/v1', openapiRouter);
  app.use('/api/v1/auth', authRouter);
  // Further routers mount here as modules land: /api/v1/{users|customers|susu|savings|loans|reports}

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

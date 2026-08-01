import express from 'express';
import mongoose from 'mongoose';
import { httpLogger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { openapiRouter } from './openapi/routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { customersRouter } from './modules/customers/customers.routes.js';
import { susuRouter } from './modules/susu/susu.routes.js';
import { savingsRouter } from './modules/savings/savings.routes.js';
import { uploadsRouter } from './modules/uploads/uploads.routes.js';
import { loansRouter } from './modules/loans/loans.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';

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
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/customers', customersRouter);
  app.use('/api/v1/susu', susuRouter);
  app.use('/api/v1/savings', savingsRouter);
  app.use('/api/v1/uploads', uploadsRouter);
  app.use('/api/v1/loans', loansRouter);
  app.use('/api/v1/reports', reportsRouter);
  // Further routers mount here as modules land: /api/v1/{users|customers|susu|savings|loans|reports}

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

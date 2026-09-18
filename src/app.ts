import express from 'express';
import mongoose from 'mongoose';
import { httpLogger } from './lib/logger.js';
import { requestContext } from './lib/request-context.js';
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
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { collectorsRouter } from './modules/collectors/collectors.routes.js';
import { portalRouter } from './modules/portal/portal.routes.js';
import { payoutRequestsRouter } from './modules/portal/payout-requests.routes.js';
import { accountingRouter } from './modules/accounting/accounting.routes.js';
import { expensesRouter } from './modules/expenses/expenses.routes.js';
import { hpRouter } from './modules/hire-purchase/hp.routes.js';
import { transfersRouter } from './modules/transfers/transfers.routes.js';
import { reconciliationRouter } from './modules/reconciliation/reconciliation.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { paymentsRouter, paystackWebhookHandler } from './modules/payments/payments.routes.js';
import { correctionsRouter } from './modules/corrections/corrections.routes.js';
import { auditLogsRouter } from './modules/audit-logs/audit-logs.routes.js';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(httpLogger);
  // Right after the logger, which mints `req.id`: from here on every audit
  // entry knows the endpoint and the device it came through.
  app.use(requestContext);
  // The Paystack webhook signature covers the raw bytes, so this route must
  // see the body BEFORE the global JSON parser touches it.
  app.post(
    '/api/v1/payments/paystack/webhook',
    express.raw({ type: 'application/json' }),
    paystackWebhookHandler,
  );
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
  app.use('/api/v1/dashboard', dashboardRouter);
  app.use('/api/v1/collectors', collectorsRouter);
  app.use('/api/v1/portal', portalRouter);
  app.use('/api/v1/payout-requests', payoutRequestsRouter);
  app.use('/api/v1/accounting', accountingRouter);
  app.use('/api/v1/expenses', expensesRouter);
  app.use('/api/v1/hire-purchase', hpRouter);
  app.use('/api/v1/transfers', transfersRouter);
  app.use('/api/v1/reconciliation', reconciliationRouter);
  app.use('/api/v1/notifications', notificationsRouter);
  app.use('/api/v1/payments', paymentsRouter);
  app.use('/api/v1/corrections', correctionsRouter);
  app.use('/api/v1/audit-logs', auditLogsRouter);
  // Further routers mount here as modules land: /api/v1/{users|customers|susu|savings|loans|reports}

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

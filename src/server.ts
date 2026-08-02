import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { connectDb, disconnectDb } from './lib/db.js';
import { startSmsWorker } from './lib/sms.js';
import { startLoanEscalationWorker } from './lib/loan-escalation.js';
import { startHpArrearsWorker } from './lib/hp-arrears.js';
import { initRealtime } from './lib/realtime.js';
import { createApp } from './app.js';

const app = createApp();

await connectDb();
startSmsWorker();
startLoanEscalationWorker();
startHpArrearsWorker();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'yadah-microfinance-api listening');
});
initRealtime(server);

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    disconnectDb()
      .catch((err: unknown) => {
        logger.error({ err }, 'error during disconnect');
      })
      .finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});

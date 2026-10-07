import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { ensureChildPhoneRuleOnStart } from './lib/child-phones.js';
import { connectDb, disconnectDb } from './lib/db.js';
import { startSmsWorker } from './lib/sms.js';
import { initPush } from './lib/notifications.js';
import { startLoanEscalationWorker } from './lib/loan-escalation.js';
import { startHpArrearsWorker } from './lib/hp-arrears.js';
import { startDebtRecoveryWorker } from './lib/debt-recovery.js';
import { startLoanSavingsWorker } from './lib/loan-savings.js';
import { initRealtime } from './lib/realtime.js';
import { createApp } from './app.js';

const app = createApp();

await connectDb();
// Brings a database from before children could share a parent's number up to
// date — flags and the adults-only phone index. A no-op once it has been done.
await ensureChildPhoneRuleOnStart();
startSmsWorker();
initPush();
startLoanEscalationWorker();
startHpArrearsWorker();
startDebtRecoveryWorker();
startLoanSavingsWorker();

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

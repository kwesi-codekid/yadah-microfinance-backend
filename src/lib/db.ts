import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * SAFETY: the dev/staging Mongo server also hosts a PRODUCTION database.
 * Each environment may only ever connect to its own database. Do not remove
 * or weaken this guard.
 */
const ALLOWED_DB_BY_ENV: Record<typeof env.NODE_ENV, string | null> = {
  development: 'yadah-dev',
  test: 'yadah-test',
  staging: 'yadah-staging',
  production: null, // decided at deploy time
};

function assertAllowedDatabase(uri: string): string {
  const dbName = new URL(uri).pathname.replace(/^\//, '');
  if (dbName === '') {
    throw new Error('MONGO_URI must name a database explicitly (e.g. .../yadah-dev)');
  }
  const allowed = ALLOWED_DB_BY_ENV[env.NODE_ENV];
  if (allowed !== null && dbName !== allowed) {
    throw new Error(
      `Refusing to connect: NODE_ENV=${env.NODE_ENV} may only use database "${allowed}", ` +
        `but MONGO_URI targets "${dbName}". The server also hosts production data.`,
    );
  }
  return dbName;
}

export async function connectDb(): Promise<void> {
  const dbName = assertAllowedDatabase(env.MONGO_URI);

  mongoose.connection.on('disconnected', () => {
    logger.warn('mongodb disconnected');
  });
  mongoose.connection.on('reconnected', () => {
    logger.info('mongodb reconnected');
  });

  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 10_000 });
  logger.info({ dbName }, 'mongodb connected');
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

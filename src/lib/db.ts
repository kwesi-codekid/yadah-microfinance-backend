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

/**
 * Extract the database name from a Mongo connection string.
 *
 * `new URL()` cannot be used here: a replica-set URI lists several hosts
 * separated by commas (`mongodb://host1:27017,host2:27017/db`), which the
 * WHATWG parser rejects as an invalid port. Per the connection-string spec
 * anything special inside the credentials is percent-encoded, so the host
 * section is whatever follows the last `@`, and the database is the path
 * segment between the first `/` after it and the option string.
 */
export function databaseNameFromUri(uri: string): string {
  const scheme = /^mongodb(\+srv)?:\/\//i.exec(uri);
  if (scheme === null) {
    throw new Error('MONGO_URI must start with mongodb:// or mongodb+srv://');
  }
  const afterScheme = uri.slice(scheme[0].length);
  const authorityEnd = afterScheme.indexOf('/');
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  const credentialsEnd = authority.lastIndexOf('@');
  const hostsAndPath = credentialsEnd === -1 ? afterScheme : afterScheme.slice(credentialsEnd + 1);

  const pathStart = hostsAndPath.indexOf('/');
  if (pathStart === -1) {
    return '';
  }
  const path = hostsAndPath.slice(pathStart + 1);
  const dbName = path.split(/[?#]/, 1)[0] ?? '';
  return decodeURIComponent(dbName);
}

function assertAllowedDatabase(uri: string): string {
  const dbName = databaseNameFromUri(uri);
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

/**
 * Runs before any test file imports app code. Repoints MONGO_URI at the
 * yadah-test database on the same cluster — the db guard in src/lib/db.ts
 * requires exactly that name when NODE_ENV=test (vitest sets it), so a
 * misconfiguration fails loud instead of touching dev or prod data.
 */
import { config } from 'dotenv';

config();

const uri = process.env.MONGO_URI;
if (!uri) throw new Error('MONGO_URI missing — integration tests need the cluster URI');

const url = new URL(uri);
url.pathname = '/yadah-test';
process.env.MONGO_URI = url.toString();

// Backdating is off in production until the branch asks for it, but the suite
// has to be able to exercise it. The guard that refuses it when the flag is
// off is covered by src/lib/backdating.test.ts, which mocks the config.
process.env.ALLOW_BACKDATED_ENTRY = 'true';

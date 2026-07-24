/**
 * Seed: creates the initial admin user if none exists. Idempotent.
 * Credentials come from SEED_ADMIN_PHONE / SEED_ADMIN_PASSWORD env vars,
 * with dev-only defaults. Run: npx tsx src/scripts/seed.ts
 */
import bcrypt from 'bcrypt';
import { env } from '../config/env.js';
import { connectDb, disconnectDb } from '../lib/db.js';
import { UserModel } from '../models/index.js';
import { BCRYPT_COST } from '../modules/auth/auth.service.js';

const phone = process.env.SEED_ADMIN_PHONE ?? '0594213496';
const password = process.env.SEED_ADMIN_PASSWORD ?? 'admin-dev-password';

if (env.NODE_ENV === 'production' && !process.env.SEED_ADMIN_PASSWORD) {
  throw new Error('Refusing to seed production with the default password');
}

await connectDb();

const existing = await UserModel.findOne({ role: 'admin' });
if (existing) {
  console.log(`admin already exists (${existing.phone}) — nothing to do`);
} else {
  await UserModel.create({
    name: 'System Admin',
    phone,
    passwordHash: await bcrypt.hash(password, BCRYPT_COST),
    role: 'admin',
    status: 'active',
  });
  console.log(`admin created: ${phone}`);
}

await disconnectDb();

/**
 * Seed: creates the initial admin user if none exists (idempotent), and
 * backfills username/email on an admin created before those fields existed.
 * Credentials come from SEED_ADMIN_* env vars, with dev-only defaults.
 * Run: npx tsx src/scripts/seed.ts
 */
import bcrypt from 'bcrypt';
import { env } from '../config/env.js';
import { connectDb, disconnectDb } from '../lib/db.js';
import { UserModel } from '../models/index.js';
import { BCRYPT_COST } from '../modules/auth/auth.service.js';

const username = process.env.SEED_ADMIN_USERNAME ?? 'admin';
const phone = process.env.SEED_ADMIN_PHONE ?? '0594213496';
const email = process.env.SEED_ADMIN_EMAIL ?? 'kwasibordesjacob@gmail.com';
const password = process.env.SEED_ADMIN_PASSWORD ?? 'admin-dev-password';

if (env.NODE_ENV === 'production' && !process.env.SEED_ADMIN_PASSWORD) {
  throw new Error('Refusing to seed production with the default password');
}

await connectDb();

const existing = await UserModel.findOne({ role: 'admin' });
if (existing) {
  let changed = false;
  if (!existing.username) {
    existing.username = username;
    changed = true;
  }
  if (existing.email === undefined) {
    existing.email = email;
    changed = true;
  }
  if (changed) {
    await existing.save();
    console.log(`admin updated: username=${existing.username} email=${existing.email ?? ''}`);
  } else {
    console.log(`admin already exists (${existing.username}) — nothing to do`);
  }
} else {
  await UserModel.create({
    name: 'System Admin',
    username,
    phone,
    email,
    passwordHash: await bcrypt.hash(password, BCRYPT_COST),
    role: 'admin',
    status: 'active',
  });
  console.log(`admin created: username=${username} phone=${phone}`);
}

await disconnectDb();

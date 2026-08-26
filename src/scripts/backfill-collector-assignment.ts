/**
 * One-off backfill for the collector lock (client decision 2026-08-21).
 *
 * Customers registered before `assignedCollectorId` existed have no collector,
 * which under the new RBAC lock makes them invisible in the field. This assigns
 * every such customer to one named collector; an admin then redistributes them
 * with PATCH /customers/:id/collector or POST /customers/reassign-collector.
 *
 * Idempotent — only touches customers that have no collector yet.
 *
 * Run:  npx tsx src/scripts/backfill-collector-assignment.ts <collectorUserId>
 *       npx tsx src/scripts/backfill-collector-assignment.ts --list
 */
import { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../lib/db.js';
import { CustomerModel, UserModel } from '../models/index.js';
import { NOT_TRASHED } from '../models/shared.js';

const arg = process.argv[2];

await connectDb();

if (!arg || arg === '--list') {
  const collectors = await UserModel.find({ role: 'collector', status: 'active' }, { name: 1 });
  const unassigned = await CustomerModel.countDocuments({
    assignedCollectorId: null,
    ...NOT_TRASHED,
  });
  console.log(`unassigned customers: ${String(unassigned)}`);
  console.log('active collectors:');
  for (const c of collectors) console.log(`  ${c._id.toHexString()}  ${c.name}`);
  if (!arg) console.log('\nre-run with a collector id to assign them all.');
  await disconnectDb();
  process.exit(0);
}

if (!Types.ObjectId.isValid(arg)) {
  console.error(`not a valid user id: ${arg}`);
  await disconnectDb();
  process.exit(1);
}

const collectorId = new Types.ObjectId(arg);
const collector = await UserModel.findById(collectorId).select('name role status');
if (collector?.role !== 'collector' || collector.status !== 'active') {
  console.error('that user is not an active collector — run with --list to see the options');
  await disconnectDb();
  process.exit(1);
}

// `assignedCollectorId: null` matches both a missing field and an explicit null.
const result = await CustomerModel.updateMany(
  { assignedCollectorId: null, ...NOT_TRASHED },
  { $set: { assignedCollectorId: collectorId } },
);
console.log(`assigned ${String(result.modifiedCount)} customers to ${collector.name}`);

await CustomerModel.syncIndexes();
console.log('indexes synced');
await disconnectDb();

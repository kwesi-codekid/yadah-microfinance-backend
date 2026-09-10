/**
 * One-off purge of the eight profile fields the client dropped (10 Sep 2026):
 * email, mother's maiden name, GhanaPost GPS, postal address, ID expiry date,
 * ID place of issue, employer/business and purpose of account.
 *
 *   npx tsx src/scripts/purge-profile-fields.ts
 *
 * The schema no longer declares them, so nothing writes them any more and the
 * API no longer returns them — this removes what earlier registrations already
 * stored. Trashed customers are purged too: they are restorable, so leaving
 * their copies behind would bring the fields back.
 *
 * Idempotent. IRREVERSIBLE — the values are not archived anywhere first, so
 * take a database backup before running it (see docs/BACKUPS.md).
 *
 * Writes go through the raw collection rather than the model: Mongoose strips
 * paths its schema does not know, which is now all eight of them.
 */
import { connectDb, disconnectDb } from '../lib/db.js';
import { CustomerModel } from '../models/index.js';

const PURGED_PATHS = [
  'email',
  'mothersMaidenName',
  'ghanaPostGps',
  'postalAddress',
  'identification.idExpiryDate',
  'identification.idPlaceOfIssue',
  'employerOrBusiness',
  'purposeOfAccount',
] as const;

async function main(): Promise<void> {
  await connectDb();

  const carrying = { $or: PURGED_PATHS.map((path) => ({ [path]: { $exists: true } })) };
  const before = await CustomerModel.collection.countDocuments(carrying);
  console.log(`customers carrying at least one purged field: ${String(before)}`);

  if (before > 0) {
    const result = await CustomerModel.collection.updateMany(carrying, {
      $unset: Object.fromEntries(PURGED_PATHS.map((path) => [path, ''])),
    });
    console.log(`customers purged: ${String(result.modifiedCount)}`);
  }

  const left = await CustomerModel.collection.countDocuments(carrying);
  console.log(left === 0 ? 'none left' : `WARNING: ${String(left)} still carry a purged field`);

  await disconnectDb();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

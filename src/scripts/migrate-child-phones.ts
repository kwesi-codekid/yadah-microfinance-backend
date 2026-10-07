/**
 * Children sharing a parent's phone number (client decision, 5 Oct 2026),
 * by hand. The server already does this on every start (lib/child-phones.ts),
 * so a deploy needs nothing more; this is for looking first, or for bringing a
 * database up to date without starting the API against it.
 *
 *   npx tsx src/scripts/migrate-child-phones.ts            # dry run
 *   npx tsx src/scripts/migrate-child-phones.ts --apply
 *
 * Safe to run twice. Nothing about a customer changes except the flag.
 */
import { ensureChildPhoneRule, inspectChildPhones } from '../lib/child-phones.js';
import { connectDb, disconnectDb } from '../lib/db.js';
import { CustomerModel } from '../models/index.js';

const apply = process.argv.includes('--apply');

async function main(): Promise<void> {
  await connectDb();
  console.log(`database: ${CustomerModel.db.host}/${CustomerModel.db.name}`);

  if (!apply) {
    const state = await inspectChildPhones();
    console.log('dry run — pass --apply to write');
    console.log(`children: ${String(state.children)}, adults: ${String(state.adults)}`);
    console.log(state.oldIndex ? 'old index phone_1 present' : 'old index phone_1 already gone');
  } else {
    console.log('APPLYING');
    console.log(await ensureChildPhoneRule());
  }

  await disconnectDb();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

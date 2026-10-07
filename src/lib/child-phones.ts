import { CustomerModel } from '../models/index.js';
import { adultBornBy } from './age.js';
import { logger } from './logger.js';

/**
 * Children may share a parent's phone number; adults may not (client decision,
 * 5 Oct 2026). The database holds that as a unique index over adults only,
 * read off a stored `isMinor` flag. A database from before the change has
 * neither: `phone` is unique across everyone (`phone_1`) and nobody carries
 * the flag. This brings such a database up to date.
 *
 * Run on every start (see server.ts), so deploying the code is all it takes —
 * nobody has to remember a script. It is idempotent: on a database already up
 * to date it finds no flag to change and no old index to drop, and costs two
 * small queries. `src/scripts/migrate-child-phones.ts` runs the same thing by
 * hand, with a dry run.
 */

const OLD_INDEX = 'phone_1';

export interface ChildPhoneReport {
  children: number;
  adults: number;
  flaggedChildren: number;
  flaggedAdults: number;
  droppedOldIndex: boolean;
}

/** Who is under 18 today, and whether the old everyone-unique index is still there. */
export async function inspectChildPhones(): Promise<{
  children: number;
  adults: number;
  oldIndex: boolean;
}> {
  const { minors, adults } = filters();
  const [children, grownUps, indexes] = await Promise.all([
    CustomerModel.countDocuments(minors),
    CustomerModel.countDocuments(adults),
    CustomerModel.collection.indexes().catch(() => []),
  ]);
  return {
    children,
    adults: grownUps,
    oldIndex: indexes.some((i) => i.name === OLD_INDEX),
  };
}

export async function ensureChildPhoneRule(): Promise<ChildPhoneReport> {
  const { minors, adults } = filters();

  // Flags first, so the adults-only index has something to read the moment
  // it exists. Only records whose flag changes, and without touching
  // `updatedAt`: a flag nobody typed in is not an edit to the customer.
  const [setMinors, setAdults] = await Promise.all([
    CustomerModel.updateMany(
      { ...minors, isMinor: { $ne: true } },
      { $set: { isMinor: true } },
      { timestamps: false },
    ),
    CustomerModel.updateMany(
      { ...adults, isMinor: { $ne: false } },
      { $set: { isMinor: false } },
      { timestamps: false },
    ),
  ]);

  let droppedOldIndex = false;
  const indexes = await CustomerModel.collection.indexes().catch(() => []);
  if (indexes.some((i) => i.name === OLD_INDEX)) {
    try {
      await CustomerModel.collection.dropIndex(OLD_INDEX);
      droppedOldIndex = true;
    } catch (err) {
      // Another instance starting at the same moment got there first.
      if (!isIndexNotFound(err)) throw err;
    }
  }
  // Builds whatever the schema declares and the database lacks — the
  // adults-only phone index among them. Never drops anything.
  await CustomerModel.createIndexes();

  const [children, grownUps] = await Promise.all([
    CustomerModel.countDocuments(minors),
    CustomerModel.countDocuments(adults),
  ]);
  return {
    children,
    adults: grownUps,
    flaggedChildren: setMinors.modifiedCount,
    flaggedAdults: setAdults.modifiedCount,
    droppedOldIndex,
  };
}

/**
 * The start-up call: brings the database up to date and says so, but never
 * stops the server over it. A failure here leaves children unable to share a
 * number until the next start, which is far better than no service at all.
 */
export async function ensureChildPhoneRuleOnStart(): Promise<void> {
  try {
    const report = await ensureChildPhoneRule();
    const changed = report.flaggedChildren + report.flaggedAdults > 0 || report.droppedOldIndex;
    if (changed) logger.info(report, 'child phone rule: database brought up to date');
  } catch (err) {
    logger.error({ err }, 'child phone rule: could not bring the database up to date');
  }
}

/** Under 18 today: born after the cut. Everyone else, no date of birth included, is an adult. */
function filters() {
  const cut = adultBornBy();
  return {
    minors: { dateOfBirth: { $gt: cut } },
    adults: { $or: [{ dateOfBirth: null }, { dateOfBirth: { $lte: cut } }] },
  };
}

function isIndexNotFound(err: unknown): boolean {
  const e = err as { code?: number; codeName?: string };
  return e.code === 27 || e.codeName === 'IndexNotFound';
}

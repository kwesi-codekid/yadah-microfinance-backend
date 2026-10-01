import { Types } from 'mongoose';
import type { AccessTokenPayload } from '../modules/auth/auth.service.js';
import { AppError } from './errors.js';
import { audit } from './audit.js';
import type { AccountPrefix } from './account-number.js';
import { continueAccountNumbers } from '../scripts/continue-account-numbers.js';

/**
 * Bring this month's account numbers for one product into the continuing
 * sequence, from the office's screen (user request, 1 Oct 2026): every
 * account of that product opened this month under the monthly-restart rule is
 * renumbered, in opening order, to carry on from the highest number any
 * earlier month reached, and the product's counter is set so the next account
 * follows. A dry run reports what would change and writes nothing; `apply`
 * writes and leaves an audit entry. The other products are left as they are.
 * One run at a time across all products — the counters are shared ground.
 */

export interface RenumberReport {
  apply: boolean;
  /** Each account that was (or would be) renumbered, in opening order. */
  changes: { from: string; to: string }[];
  /** The product's counter after the run — the next account is this plus one. */
  counter: number;
}

const ENTITY: Record<AccountPrefix, { entityType: string; action: string }> = {
  SU: { entityType: 'susu-account', action: 'susu.account.renumber-month' },
  SV: { entityType: 'savings-account', action: 'savings.account.renumber-month' },
  LN: { entityType: 'loan', action: 'loan.renumber-month' },
  HP: { entityType: 'hp-agreement', action: 'hp.renumber-month' },
};

let running = false;

export async function renumberMonthFor(
  prefix: AccountPrefix,
  actor: AccessTokenPayload,
  apply: boolean,
  requestId?: string,
): Promise<RenumberReport> {
  if (running) throw new AppError('RENUMBER_RUNNING', 'The renumbering is already running', 409);
  running = true;
  try {
    const summary = await continueAccountNumbers(apply, new Date(), [], [prefix]);
    const product = summary.products[prefix] ?? { renumbered: 0, counter: 0, changes: [] };
    if (apply && product.changes.length > 0) {
      await audit({
        actorId: actor.sub,
        action: ENTITY[prefix].action,
        entityType: ENTITY[prefix].entityType,
        entityId: new Types.ObjectId(),
        after: { changes: product.changes, counter: product.counter },
        ...(requestId !== undefined ? { requestId } : {}),
      });
    }
    return { apply, changes: product.changes, counter: product.counter };
  } finally {
    running = false;
  }
}

import { Types } from 'mongoose';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { continueAccountNumbers } from '../../scripts/continue-account-numbers.js';

/**
 * Bring this month's savings numbers into the continuing sequence, from the
 * office's screen (user request, 1 Oct 2026): every savings account opened
 * this month under the monthly-restart rule is renumbered, in opening order,
 * to carry on from the highest number any earlier month reached, and the
 * savings counter is set so the next account follows. A dry run reports what
 * would change and writes nothing; `apply` writes and leaves an audit entry.
 * Savings only — the other products are left exactly as they are.
 */

export interface RenumberReport {
  apply: boolean;
  /** Each account that was (or would be) renumbered, in opening order. */
  changes: { from: string; to: string }[];
  /** The savings counter after the run — the next account is this plus one. */
  counter: number;
}

let running = false;

export async function renumberThisMonth(
  actor: AccessTokenPayload,
  apply: boolean,
  requestId?: string,
): Promise<RenumberReport> {
  if (running) throw new AppError('RENUMBER_RUNNING', 'The renumbering is already running', 409);
  running = true;
  try {
    const summary = await continueAccountNumbers(apply, new Date(), [], ['SV']);
    const sv = summary.products.SV ?? { renumbered: 0, counter: 0, changes: [] };
    if (apply && sv.changes.length > 0) {
      await audit({
        actorId: actor.sub,
        action: 'savings.account.renumber-month',
        entityType: 'savings-account',
        entityId: new Types.ObjectId(),
        after: { changes: sv.changes, counter: sv.counter },
        ...(requestId !== undefined ? { requestId } : {}),
      });
    }
    return { apply, changes: sv.changes, counter: sv.counter };
  } finally {
    running = false;
  }
}

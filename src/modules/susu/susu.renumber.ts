import type { AccessTokenPayload } from '../auth/auth.service.js';
import { renumberMonthFor, type RenumberReport } from '../../lib/renumber-month.js';

export type { RenumberReport };

/**
 * This month's susu numbers into the continuing sequence — see
 * lib/renumber-month. A susu number is also held on the customer, and the
 * script moves it along with the account.
 */
export function renumberThisMonth(
  actor: AccessTokenPayload,
  apply: boolean,
  requestId?: string,
): Promise<RenumberReport> {
  return renumberMonthFor('SU', actor, apply, requestId);
}

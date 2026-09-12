import type { ClientSession, Types } from 'mongoose';
import type { CorrectionKind } from '../models/index.js';
import type { AccessTokenPayload } from '../modules/auth/auth.service.js';

/**
 * The contract between the corrections module and the modules whose
 * transactions it corrects.
 *
 * A correction changes the amount on a transaction already on the ledger —
 * a susu deposit, a savings deposit or withdrawal, a loan repayment, a
 * hire-purchase instalment. What that does to the record behind it, and what
 * refuses it, is each module's own business: a susu deposit is a whole number
 * of days, a savings withdrawal has to leave the minimum balance, a repayment
 * cannot exceed what the loan still owes. So each module prepares its own
 * correction, and the corrections module runs it — outright for the office,
 * or after a teller asked and the office approved.
 *
 * `prepare` loads what the rules need and hands back three things: `plan`,
 * which checks an amount against the rules and throws a 422 when they refuse
 * it; `apply`, which writes the correction inside the caller's transaction so
 * it commits or rolls back with whatever else the caller writes; and `result`,
 * the public shapes after the change. Between preparing and applying the
 * record may move, which is why `apply` checks the rules again and guards its
 * writes on the figures it loaded.
 */

/**
 * Where a correction came from, when the office is applying a teller's
 * request rather than its own. Recorded on the audit entry so the ledger can
 * answer both "who changed this figure" (the approver) and "who asked".
 */
export interface CorrectionOrigin {
  correctionId: Types.ObjectId;
  requestedById: Types.ObjectId;
}

/** What a checked amount comes to, where the module counts in something other than money. */
export interface CorrectionPlan {
  /** Susu: the days the corrected amount covers. */
  units?: number;
}

export interface PreparedCorrection {
  kind: CorrectionKind;
  /** The record the transaction belongs to: an account, a loan, an agreement. */
  targetId: Types.ObjectId;
  txnId: Types.ObjectId;
  customerId: Types.ObjectId;
  /** The transaction's amount as it stands, pesewas. */
  amount: number;
  /** Susu: the days the amount covers as it stands. */
  units?: number;
  /** Refuses an amount the module's rules refuse, with a 422 that says why. */
  plan(amount: number): CorrectionPlan;
  /** Writes the correction inside the caller's transaction. Checks the rules again first. */
  apply(
    session: ClientSession,
    actor: AccessTokenPayload,
    amount: number,
    requestId: string | undefined,
    origin: CorrectionOrigin | undefined,
  ): Promise<void>;
  /** The record and the transaction as the API shows them, read fresh. */
  result(): Promise<{ target: unknown; txn: unknown }>;
}

export type CorrectionPreparer = (
  targetId: Types.ObjectId,
  txnId: Types.ObjectId,
) => Promise<PreparedCorrection>;

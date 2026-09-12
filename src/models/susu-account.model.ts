import { Schema, model, type Types } from 'mongoose';
import {
  accountNumberPattern,
  CYCLE_MONTHS,
  LEGACY_SUSU_PATTERN,
  type CycleMonth,
} from '../lib/account-number.js';
import { moneyField, optionalMoneyField, trashFields, type TrashFields } from './shared.js';

/**
 * One account = one cycle of 31 deposits at a fixed daily amount.
 * dailyAmount is IMMUTABLE after opening — changing it means close + reopen.
 * The cycle ends at 31 recorded deposits, however long that takes.
 */
export interface SusuAccount extends TrashFields {
  _id: Types.ObjectId;
  /**
   * The CUSTOMER's susu number plus this cycle's month, e.g. SU26090005-SEP.
   *
   * Deliberately NOT unique (client decision, 12 Sep 2026): a customer is
   * assigned one number for life and their books are separated by month inside
   * it, exactly as the manual passbooks work, so two books opened for one
   * customer in one month carry the same string byte for byte. The unique
   * identifier is `_id`; `accountRef` renders it for people.
   *
   * Accounts opened before the scheme keep their legacy 6 digits as their
   * owner's stem, and take the month suffix like any other.
   */
  accountNumber: string;
  /**
   * What THIS account was originally issued, before its number was collapsed
   * onto its owner's. Set by the migration only, and only where the two
   * differ — nothing issues a per-account number any more.
   *
   * It exists so that a receipt already printed, or a number a customer quotes
   * from an old slip, still finds the right book. Never displayed.
   */
  issuedNumber?: string;
  /**
   * The month this cycle is *called*, which the counter picks when opening
   * and which need not be the month the number was issued in — a cycle
   * started on 28 August for a customer who thinks of it as September is
   * opened as SEP. Immutable, like dailyAmount: it is printed on the
   * customer's receipt the moment the account exists.
   *
   * Absent on every account opened before the suffix existed.
   */
  cycleMonth?: CycleMonth;
  customerId: Types.ObjectId;
  dailyAmount: number; // pesewas, immutable
  depositsCount: number; // 0..31, denormalized from susu-deposits
  /** Running total paid IN over the cycle. Never decreases — not the balance. */
  totalDeposited: number; // pesewas, denormalized
  /**
   * Total taken out by partial withdrawals while the account stayed open
   * (client decision 2026-08-21 — a withdrawal no longer forces closure).
   * balance = totalDeposited − withdrawnAmount; the cycle is unaffected,
   * since days already paid stay paid.
   */
  withdrawnAmount: number; // pesewas
  /**
   * pending-payout: stopped, commission taken, value awaiting disbursement.
   * terminated: refunded in full with no commission — only reachable while
   * deposits could not cover the one-day commission.
   */
  status: 'active' | 'completed' | 'pending-payout' | 'closed' | 'terminated';
  openedById: Types.ObjectId;
  /**
   * Set when this account exists because a payment overflowed the cycle of
   * another one — the customer handed over more than the old cycle could hold,
   * and the remainder had to go somewhere.
   */
  carriedFromAccountId?: Types.ObjectId;
  closedById?: Types.ObjectId;
  closedAt?: Date;
  /** Set when the account stops: payout = totalDeposited − commission (1 × dailyAmount). */
  commissionAmount?: number;
  payoutAmount?: number;
  /** Undisbursed value (pending-payout accounts); 0 once fully paid out. */
  payoutRemaining: number;
  createdAt: Date;
  updatedAt: Date;
}

const susuAccountSchema = new Schema<SusuAccount>(
  {
    accountNumber: {
      type: String,
      required: true,
      // No `unique` — see the field's doc. Indexed below all the same: both
      // account-number lookups are anchored regexes and one sits inside an
      // `$or`, where an unindexed branch drags the whole query to a scan.
      // Built from the shared pattern so the suffix rule is stated once.
      match: new RegExp(
        `(?:${accountNumberPattern('SU').source})|(?:${LEGACY_SUSU_PATTERN.source})`,
      ),
    },
    // Written once, by the migration, with updateOne — so it cannot be
    // `immutable` (mongoose would strip the write). Nothing else touches it.
    issuedNumber: { type: String },
    cycleMonth: { type: String, enum: CYCLE_MONTHS, immutable: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    dailyAmount: { ...moneyField, immutable: true },
    depositsCount: { type: Number, default: 0, min: 0, max: 31 },
    totalDeposited: { ...moneyField, default: 0 },
    withdrawnAmount: { ...moneyField, default: 0 },
    status: {
      type: String,
      enum: ['active', 'completed', 'pending-payout', 'closed', 'terminated'],
      default: 'active',
    },
    openedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    carriedFromAccountId: { type: Schema.Types.ObjectId, ref: 'SusuAccount' },
    closedById: { type: Schema.Types.ObjectId, ref: 'User' },
    closedAt: { type: Date },
    commissionAmount: optionalMoneyField,
    payoutAmount: optionalMoneyField,
    payoutRemaining: { ...moneyField, default: 0 },
    ...trashFields,
  },
  { timestamps: true },
);

susuAccountSchema.index({ customerId: 1, status: 1 });
susuAccountSchema.index({ accountNumber: 1 });
// What a customer quotes off an old receipt. Sparse: only accounts the
// migration collapsed carry one.
susuAccountSchema.index({ issuedNumber: 1 }, { sparse: true });

export const SusuAccountModel = model<SusuAccount>(
  'SusuAccount',
  susuAccountSchema,
  'susu-accounts',
);

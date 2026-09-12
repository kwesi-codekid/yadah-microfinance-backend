import { Schema, model, type Types } from 'mongoose';
import { moneyField } from './shared.js';

/**
 * A teller's proposed correction to a susu deposit, waiting on the office.
 *
 * The office corrects a deposit directly (PATCH on the deposit). A teller may
 * not: correcting a figure already on the ledger is a decision, and deciding is
 * not the counter's job. What the counter may do is ASK — this record is the
 * asking. Nothing on the ledger moves until somebody in the office approves
 * it, and approval runs the very same correction the office would have made
 * by hand, so every rule that guards a direct correction (newest deposit
 * only, a whole number of days, within the cycle) guards this one too, at the
 * moment it is applied rather than the moment it was asked for.
 *
 * `amountBefore` is a snapshot of what the deposit said when the teller asked.
 * The office reads the change as the teller saw it; if the deposit has moved
 * since, applying the request fails on the ledger's rules and the request
 * stays open for a decision rather than silently applying to the wrong figure.
 *
 * Status meaning:
 *   pending   — asked, not yet decided
 *   approved  — the correction was APPLIED to the deposit
 *   rejected  — declined by the office; the deposit is untouched
 *   cancelled — withdrawn by whoever asked, before a decision
 */

export const CORRECTION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

export interface SusuDepositCorrection {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  depositId: Types.ObjectId;
  customerId: Types.ObjectId;

  /** The deposit's amount when the correction was asked for, pesewas. */
  amountBefore: number;
  /** The amount asked for, pesewas — a multiple of the account's daily amount. */
  amount: number;
  /** Days covered before and after, derived from the two amounts. */
  daysBefore: number;
  days: number;
  /** Why, in the teller's words. The office decides on this line. */
  reason: string;

  status: CorrectionStatus;
  requestedById: Types.ObjectId;
  reviewedById?: Types.ObjectId;
  reviewedAt?: Date;
  rejectionReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

const susuDepositCorrectionSchema = new Schema<SusuDepositCorrection>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'SusuAccount', required: true },
    depositId: { type: Schema.Types.ObjectId, ref: 'SusuDeposit', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    amountBefore: moneyField,
    amount: moneyField,
    daysBefore: { type: Number, required: true, min: 0 },
    days: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true, trim: true, maxlength: 300 },
    status: { type: String, enum: CORRECTION_STATUSES, default: 'pending' },
    requestedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewedById: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    rejectionReason: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true },
);

// The queue, an account's own requests, and a teller's own — the three reads.
susuDepositCorrectionSchema.index({ status: 1, createdAt: -1 });
susuDepositCorrectionSchema.index({ accountId: 1, createdAt: -1 });
susuDepositCorrectionSchema.index({ requestedById: 1, createdAt: -1 });
// One open request per deposit: two tellers cannot queue two different
// figures against the same entry and have the office approve both.
susuDepositCorrectionSchema.index(
  { depositId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);

export const SusuDepositCorrectionModel = model<SusuDepositCorrection>(
  'SusuDepositCorrection',
  susuDepositCorrectionSchema,
  'susu-deposit-corrections',
);

import { Schema, model, type Types } from 'mongoose';
import { moneyField } from './shared.js';

/**
 * A teller's proposed correction to a transaction's amount, waiting on the
 * office.
 *
 * The office corrects a transaction directly (PATCH on the transaction). A
 * teller may not: correcting a figure already on the ledger is a decision, and
 * deciding is not the counter's job. What the counter may do is ASK — this
 * record is the asking. Nothing on the ledger moves until somebody in the
 * office approves it, and approval runs the very same correction the office
 * would have made by hand, so every rule that guards a direct correction
 * guards this one too, at the moment it is applied rather than the moment it
 * was asked for.
 *
 * One record for every kind of transaction that can be corrected — a susu
 * deposit, a savings deposit or withdrawal, a loan repayment, a hire-purchase
 * instalment — because the asking and the deciding are the same whatever the
 * figure is on. What differs is what the correction does to the record behind
 * it, and that lives in each module (see lib/corrections.ts).
 *
 * `amountBefore` is a snapshot of what the transaction said when the teller
 * asked. The office reads the change as the teller saw it; if the figure has
 * moved since, applying the request fails on the ledger's rules and the
 * request stays open for a decision rather than silently applying to the
 * wrong figure.
 *
 * Status meaning:
 *   pending   — asked, not yet decided
 *   approved  — the correction was APPLIED to the transaction
 *   rejected  — declined by the office; the transaction is untouched
 *   cancelled — withdrawn by whoever asked, before a decision
 */

export const CORRECTION_KINDS = [
  'susu-deposit',
  'savings-txn',
  'loan-repayment',
  'hp-payment',
] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

export const CORRECTION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

export interface TxnCorrection {
  _id: Types.ObjectId;
  kind: CorrectionKind;
  /** The record the transaction belongs to: a susu or savings account, a loan, an agreement. */
  targetId: Types.ObjectId;
  /** The transaction itself: a deposit, a savings txn, a repayment, a payment. */
  txnId: Types.ObjectId;
  customerId: Types.ObjectId;

  /** The transaction's amount when the correction was asked for, pesewas. */
  amountBefore: number;
  /** The amount asked for, pesewas. */
  amount: number;
  /** Susu only: the days covered before and after, derived from the two amounts. */
  unitsBefore?: number;
  units?: number;
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

const txnCorrectionSchema = new Schema<TxnCorrection>(
  {
    kind: { type: String, enum: CORRECTION_KINDS, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    txnId: { type: Schema.Types.ObjectId, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    amountBefore: moneyField,
    amount: moneyField,
    unitsBefore: { type: Number, min: 0 },
    units: { type: Number, min: 1 },
    reason: { type: String, required: true, trim: true, maxlength: 300 },
    status: { type: String, enum: CORRECTION_STATUSES, default: 'pending' },
    requestedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewedById: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    rejectionReason: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true },
);

// The queue, a record's own requests, and a teller's own — the three reads.
txnCorrectionSchema.index({ status: 1, createdAt: -1 });
txnCorrectionSchema.index({ targetId: 1, createdAt: -1 });
txnCorrectionSchema.index({ requestedById: 1, createdAt: -1 });
// One open request per transaction: two tellers cannot queue two different
// figures against the same entry and have the office approve both.
txnCorrectionSchema.index(
  { txnId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);

export const TxnCorrectionModel = model<TxnCorrection>(
  'TxnCorrection',
  txnCorrectionSchema,
  'txn-corrections',
);

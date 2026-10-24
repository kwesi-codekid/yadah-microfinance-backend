import { Schema, model, type Types } from 'mongoose';
import { CHANNELS, moneyField, trashFields, type Channel, type TrashFields } from './shared.js';

/**
 * Where a repayment's money came from — cash, the customer's susu balance,
 * their susu loan account, or an internal transfer. 'susu-closure' and
 * 'loan-savings' (the account susu loan replaced, 23 Oct 2026) are
 * history.
 */
export const REPAYMENT_SOURCES = [
  'cash',
  'susu',
  'susu-closure',
  'transfer',
  'loan-savings',
  'susu-loan',
] as const;
export type RepaymentSource = (typeof REPAYMENT_SOURCES)[number];

/**
 * A repayment against a loan. Trashed only together with its loan, when a
 * disbursed loan is deleted: the books then read as if it was never paid.
 */
export interface Repayment extends TrashFields {
  _id: Types.ObjectId;
  loanId: Types.ObjectId;
  customerId: Types.ObjectId;
  amount: number; // pesewas
  source: RepaymentSource;
  channel: Channel;
  /** Set when source is susu (or susu-closure): the account the money came from. */
  susuAccountId?: Types.ObjectId;
  /** Set when source is loan-savings (history): the loan savings account it came from. */
  savingsAccountId?: Types.ObjectId;
  /** Set when source is susu-loan: the susu loan account it came from. */
  susuLoanAccountId?: Types.ObjectId;
  recordedById: Types.ObjectId;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const repaymentSchema = new Schema<Repayment>(
  {
    loanId: { type: Schema.Types.ObjectId, ref: 'Loan', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    amount: moneyField,
    source: { type: String, enum: REPAYMENT_SOURCES, required: true },
    channel: { type: String, enum: CHANNELS, default: 'cash' },
    susuAccountId: { type: Schema.Types.ObjectId, ref: 'SusuAccount' },
    savingsAccountId: { type: Schema.Types.ObjectId, ref: 'SavingsAccount' },
    susuLoanAccountId: { type: Schema.Types.ObjectId, ref: 'SusuLoanAccount' },
    recordedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    idempotencyKey: { type: String },
    ...trashFields,
  },
  { timestamps: true },
);

repaymentSchema.index({ loanId: 1, createdAt: -1 });
repaymentSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const RepaymentModel = model<Repayment>('Repayment', repaymentSchema, 'repayments');

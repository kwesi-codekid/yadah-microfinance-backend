import { Schema, model, type Types } from 'mongoose';
import { CHANNELS, moneyField, type Channel } from './shared.js';

/**
 * A repayment against a loan — cash, money taken from the customer's susu
 * balance, or an internal transfer. 'susu-closure' is history: repayments
 * made when paying from susu meant closing the book.
 */
export interface Repayment {
  _id: Types.ObjectId;
  loanId: Types.ObjectId;
  customerId: Types.ObjectId;
  amount: number; // pesewas
  source: 'cash' | 'susu' | 'susu-closure' | 'transfer';
  channel: Channel;
  /** Set when source is susu (or susu-closure): the account the money came from. */
  susuAccountId?: Types.ObjectId;
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
    source: { type: String, enum: ['cash', 'susu', 'susu-closure', 'transfer'], required: true },
    channel: { type: String, enum: CHANNELS, default: 'cash' },
    susuAccountId: { type: Schema.Types.ObjectId, ref: 'SusuAccount' },
    recordedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    idempotencyKey: { type: String },
  },
  { timestamps: true },
);

repaymentSchema.index({ loanId: 1, createdAt: -1 });
repaymentSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const RepaymentModel = model<Repayment>('Repayment', repaymentSchema, 'repayments');

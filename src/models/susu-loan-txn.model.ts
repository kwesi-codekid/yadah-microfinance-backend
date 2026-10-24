import { Schema, model, type Types } from 'mongoose';
import { CHANNELS, moneyField, trashFields, type Channel, type TrashFields } from './shared.js';

/**
 * Every movement on a susu loan account:
 *   deposit   — money paid in (cash at the office, or carried over from loan
 *               savings when the account was converted)
 *   repayment — money taken to repay the customer's loan (`loanId`)
 *   leftover  — what was left once a loan was paid off, moved to the
 *               customer's savings (`savingsAccountId`, `loanId`)
 *   refund    — a repayment put back because its loan, or the repayment
 *               itself, was deleted (`loanId`)
 * Only a deposit moves cash; the rest are transfer legs (`channel:
 * 'transfer'`), kept out of the cash totals.
 */
export const SUSU_LOAN_TXN_TYPES = ['deposit', 'repayment', 'leftover', 'refund'] as const;
export type SusuLoanTxnType = (typeof SUSU_LOAN_TXN_TYPES)[number];

export interface SusuLoanTxn extends TrashFields {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  customerId: Types.ObjectId;
  type: SusuLoanTxnType;
  amount: number; // pesewas
  balanceAfter: number; // pesewas
  channel: Channel;
  loanId?: Types.ObjectId;
  savingsAccountId?: Types.ObjectId;
  /** Accra calendar day (YYYY-MM-DD). */
  accraDay: string;
  recordedById: Types.ObjectId;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const susuLoanTxnSchema = new Schema<SusuLoanTxn>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'SusuLoanAccount', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    type: { type: String, enum: SUSU_LOAN_TXN_TYPES, required: true },
    amount: moneyField,
    balanceAfter: moneyField,
    channel: { type: String, enum: CHANNELS, default: 'cash' },
    loanId: { type: Schema.Types.ObjectId, ref: 'Loan' },
    savingsAccountId: { type: Schema.Types.ObjectId, ref: 'SavingsAccount' },
    accraDay: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    recordedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    idempotencyKey: { type: String },
    ...trashFields,
  },
  { timestamps: true },
);

susuLoanTxnSchema.index({ accountId: 1, createdAt: -1 });
susuLoanTxnSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const SusuLoanTxnModel = model<SusuLoanTxn>(
  'SusuLoanTxn',
  susuLoanTxnSchema,
  'susu-loan-txns',
);

import { Schema, model, type Types } from 'mongoose';
import { accountNumberPattern } from '../lib/account-number.js';
import { moneyField, trashFields, type TrashFields } from './shared.js';

/**
 * A customer's susu loan account (client decision, 23 Oct 2026) — the
 * passbook they pay into to settle their loan. It replaces the loan savings
 * account and sits with susu, but none of the susu rules apply: no plans, no
 * cycles, no commission, nothing locked. Any amount may be paid in at any
 * time, at the office only; nothing is ever withdrawn. Money leaves it only
 * to repay the customer's loan — on the loan's monthly dates by itself
 * (lib/susu-loan.ts), or by hand — and, once a loan is paid off, what is
 * left moves to the customer's savings.
 *
 * One per customer, kept across loans: a new loan is only given once the old
 * one is settled, and the next one is paid from the same book.
 */
export interface SusuLoanAccount extends TrashFields {
  _id: Types.ObjectId;
  /** `SL` + YYMM + sequence, e.g. SL26100001 — the product's own run. */
  accountNumber: string;
  customerId: Types.ObjectId;
  balance: number; // pesewas
  status: 'active' | 'closed';
  openedById: Types.ObjectId;
  closedById?: Types.ObjectId;
  closedAt?: Date;
  /** Set on an account converted from a loan savings account: that account's id. */
  migratedFromSavingsId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const susuLoanAccountSchema = new Schema<SusuLoanAccount>(
  {
    accountNumber: { type: String, required: true, match: accountNumberPattern('SL') },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    balance: { ...moneyField, default: 0 },
    status: { type: String, enum: ['active', 'closed'], default: 'active' },
    openedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    closedById: { type: Schema.Types.ObjectId, ref: 'User' },
    closedAt: { type: Date },
    migratedFromSavingsId: { type: Schema.Types.ObjectId, ref: 'SavingsAccount' },
    ...trashFields,
  },
  { timestamps: true },
);

// One open account per customer. Closed and trashed ones are outside the rule,
// so a customer who closed theirs can open again.
susuLoanAccountSchema.index(
  { customerId: 1 },
  { unique: true, partialFilterExpression: { status: 'active', deletedAt: null } },
);
susuLoanAccountSchema.index(
  { accountNumber: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
susuLoanAccountSchema.index({ status: 1, createdAt: -1 });

export const SusuLoanAccountModel = model<SusuLoanAccount>(
  'SusuLoanAccount',
  susuLoanAccountSchema,
  'susu-loan-accounts',
);

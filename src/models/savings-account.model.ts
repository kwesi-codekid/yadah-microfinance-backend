import { Schema, model, type Types } from 'mongoose';
import { moneyField, trashFields, type TrashFields } from './shared.js';

/**
 * Rules: min deposit GHS 5 · no interest · max 1 withdrawal per Accra day ·
 * flat GHS 10 fee per withdrawal (also on closure) · min balance GHS 10
 * withdrawable only on closure. availableToWithdraw = balance − 5000 − 1000
 * is computed in the service layer, never stored.
 */
/**
 * `loan` is the loan savings account (client decision, 6 Oct 2026): one per
 * customer, paid into like any savings account, but money leaves it only to
 * repay the customer's loan — by hand, or by the automatic deduction on the loan's monthly dates. No
 * withdrawal, no fee, no minimum balance.
 */
export const SAVINGS_ACCOUNT_TYPES = ['standard', 'student', 'fixed', 'loan'] as const;
export type SavingsAccountType = (typeof SAVINGS_ACCOUNT_TYPES)[number];

export interface SavingsAccount extends TrashFields {
  _id: Types.ObjectId;
  /** `SV` + YYMM + 4-digit monthly sequence, e.g. SV26080001. Accounts opened
   *  before the scheme keep their legacy 10 random digits. */
  accountNumber: string;
  customerId: Types.ObjectId;
  /**
   * Label only (client decision 2026-08-06): student accounts follow IDENTICAL
   * money rules. Holder is the minor; the guardian's ID goes on the customer's
   * identification fields. A customer may hold both types at once.
   */
  accountType: SavingsAccountType;
  /**
   * Fixed deposits only (client decision, 6 Oct 2026). The Accra day,
   * `YYYY-MM-DD`, from which withdrawals are free — at least six months after
   * opening (see domain/savings.ts). Absent on every other type.
   */
  maturesOn?: string;
  /** Fixed deposits only: the term chosen at opening, in months (6 or more). */
  termMonths?: number;
  /**
   * Fixed deposits only. The holder is a child; this is the adult customer —
   * the parent — who opened it for them and the only one paid out of it.
   */
  guardianId?: Types.ObjectId;
  balance: number; // pesewas
  status: 'active' | 'closed';
  openedById: Types.ObjectId;
  closedById?: Types.ObjectId;
  closedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const savingsAccountSchema = new Schema<SavingsAccount>(
  {
    accountNumber: {
      type: String,
      required: true,
      unique: true,
      match: /^(SV\d{8,}|\d{10})$/,
    },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    accountType: { type: String, enum: SAVINGS_ACCOUNT_TYPES, default: 'standard' },
    maturesOn: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    termMonths: { type: Number, min: 1 },
    guardianId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    balance: { ...moneyField, default: 0 },
    status: { type: String, enum: ['active', 'closed'], default: 'active' },
    openedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    closedById: { type: Schema.Types.ObjectId, ref: 'User' },
    closedAt: { type: Date },
    ...trashFields,
  },
  { timestamps: true },
);

savingsAccountSchema.index({ customerId: 1, status: 1 });
// A parent's page lists the fixed deposits they stand guardian to.
savingsAccountSchema.index({ guardianId: 1 }, { sparse: true });

export const SavingsAccountModel = model<SavingsAccount>(
  'SavingsAccount',
  savingsAccountSchema,
  'savings-accounts',
);

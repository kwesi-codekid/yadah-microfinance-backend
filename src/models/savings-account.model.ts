import { Schema, model, type Types } from 'mongoose';
import { moneyField, trashFields, type TrashFields } from './shared.js';

/**
 * Rules: min deposit GHS 5 · no interest · max 1 withdrawal per Accra day ·
 * flat GHS 10 fee per withdrawal (also on closure) · min balance GHS 50
 * withdrawable only on closure. availableToWithdraw = balance − 5000 − 1000
 * is computed in the service layer, never stored.
 */
export const SAVINGS_ACCOUNT_TYPES = ['standard', 'student'] as const;
export type SavingsAccountType = (typeof SAVINGS_ACCOUNT_TYPES)[number];

export interface SavingsAccount extends TrashFields {
  _id: Types.ObjectId;
  /** 10-digit randomized account number, unique across savings accounts. */
  accountNumber: string;
  customerId: Types.ObjectId;
  /**
   * Label only (client decision 2026-08-06): student accounts follow IDENTICAL
   * money rules. Holder is the minor; the guardian's ID goes on the customer's
   * identification fields. A customer may hold both types at once.
   */
  accountType: SavingsAccountType;
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
    accountNumber: { type: String, required: true, unique: true, match: /^\d{10}$/ },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    accountType: { type: String, enum: SAVINGS_ACCOUNT_TYPES, default: 'standard' },
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

export const SavingsAccountModel = model<SavingsAccount>(
  'SavingsAccount',
  savingsAccountSchema,
  'savings-accounts',
);

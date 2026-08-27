import { Schema, model, type Types } from 'mongoose';
import { moneyField, trashFields, type TrashFields } from './shared.js';

/**
 * Where Yadah's own money sits: the office drawer, a bank account, a mobile
 * money wallet, the Paystack balance.
 *
 * These are the company's accounts, NOT customers' — a customer's susu or
 * savings balance is a liability owed back to them and lives on their own
 * account documents.
 *
 * Balances are DERIVED, never stored: opening balance plus every movement on
 * this account's channel, less expenses and asset purchases paid from it (see
 * cash.service.ts). That keeps one source of truth and means a missed write
 * can never leave a stored balance silently wrong.
 */

export const CASH_ACCOUNT_KINDS = ['cash-on-hand', 'bank', 'momo', 'paystack'] as const;
export type CashAccountKind = (typeof CASH_ACCOUNT_KINDS)[number];

export interface CashAccount extends TrashFields {
  _id: Types.ObjectId;
  name: string;
  kind: CashAccountKind;
  /**
   * Which transaction channel lands here. Customer money moves already carry a
   * channel, so an account claims its share of them rather than needing every
   * existing money path to post to it.
   *
   * At most one account per channel may be active — otherwise a deposit would
   * belong to two accounts at once.
   */
  channel: 'cash' | 'paystack' | 'momo';
  /** What the account held on openingDate, before any tracked movement. */
  openingBalance: number;
  /** Movements before this date belong to the opening figure, not on top of it. */
  openingDate: Date;
  bankName?: string;
  accountNumber?: string;
  status: 'active' | 'closed';
  createdById: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const cashAccountSchema = new Schema<CashAccount>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    kind: { type: String, enum: CASH_ACCOUNT_KINDS, required: true },
    channel: { type: String, enum: ['cash', 'paystack', 'momo'], required: true },
    openingBalance: moneyField,
    openingDate: { type: Date, required: true },
    bankName: { type: String, trim: true, maxlength: 120 },
    accountNumber: { type: String, trim: true, maxlength: 40 },
    status: { type: String, enum: ['active', 'closed'], default: 'active' },
    createdById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ...trashFields,
  },
  { timestamps: true },
);

// One active account per channel: two would each claim the same movements.
cashAccountSchema.index(
  { channel: 1 },
  { unique: true, partialFilterExpression: { status: 'active', deletedAt: null } },
);

export const CashAccountModel = model<CashAccount>(
  'CashAccount',
  cashAccountSchema,
  'cash-accounts',
);

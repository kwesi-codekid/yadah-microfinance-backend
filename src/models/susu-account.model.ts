import { Schema, model, type Types } from 'mongoose';
import { accountNumberPattern, LEGACY_SUSU_PATTERN } from '../lib/account-number.js';
import { moneyField, optionalMoneyField, trashFields, type TrashFields } from './shared.js';

/**
 * A customer's ONE susu account (client decision, 30 Sep 2026): a balance,
 * like savings, holding one or more plans that run their own 31-payment
 * cycles side by side. It opens once and closes only when the customer
 * leaves — nothing about a cycle ever opens or closes an account.
 *
 * The cycles live on the plans (susu-plan.model.ts) and their history on
 * susu-cycle.model.ts. Money rules are in domain/susu-plans.ts.
 */
export interface SusuAccount extends TrashFields {
  _id: Types.ObjectId;
  /**
   * The customer's susu number, e.g. SU26090005 — one per customer, for
   * life. Accounts from before the scheme keep their legacy 6 digits.
   */
  accountNumber: string;
  customerId: Types.ObjectId;
  /**
   * What the account holds, pesewas. Deposits add to it net of any commission
   * they trigger; withdrawals, plan stops and closure take from it. Part of
   * it is locked while cycles are in progress — see lockedAmount().
   */
  balance: number;
  status: 'active' | 'closed';
  openedById: Types.ObjectId;
  closedById?: Types.ObjectId;
  closedAt?: Date;
  /** Set at closure: commission charged for the cycles still in progress. */
  closeCommission?: number;
  /** Set at closure: balance − closeCommission, what was paid out. */
  closePayout?: number;
  createdAt: Date;
  updatedAt: Date;
}

const susuAccountSchema = new Schema<SusuAccount>(
  {
    accountNumber: {
      type: String,
      required: true,
      match: new RegExp(
        `(?:${accountNumberPattern('SU').source})|(?:${LEGACY_SUSU_PATTERN.source})`,
      ),
    },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    balance: { ...moneyField, default: 0 },
    status: { type: String, enum: ['active', 'closed'], default: 'active' },
    openedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    closedById: { type: Schema.Types.ObjectId, ref: 'User' },
    closedAt: { type: Date },
    closeCommission: optionalMoneyField,
    closePayout: optionalMoneyField,
    ...trashFields,
  },
  { timestamps: true },
);

// One live account per customer. The trash is outside the rule so a trashed
// (never used) account does not block opening the real one.
susuAccountSchema.index(
  { customerId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
susuAccountSchema.index(
  { accountNumber: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
susuAccountSchema.index({ status: 1, createdAt: -1 });

export const SusuAccountModel = model<SusuAccount>(
  'SusuAccount',
  susuAccountSchema,
  'susu-accounts',
);

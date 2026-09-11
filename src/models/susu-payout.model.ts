import { Schema, model, type Types } from 'mongoose';
import { moneyField, optionalMoneyField } from './shared.js';

/**
 * One disbursement of a susu account's value: cash at the office, or an
 * internal move (savings credit, loan/HP payment via transfers).
 *
 * These rows are never trashed and never edited — there is deliberately no
 * correction path, unlike deposits. A payout is money that left the drawer;
 * the way to undo one is another movement, not a rewrite.
 */
export interface SusuPayout {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  customerId: Types.ObjectId;
  amount: number; // pesewas
  /**
   * 'payout' ends the account's life (closure or staged disbursement);
   * 'partial-withdrawal' takes money from an account that stays open.
   */
  kind: 'payout' | 'partial-withdrawal';
  destination: 'cash' | 'savings' | 'loan' | 'hire-purchase';
  /** The credited record on the other side, when internal. */
  destinationId?: Types.ObjectId;
  /**
   * The one-day commission charged as the account stopped, in pesewas.
   *
   * Carried here rather than read off the account because an account can be
   * stopped once and then paid out in several instalments: the commission
   * belongs to the instalment that stopped it and to no other, or the ledger
   * would charge it again on every disbursement. Zero on a partial
   * withdrawal, on a termination, and on every follow-on instalment.
   */
  commissionAmount?: number;
  recordedById: Types.ObjectId;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const susuPayoutSchema = new Schema<SusuPayout>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'SusuAccount', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    amount: moneyField,
    kind: { type: String, enum: ['payout', 'partial-withdrawal'], default: 'payout' },
    destination: {
      type: String,
      enum: ['cash', 'savings', 'loan', 'hire-purchase'],
      required: true,
    },
    destinationId: { type: Schema.Types.ObjectId },
    commissionAmount: optionalMoneyField,
    recordedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    idempotencyKey: { type: String },
  },
  { timestamps: true },
);

susuPayoutSchema.index({ accountId: 1, createdAt: -1 });
susuPayoutSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const SusuPayoutModel = model<SusuPayout>('SusuPayout', susuPayoutSchema, 'susu-payouts');

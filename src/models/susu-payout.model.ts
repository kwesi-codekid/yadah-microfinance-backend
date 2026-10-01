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
export interface SusuPayoutLine {
  planId: Types.ObjectId;
  /** The plan's amount at the time, so the days this cost can be read back. */
  dailyAmount: number;
  amount: number;
  /** Whole payments this share took off the plan's cycle in progress. */
  paymentsRemoved: number;
}

export interface SusuPayout {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  customerId: Types.ObjectId;
  amount: number; // pesewas
  /**
   * 'withdrawal' takes money from an account that stays open; 'payout' is
   * the closing disbursement that ends the account's life.
   */
  kind: 'payout' | 'withdrawal';
  /**
   * How a withdrawal was spread over the plans: the money walks them in
   * order, each giving what it holds less its lock, and each share takes
   * whole payments off that plan's cycle. The balance stays one figure on the
   * account; these are the per-plan figures the account page shows. Absent
   * on closing payouts and on withdrawals made before plans. The part of the
   * amount on no line came from the account's loose money.
   */
  lines?: SusuPayoutLine[];
  destination: 'cash' | 'savings' | 'loan' | 'hire-purchase';
  /** The credited record on the other side, when internal. */
  destinationId?: Types.ObjectId;
  /**
   * Commission charged as the account closed — one payment's amount for every
   * plan whose cycle was still in progress — in pesewas. Zero on a
   * withdrawal: commission is taken as cycles complete, never on money out.
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
    kind: { type: String, enum: ['payout', 'withdrawal'], default: 'payout' },
    lines: {
      type: [
        new Schema<SusuPayoutLine>(
          {
            planId: { type: Schema.Types.ObjectId, ref: 'SusuPlan', required: true },
            dailyAmount: moneyField,
            amount: moneyField,
            paymentsRemoved: { type: Number, min: 0, required: true },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
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

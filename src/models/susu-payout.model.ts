import { Schema, model, type Types } from 'mongoose';
import { moneyField } from './shared.js';

/**
 * One disbursement of a susu account's value: cash at the office, or an
 * internal move (savings credit, loan/HP payment via transfers).
 */
export interface SusuPayout {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  customerId: Types.ObjectId;
  amount: number; // pesewas
  destination: 'cash' | 'savings' | 'loan' | 'hire-purchase';
  /** The credited record on the other side, when internal. */
  destinationId?: Types.ObjectId;
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
    destination: {
      type: String,
      enum: ['cash', 'savings', 'loan', 'hire-purchase'],
      required: true,
    },
    destinationId: { type: Schema.Types.ObjectId },
    recordedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    idempotencyKey: { type: String },
  },
  { timestamps: true },
);

susuPayoutSchema.index({ accountId: 1, createdAt: -1 });
susuPayoutSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const SusuPayoutModel = model<SusuPayout>('SusuPayout', susuPayoutSchema, 'susu-payouts');

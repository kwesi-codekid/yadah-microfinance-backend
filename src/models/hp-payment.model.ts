import { Schema, model, type Types } from 'mongoose';
import { CHANNELS, moneyField, type Channel } from './shared.js';

/** Money received against an HP agreement. The deposit is the first one. */
export interface HpPayment {
  _id: Types.ObjectId;
  agreementId: Types.ObjectId;
  customerId: Types.ObjectId;
  type: 'deposit' | 'installment' | 'redemption';
  amount: number; // pesewas
  channel: Channel;
  recordedById: Types.ObjectId;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const hpPaymentSchema = new Schema<HpPayment>(
  {
    agreementId: { type: Schema.Types.ObjectId, ref: 'HpAgreement', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    type: { type: String, enum: ['deposit', 'installment', 'redemption'], required: true },
    amount: moneyField,
    channel: { type: String, enum: CHANNELS, default: 'cash' },
    recordedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    idempotencyKey: { type: String },
  },
  { timestamps: true },
);

hpPaymentSchema.index({ agreementId: 1, createdAt: -1 });
hpPaymentSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const HpPaymentModel = model<HpPayment>('HpPayment', hpPaymentSchema, 'hp-payments');

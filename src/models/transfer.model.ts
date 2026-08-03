import { Schema, model, type Types } from 'mongoose';
import { moneyField } from './shared.js';

/**
 * One internal transfer between a customer's accounts (client-requested):
 * susu → savings/loan/HP · savings → susu/loan/HP. Each side keeps its own
 * money rules; this document is the cross-reference tying them together.
 */
export interface Transfer {
  _id: Types.ObjectId;
  customerId: Types.ObjectId;
  fromType: 'susu' | 'savings';
  fromId: Types.ObjectId;
  toType: 'susu' | 'savings' | 'loan' | 'hire-purchase';
  toId: Types.ObjectId;
  /** What left the source (fee excluded). */
  amountMoved: number;
  /** Savings-side withdrawal fee, when the source is savings. */
  fee: number;
  /** What the destination received (≤ amountMoved when excess stayed behind). */
  amountCredited: number;
  /** Susu-source remainder left pending withdrawal. */
  excessPending: number;
  recordedById: Types.ObjectId;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const transferSchema = new Schema<Transfer>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    fromType: { type: String, enum: ['susu', 'savings'], required: true },
    fromId: { type: Schema.Types.ObjectId, required: true },
    toType: { type: String, enum: ['susu', 'savings', 'loan', 'hire-purchase'], required: true },
    toId: { type: Schema.Types.ObjectId, required: true },
    amountMoved: moneyField,
    fee: { ...moneyField, default: 0 },
    amountCredited: moneyField,
    excessPending: { ...moneyField, default: 0 },
    recordedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    idempotencyKey: { type: String },
  },
  { timestamps: true },
);

transferSchema.index({ customerId: 1, createdAt: -1 });
transferSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const TransferModel = model<Transfer>('Transfer', transferSchema, 'transfers');

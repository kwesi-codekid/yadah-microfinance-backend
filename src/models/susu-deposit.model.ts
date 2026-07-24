import { Schema, model, type Types } from 'mongoose';
import { CHANNELS, moneyField, type Channel } from './shared.js';

/**
 * One recorded collection against one account. A catch-up payment covers
 * several missed days in one document: amount = dailyAmount × daysCovered.
 * seqStart/seqEnd are the 1-based positions in the 31-deposit cycle.
 */
export interface SusuDeposit {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  customerId: Types.ObjectId;
  collectorId: Types.ObjectId;
  amount: number; // pesewas
  daysCovered: number;
  seqStart: number; // 1..31
  seqEnd: number; // 1..31
  channel: Channel;
  /** Groups deposits recorded by one collect-all transaction. */
  collectAllBatchId?: Types.ObjectId;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const susuDepositSchema = new Schema<SusuDeposit>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'SusuAccount', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    collectorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amount: moneyField,
    daysCovered: { type: Number, required: true, min: 1, max: 31 },
    seqStart: { type: Number, required: true, min: 1, max: 31 },
    seqEnd: { type: Number, required: true, min: 1, max: 31 },
    channel: { type: String, enum: CHANNELS, default: 'cash' },
    collectAllBatchId: { type: Schema.Types.ObjectId },
    idempotencyKey: { type: String },
  },
  { timestamps: true },
);

susuDepositSchema.index({ accountId: 1, createdAt: -1 });
susuDepositSchema.index({ collectorId: 1, createdAt: -1 });
susuDepositSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const SusuDepositModel = model<SusuDeposit>(
  'SusuDeposit',
  susuDepositSchema,
  'susu-deposits',
);

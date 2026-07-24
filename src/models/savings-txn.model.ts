import { Schema, model, type Types } from 'mongoose';
import { CHANNELS, moneyField, optionalMoneyField, type Channel } from './shared.js';

export interface SavingsTxn {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  customerId: Types.ObjectId;
  type: 'deposit' | 'withdrawal' | 'closure';
  amount: number; // pesewas; for withdrawals, the amount handed to the customer
  fee?: number; // pesewas; GHS 10 flat on withdrawals/closure
  balanceAfter: number; // pesewas
  channel: Channel;
  /** Accra calendar day (YYYY-MM-DD) — backs the 1-withdrawal-per-day rule. */
  accraDay: string;
  recordedById: Types.ObjectId;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const savingsTxnSchema = new Schema<SavingsTxn>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'SavingsAccount', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    type: { type: String, enum: ['deposit', 'withdrawal', 'closure'], required: true },
    amount: moneyField,
    fee: optionalMoneyField,
    balanceAfter: moneyField,
    channel: { type: String, enum: CHANNELS, default: 'cash' },
    accraDay: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    recordedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    idempotencyKey: { type: String },
  },
  { timestamps: true },
);

savingsTxnSchema.index({ accountId: 1, createdAt: -1 });
savingsTxnSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
// One withdrawal (or closure) per account per Accra day, enforced at the index level too.
savingsTxnSchema.index(
  { accountId: 1, accraDay: 1 },
  { unique: true, partialFilterExpression: { type: { $in: ['withdrawal', 'closure'] } } },
);

export const SavingsTxnModel = model<SavingsTxn>('SavingsTxn', savingsTxnSchema, 'savings-txns');

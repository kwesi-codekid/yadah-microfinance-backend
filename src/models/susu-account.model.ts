import { Schema, model, type Types } from 'mongoose';
import { moneyField, optionalMoneyField } from './shared.js';

/**
 * One account = one cycle of 31 deposits at a fixed daily amount.
 * dailyAmount is IMMUTABLE after opening — changing it means close + reopen.
 * The cycle ends at 31 recorded deposits, however long that takes.
 */
export interface SusuAccount {
  _id: Types.ObjectId;
  /** 6-digit randomized account number, unique across susu accounts. */
  accountNumber: string;
  customerId: Types.ObjectId;
  dailyAmount: number; // pesewas, immutable
  depositsCount: number; // 0..31, denormalized from susu-deposits
  totalDeposited: number; // pesewas, denormalized
  status: 'active' | 'completed' | 'closed';
  openedById: Types.ObjectId;
  closedById?: Types.ObjectId;
  closedAt?: Date;
  /** Set at closure: payout = totalDeposited − commission (1 × dailyAmount). */
  commissionAmount?: number;
  payoutAmount?: number;
  createdAt: Date;
  updatedAt: Date;
}

const susuAccountSchema = new Schema<SusuAccount>(
  {
    accountNumber: { type: String, required: true, unique: true, match: /^\d{6}$/ },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    dailyAmount: { ...moneyField, immutable: true },
    depositsCount: { type: Number, default: 0, min: 0, max: 31 },
    totalDeposited: { ...moneyField, default: 0 },
    status: { type: String, enum: ['active', 'completed', 'closed'], default: 'active' },
    openedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    closedById: { type: Schema.Types.ObjectId, ref: 'User' },
    closedAt: { type: Date },
    commissionAmount: optionalMoneyField,
    payoutAmount: optionalMoneyField,
  },
  { timestamps: true },
);

susuAccountSchema.index({ customerId: 1, status: 1 });

export const SusuAccountModel = model<SusuAccount>(
  'SusuAccount',
  susuAccountSchema,
  'susu-accounts',
);

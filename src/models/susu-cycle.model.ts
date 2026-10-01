import { Schema, model, type Types } from 'mongoose';
import { moneyField } from './shared.js';

/**
 * One ended cycle of one plan — the history the statement groups by and the
 * commission report sums. Written once, when the cycle ends; the cycle in
 * progress lives on the plan itself (paidInCycle), so there is never a
 * half-written row to keep in step with it.
 */
export interface SusuCycle {
  _id: Types.ObjectId;
  planId: Types.ObjectId;
  accountId: Types.ObjectId;
  customerId: Types.ObjectId;
  /** 1-based within the plan. */
  cycleNumber: number;
  /** The plan's amount during this cycle — it may change afterwards. */
  dailyAmount: number;
  /** 31 when completed; fewer when the plan or account stopped mid-cycle. */
  payments: number;
  /** One payment's amount — the commission this cycle earned. */
  commissionAmount: number;
  endReason: 'completed' | 'plan-stopped' | 'account-closed';
  endedAt: Date;
  /** The deposit whose 31st payment completed it; absent on a stop. */
  completedByDepositId?: Types.ObjectId;
  /** Who stopped the plan or closed the account; absent when completed by a deposit. */
  endedById?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const susuCycleSchema = new Schema<SusuCycle>(
  {
    planId: { type: Schema.Types.ObjectId, ref: 'SusuPlan', required: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'SusuAccount', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    cycleNumber: { type: Number, required: true, min: 1 },
    dailyAmount: moneyField,
    payments: { type: Number, required: true, min: 1, max: 31 },
    commissionAmount: moneyField,
    endReason: {
      type: String,
      enum: ['completed', 'plan-stopped', 'account-closed'],
      required: true,
    },
    endedAt: { type: Date, required: true },
    completedByDepositId: { type: Schema.Types.ObjectId, ref: 'SusuDeposit' },
    endedById: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

// A plan's cycle ends exactly once.
susuCycleSchema.index({ planId: 1, cycleNumber: 1 }, { unique: true });
susuCycleSchema.index({ accountId: 1, endedAt: -1 });
// The commission report reads by date.
susuCycleSchema.index({ endedAt: -1 });

export const SusuCycleModel = model<SusuCycle>('SusuCycle', susuCycleSchema, 'susu-cycles');

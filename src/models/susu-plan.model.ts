import { Schema, model, type Types } from 'mongoose';
import { moneyField, optionalMoneyField } from './shared.js';

/**
 * One daily-amount commitment inside a customer's single susu account
 * (client decision, 30 Sep 2026). An account runs one or more plans side by
 * side; each counts its own cycles of 31 payments, never dates.
 *
 * The balance lives on the account, not here — a plan only tracks where its
 * current cycle stands, which is all the commission and the lock need. Money
 * rules are in domain/susu-plans.ts.
 */
export interface SusuPlan {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  customerId: Types.ObjectId;
  /**
   * Pesewas. Changeable, but only between cycles (paidInCycle = 0): mid-cycle
   * the answer is stop and start a new plan. Commission is one of these.
   */
  dailyAmount: number;
  /**
   * Payments in the current cycle, 0..30. The 31st completes the cycle,
   * takes the commission and resets this to 0 — so 31 never rests here.
   */
  paidInCycle: number;
  /** Finished cycles; the current cycle's number is this + 1. */
  cyclesCompleted: number;
  status: 'active' | 'stopped';
  startedById: Types.ObjectId;
  stoppedById?: Types.ObjectId;
  stoppedAt?: Date;
  /** Charged when stopped mid-cycle; 0 when stopped between cycles. */
  stopCommission?: number;
  createdAt: Date;
  updatedAt: Date;
}

const susuPlanSchema = new Schema<SusuPlan>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'SusuAccount', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    dailyAmount: moneyField,
    paidInCycle: { type: Number, default: 0, min: 0, max: 30 },
    cyclesCompleted: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ['active', 'stopped'], default: 'active' },
    startedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    stoppedById: { type: Schema.Types.ObjectId, ref: 'User' },
    stoppedAt: { type: Date },
    stopCommission: optionalMoneyField,
  },
  { timestamps: true },
);

susuPlanSchema.index({ accountId: 1, status: 1 });
susuPlanSchema.index({ customerId: 1 });

export const SusuPlanModel = model<SusuPlan>('SusuPlan', susuPlanSchema, 'susu-plans');

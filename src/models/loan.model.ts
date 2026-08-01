import { Schema, model, type Types } from 'mongoose';
import { moneyField } from './shared.js';

/**
 * Tiers: small 1,000–20,000 · big 20,001–50,000 (GHS, stored as pesewas).
 * Flat interest on principal by duration: 3m=10% · 6m=20% · 12m=30%.
 * Escalation past due date: next rate applied to ORIGINAL PRINCIPAL;
 * past 30% the amount freezes and the loan is flagged in arrears.
 * One active loan per customer — enforced in the service layer, no exceptions.
 */
export interface Loan {
  _id: Types.ObjectId;
  customerId: Types.ObjectId;
  tier: 'small' | 'big';
  principal: number; // pesewas, never changes
  durationMonths: 3 | 6 | 12;
  ratePercent: number; // current rate: 10 | 20 | 30 (moves on escalation)
  interestAmount: number; // pesewas, recomputed from principal on escalation
  totalDue: number; // pesewas: principal + interestAmount
  totalRepaid: number; // pesewas, denormalized from repayments
  status: 'pending' | 'approved' | 'rejected' | 'active' | 'repaid' | 'arrears';
  frozen: boolean; // true once escalation is exhausted (past 30%)
  appliedAt: Date;
  approvedById?: Types.ObjectId;
  approvedAt?: Date;
  disbursedAt?: Date;
  dueDate?: Date; // disbursedAt + durationMonths
  escalatedAt?: Date;
  closedAt?: Date;
  /** Repaid on time → unlocks the big tier (graduation rule). */
  repaidOnTime?: boolean;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const loanSchema = new Schema<Loan>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    tier: { type: String, enum: ['small', 'big'], required: true },
    principal: { ...moneyField, immutable: true },
    durationMonths: { type: Number, enum: [3, 6, 12], required: true },
    ratePercent: { type: Number, enum: [10, 20, 30], required: true },
    interestAmount: moneyField,
    totalDue: moneyField,
    totalRepaid: { ...moneyField, default: 0 },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'active', 'repaid', 'arrears'],
      default: 'pending',
    },
    frozen: { type: Boolean, default: false },
    appliedAt: { type: Date, required: true },
    approvedById: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    disbursedAt: { type: Date },
    dueDate: { type: Date },
    escalatedAt: { type: Date },
    closedAt: { type: Date },
    repaidOnTime: { type: Boolean },
    rejectionReason: { type: String, trim: true },
  },
  { timestamps: true },
);

loanSchema.index({ customerId: 1, status: 1 });
loanSchema.index({ status: 1, dueDate: 1 }); // overdue cron scans

export const LoanModel = model<Loan>('Loan', loanSchema, 'loans');

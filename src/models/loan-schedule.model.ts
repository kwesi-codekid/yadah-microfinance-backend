import { Schema, model, type Types } from 'mongoose';
import { moneyField } from './shared.js';

/** One monthly instalment of a loan's repayment schedule. */
export interface LoanSchedule {
  _id: Types.ObjectId;
  loanId: Types.ObjectId;
  customerId: Types.ObjectId;
  installmentNumber: number; // 1..durationMonths
  dueDate: Date;
  amountDue: number; // pesewas
  amountPaid: number; // pesewas
  status: 'pending' | 'partial' | 'paid' | 'overdue';
  createdAt: Date;
  updatedAt: Date;
}

const loanScheduleSchema = new Schema<LoanSchedule>(
  {
    loanId: { type: Schema.Types.ObjectId, ref: 'Loan', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    installmentNumber: { type: Number, required: true, min: 1 },
    dueDate: { type: Date, required: true },
    amountDue: moneyField,
    amountPaid: { ...moneyField, default: 0 },
    status: { type: String, enum: ['pending', 'partial', 'paid', 'overdue'], default: 'pending' },
  },
  { timestamps: true },
);

loanScheduleSchema.index({ loanId: 1, installmentNumber: 1 }, { unique: true });
loanScheduleSchema.index({ status: 1, dueDate: 1 });

export const LoanScheduleModel = model<LoanSchedule>(
  'LoanSchedule',
  loanScheduleSchema,
  'loan-schedules',
);

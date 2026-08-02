import { Schema, model, type Types } from 'mongoose';
import { moneyField } from './shared.js';

/** One monthly instalment of an HP agreement's repayment plan. */
export interface HpSchedule {
  _id: Types.ObjectId;
  agreementId: Types.ObjectId;
  customerId: Types.ObjectId;
  installmentNumber: number;
  dueDate: Date;
  amountDue: number; // pesewas
  amountPaid: number; // pesewas
  status: 'pending' | 'partial' | 'paid';
  createdAt: Date;
  updatedAt: Date;
}

const hpScheduleSchema = new Schema<HpSchedule>(
  {
    agreementId: { type: Schema.Types.ObjectId, ref: 'HpAgreement', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    installmentNumber: { type: Number, required: true, min: 1 },
    dueDate: { type: Date, required: true },
    amountDue: moneyField,
    amountPaid: { ...moneyField, default: 0 },
    status: { type: String, enum: ['pending', 'partial', 'paid'], default: 'pending' },
  },
  { timestamps: true },
);

hpScheduleSchema.index({ agreementId: 1, installmentNumber: 1 }, { unique: true });
hpScheduleSchema.index({ status: 1, dueDate: 1 }); // arrears worker scans

export const HpScheduleModel = model<HpSchedule>('HpSchedule', hpScheduleSchema, 'hp-schedules');

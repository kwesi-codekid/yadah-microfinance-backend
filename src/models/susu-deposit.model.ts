import { Schema, model, type Types } from 'mongoose';
import { CHANNELS, moneyField, trashFields, type Channel, type TrashFields } from './shared.js';

/**
 * One stretch of a deposit inside one cycle of one plan. A deposit paying
 * several plans has a line per plan; one that runs a plan past its 31st
 * payment has two lines for that plan, the second opening the next cycle.
 */
export interface SusuDepositLine {
  planId: Types.ObjectId;
  /** The plan's amount at the time, so the line stays readable if it changes. */
  dailyAmount: number;
  /** 1-based within the plan. */
  cycleNumber: number;
  payments: number;
  /** 1-based positions within the cycle, 1..31. */
  seqStart: number;
  seqEnd: number;
  /** payments × dailyAmount. */
  amount: number;
  /** One payment's amount when this line landed the 31st payment; else 0. */
  commissionAmount: number;
}

/**
 * One recorded collection against a customer's susu account. The cash is
 * `amount`; `lines` say how it was credited to the plans, and `leftover` is
 * whatever did not make a whole payment — it stays in the balance and counts
 * toward no plan. balance moves by amount − commissionAmount.
 */
export interface SusuDeposit extends TrashFields {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  customerId: Types.ObjectId;
  collectorId: Types.ObjectId;
  amount: number; // pesewas, the cash handed over
  lines: SusuDepositLine[];
  leftover: number;
  /** Σ lines.commissionAmount — taken out of this deposit as cycles completed. */
  commissionAmount: number;
  channel: Channel;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const lineSchema = new Schema<SusuDepositLine>(
  {
    planId: { type: Schema.Types.ObjectId, ref: 'SusuPlan', required: true },
    dailyAmount: moneyField,
    cycleNumber: { type: Number, required: true, min: 1 },
    payments: { type: Number, required: true, min: 1, max: 31 },
    seqStart: { type: Number, required: true, min: 1, max: 31 },
    seqEnd: { type: Number, required: true, min: 1, max: 31 },
    amount: moneyField,
    commissionAmount: { ...moneyField, default: 0 },
  },
  { _id: false },
);

const susuDepositSchema = new Schema<SusuDeposit>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'SusuAccount', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    collectorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amount: moneyField,
    lines: { type: [lineSchema], required: true },
    leftover: { ...moneyField, default: 0 },
    commissionAmount: { ...moneyField, default: 0 },
    channel: { type: String, enum: CHANNELS, default: 'cash' },
    idempotencyKey: { type: String },
    ...trashFields,
  },
  { timestamps: true },
);

susuDepositSchema.index({ accountId: 1, createdAt: -1 });
susuDepositSchema.index({ customerId: 1, createdAt: -1 });
susuDepositSchema.index({ collectorId: 1, createdAt: -1 });
susuDepositSchema.index({ 'lines.planId': 1, createdAt: -1 });
susuDepositSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const SusuDepositModel = model<SusuDeposit>(
  'SusuDeposit',
  susuDepositSchema,
  'susu-deposits',
);

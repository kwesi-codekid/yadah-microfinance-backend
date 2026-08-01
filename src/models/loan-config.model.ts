import { Schema, model, type Types } from 'mongoose';
import { moneyField } from './shared.js';

/**
 * Singleton (one document) — admin-editable loan parameters (WBS 5.1).
 * Defaults live in domain/loans.ts; a saved doc overrides them for NEW
 * applications/approvals. Rates on running loans never change except via
 * the escalation ladder.
 */
export interface LoanConfig {
  _id: Types.ObjectId;
  ratePercent3: number;
  ratePercent6: number;
  ratePercent12: number;
  smallMinPesewas: number;
  smallMaxPesewas: number;
  bigMaxPesewas: number;
  updatedById?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const loanConfigSchema = new Schema<LoanConfig>(
  {
    ratePercent3: { type: Number, required: true, min: 1, max: 100 },
    ratePercent6: { type: Number, required: true, min: 1, max: 100 },
    ratePercent12: { type: Number, required: true, min: 1, max: 100 },
    smallMinPesewas: moneyField,
    smallMaxPesewas: moneyField,
    bigMaxPesewas: moneyField,
    updatedById: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const LoanConfigModel = model<LoanConfig>('LoanConfig', loanConfigSchema, 'loan-config');

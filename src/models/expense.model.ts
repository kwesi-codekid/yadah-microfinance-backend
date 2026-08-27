import { Schema, model, type Types } from 'mongoose';
import { moneyField, trashFields, type TrashFields } from './shared.js';

/**
 * Money the business spends on itself.
 *
 * Lifecycle: recorded → approved (or rejected) → paid. Only a PAID expense
 * reduces a cash account; an approved-but-unpaid one is a liability on the
 * balance sheet, which is what keeps the cash position honest.
 *
 * Depreciation is deliberately NOT an expense category here — it is computed
 * straight-line from the fixed-asset register, so there is nothing to record
 * and no monthly run that could be missed (see fixed-asset.model.ts).
 */

export const EXPENSE_CATEGORIES = [
  /** Wages, allowances, collector commissions, SSNIT and statutory contributions. */
  'salaries-staff',
  /** Stationery, cleaning, refreshments, minor repairs — usually from a float. */
  'petty-cash-office',
  /** Electricity, water, internet and airtime, rent, security. */
  'utilities-premises',
  /** Bank charges, Paystack and SMS gateway fees, fuel and transport, anything else. */
  'fees-transport-other',
  /** Loans or HP written off, plus the cost of chasing them. */
  'bad-debt-recovery',
  /** Audit, legal, regulatory returns and licences, corporate and withholding tax. */
  'professional-compliance-tax',
  /** Radio, flyers, branded materials, promotions, referral incentives. */
  'marketing',
  /** Vehicle, premises, cash-in-transit, and any credit or life cover. */
  'insurance',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_STATUSES = ['pending', 'approved', 'rejected', 'paid'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export interface Expense extends TrashFields {
  _id: Types.ObjectId;
  category: ExpenseCategory;
  /** What it was for, in plain words — this is what shows on the report. */
  description: string;
  amount: number;
  /** Who was paid. Free text: most payees are not records in this system. */
  payee?: string;
  /**
   * The Accra day the cost belongs to, which is not always the day it was
   * paid — August salaries paid in September are an August cost.
   */
  incurredOn: string;
  status: ExpenseStatus;

  /** Which company account it was paid from. Set at payment, not before. */
  cashAccountId?: Types.ObjectId;
  paidOn?: string;
  paidById?: Types.ObjectId;

  recordedById: Types.ObjectId;
  approvedById?: Types.ObjectId;
  approvedAt?: Date;
  rejectionReason?: string;

  /** Uploaded receipt or invoice image. */
  receiptUrl?: string;
  reference?: string;

  /**
   * Set when the expense is a loan or HP write-off, so the balance sheet can
   * tie the charge back to the record it wrote down.
   */
  writeOffEntityType?: 'loan' | 'hp-agreement';
  writeOffEntityId?: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const expenseSchema = new Schema<Expense>(
  {
    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    description: { type: String, required: true, trim: true, maxlength: 300 },
    amount: moneyField,
    payee: { type: String, trim: true, maxlength: 160 },
    incurredOn: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: { type: String, enum: EXPENSE_STATUSES, default: 'pending' },
    cashAccountId: { type: Schema.Types.ObjectId, ref: 'CashAccount' },
    paidOn: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    paidById: { type: Schema.Types.ObjectId, ref: 'User' },
    recordedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    approvedById: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    rejectionReason: { type: String, maxlength: 300 },
    receiptUrl: { type: String },
    reference: { type: String, trim: true, maxlength: 80 },
    writeOffEntityType: { type: String, enum: ['loan', 'hp-agreement'] },
    writeOffEntityId: { type: Schema.Types.ObjectId },
    ...trashFields,
  },
  { timestamps: true },
);

expenseSchema.index({ incurredOn: -1 });
expenseSchema.index({ status: 1, incurredOn: -1 });
expenseSchema.index({ category: 1, incurredOn: -1 });
expenseSchema.index({ cashAccountId: 1, paidOn: -1 });

export const ExpenseModel = model<Expense>('Expense', expenseSchema, 'expenses');

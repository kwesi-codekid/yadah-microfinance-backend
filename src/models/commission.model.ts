import { Schema, model, type Types } from 'mongoose';
import { moneyField } from './shared.js';

/** What Yadah earned it on (client decision, 7 Oct 2026). */
export const COMMISSION_SOURCES = ['susu', 'savings-fee', 'loan-fee'] as const;
export type CommissionSource = (typeof COMMISSION_SOURCES)[number];

export const COMMISSION_REASONS = [
  /** Susu: the plan's 31st payment landed — taken automatically. */
  'cycle-completed',
  /** Susu: the customer took everything out; each cycle in progress gave one payment. */
  'withdraw-all',
  /** Susu: a plan stopped mid-cycle. */
  'plan-stopped',
  /** Susu: the account closed with the cycle still in progress. */
  'account-closed',
  /** Savings: the flat fee on a withdrawal (cash, or a transfer out). */
  'savings-withdrawal',
  /** Savings: the flat fee on the closing payout. */
  'savings-closure',
  /** Loans: the processing fee paid the day the loan went out. */
  'loan-disbursed',
] as const;
export type CommissionReason = (typeof COMMISSION_REASONS)[number];

/** The company cash channels — where the money physically sits. */
export const COMMISSION_CHANNELS = ['cash', 'paystack', 'momo'] as const;
export type CommissionChannel = (typeof COMMISSION_CHANNELS)[number];

/**
 * Yadah's commission account (client decisions, 7 Oct 2026): one entry per
 * commission or fee the company keeps — susu commission, the savings
 * withdrawal fee, the loan processing fee. Once here the money is Yadah's.
 *
 * The cash itself already sits in a company cash account (the drawer that
 * took the deposit, the Paystack balance…). So an entry takes its amount out
 * of that account's figure — on `channel` — and holds it here until staff move
 * it to a cash account of their choosing (commission-move.model.ts). The
 * company's cash total never changes; the commission is simply shown apart.
 *
 * Written in the same transaction as the money move that earned it, and
 * deleted only when that move is undone (a susu deposit or savings
 * transaction trashed).
 */
export interface Commission {
  _id: Types.ObjectId;
  source: CommissionSource;
  reason: CommissionReason;
  amount: number;
  customerId: Types.ObjectId;
  /** The susu account, savings account or loan it was earned on. */
  accountId: Types.ObjectId;
  /** Which company cash account's channel the money sits in. */
  channel: CommissionChannel;
  takenAt: Date;
  /** Staff who did what earned it; absent when a deposit completed a susu cycle. */
  recordedById?: Types.ObjectId;

  // susu
  planId?: Types.ObjectId;
  cycleId?: Types.ObjectId;
  cycleNumber?: number;
  /** The plan's amount during that cycle — the commission is one of these. */
  dailyAmount?: number;
  /** The deposit whose 31st payment completed the cycle. */
  depositId?: Types.ObjectId;
  /** The withdrawal or closing payout it was taken on. */
  payoutId?: Types.ObjectId;

  // savings
  savingsTxnId?: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const commissionSchema = new Schema<Commission>(
  {
    source: { type: String, enum: COMMISSION_SOURCES, required: true },
    reason: { type: String, enum: COMMISSION_REASONS, required: true },
    amount: moneyField,
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    accountId: { type: Schema.Types.ObjectId, required: true },
    channel: { type: String, enum: COMMISSION_CHANNELS, required: true },
    takenAt: { type: Date, required: true },
    recordedById: { type: Schema.Types.ObjectId, ref: 'User' },
    planId: { type: Schema.Types.ObjectId, ref: 'SusuPlan' },
    cycleId: { type: Schema.Types.ObjectId, ref: 'SusuCycle' },
    cycleNumber: { type: Number, min: 1 },
    dailyAmount: { type: Number, min: 0 },
    depositId: { type: Schema.Types.ObjectId, ref: 'SusuDeposit' },
    payoutId: { type: Schema.Types.ObjectId, ref: 'SusuPayout' },
    savingsTxnId: { type: Schema.Types.ObjectId, ref: 'SavingsTxn' },
  },
  { timestamps: true },
);

// One entry per thing that earned it — also what makes the backfill safe to re-run.
commissionSchema.index(
  { cycleId: 1 },
  { unique: true, partialFilterExpression: { cycleId: { $exists: true } } },
);
commissionSchema.index(
  { savingsTxnId: 1 },
  { unique: true, partialFilterExpression: { savingsTxnId: { $exists: true } } },
);
commissionSchema.index(
  { accountId: 1 },
  { unique: true, partialFilterExpression: { source: 'loan-fee' } },
);
commissionSchema.index({ takenAt: -1, _id: -1 });
commissionSchema.index({ source: 1, takenAt: -1 });
commissionSchema.index({ channel: 1, takenAt: 1 });
commissionSchema.index({ accountId: 1, takenAt: -1 });

export const CommissionModel = model<Commission>('Commission', commissionSchema, 'commissions');

import { Schema, model, type Types } from 'mongoose';
import { moneyField, optionalMoneyField } from './shared.js';

/**
 * One collector's end-of-day cash handover (client request 2026-08-21).
 *
 * Three numbers, deliberately kept apart:
 *   expectedAmount  — what the system says was collected in cash that day
 *   declaredAmount  — what the collector counted in hand before handing over
 *   receivedAmount  — what the office receiver actually took in
 *
 * A shortage never blocks the collector; it is recorded and reported. Field
 * cash means susu + savings deposits only — loans and hire purchase are
 * collected at the office and never form part of a collector's day.
 */
export interface Reconciliation {
  _id: Types.ObjectId;
  collectorId: Types.ObjectId;
  /** Accra calendar day (YYYY-MM-DD). One reconciliation per collector per day. */
  accraDay: string;
  /**
   * Recomputed and re-stored at each state change, so a deposit corrected
   * between declaration and confirmation is reflected in the final variance.
   */
  expectedAmount: number;
  /** Cash-channel breakdown behind expectedAmount. */
  expectedBreakdown: { susu: number; savings: number };
  declaredAmount: number;
  declaredAt: Date;
  declaredNote?: string;
  receivedAmount?: number;
  receivedById?: Types.ObjectId;
  receivedAt?: Date;
  /** receivedAmount − expectedAmount. Negative = short, positive = over. */
  variance?: number;
  /** receivedAmount − declaredAmount: a miscount between collector and receiver. */
  declaredVsReceived?: number;
  varianceReason?: string;
  status: 'declared' | 'reconciled';
  createdAt: Date;
  updatedAt: Date;
}

const reconciliationSchema = new Schema<Reconciliation>(
  {
    collectorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    accraDay: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    expectedAmount: moneyField,
    expectedBreakdown: {
      susu: { ...moneyField, default: 0 },
      savings: { ...moneyField, default: 0 },
    },
    declaredAmount: moneyField,
    declaredAt: { type: Date, required: true },
    declaredNote: { type: String, trim: true },
    receivedAmount: optionalMoneyField,
    receivedById: { type: Schema.Types.ObjectId, ref: 'User' },
    receivedAt: { type: Date },
    // Not moneyField: a shortage is negative, and money fields are non-negative.
    variance: { type: Number },
    declaredVsReceived: { type: Number },
    varianceReason: { type: String, trim: true },
    status: { type: String, enum: ['declared', 'reconciled'], default: 'declared' },
  },
  { timestamps: true },
);

// A collector closes a given day exactly once.
reconciliationSchema.index({ collectorId: 1, accraDay: 1 }, { unique: true });
reconciliationSchema.index({ accraDay: -1, status: 1 });

export const ReconciliationModel = model<Reconciliation>(
  'Reconciliation',
  reconciliationSchema,
  'reconciliations',
);

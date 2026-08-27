import { Schema, model, type Types } from 'mongoose';
import { moneyField, type Role } from './shared.js';

/**
 * One Paystack mobile-money charge and what it pays for. `status` tracks
 * Paystack's view of the money; `executionStatus` tracks whether the paid
 * amount has been applied to the target record (susu deposit, savings
 * deposit, loan repayment, HP payment). A charge can be success/pending-apply
 * briefly (webhook processing) or success/failed when the target's state
 * changed between initiation and payment — the office resolves those.
 */

export const CHARGE_KINDS = [
  'susu-deposit',
  'savings-deposit',
  'loan-repayment',
  'hp-deposit',
  'hp-installment',
  'hp-redemption',
] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

export interface PaystackCharge {
  _id: Types.ObjectId;
  /** Server-generated, unique, sent to Paystack: yadah-<uuid>. */
  reference: string;
  status: 'pending' | 'success' | 'failed';
  executionStatus: 'pending' | 'applied' | 'failed';
  kind: ChargeKind;
  /** The account/loan/agreement the money is destined for. */
  targetId: Types.ObjectId;
  customerId: Types.ObjectId;
  amount: number; // pesewas (1:1 with Paystack's GHS subunit)
  phone: string;
  provider: 'mtn' | 'vod' | 'atl';
  email: string;
  /** A User id for staff-initiated charges, a Customer id for portal ones. */
  initiatedById: Types.ObjectId;
  /** 'customer' when the charge came from the portal rather than a staff member. */
  initiatedByRole: Role | 'customer';
  paystackStatus?: string;
  displayText?: string;
  failureReason?: string;
  /** The deposit/repayment/payment record created when applied. */
  resultRecordId?: Types.ObjectId;
  executedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const paystackChargeSchema = new Schema<PaystackCharge>(
  {
    reference: { type: String, required: true, unique: true },
    status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
    executionStatus: { type: String, enum: ['pending', 'applied', 'failed'], default: 'pending' },
    kind: { type: String, enum: CHARGE_KINDS, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    amount: moneyField,
    phone: { type: String, required: true },
    provider: { type: String, enum: ['mtn', 'vod', 'atl'], required: true },
    email: { type: String, required: true },
    initiatedById: { type: Schema.Types.ObjectId, required: true },
    initiatedByRole: { type: String, required: true },
    paystackStatus: { type: String },
    displayText: { type: String },
    failureReason: { type: String },
    resultRecordId: { type: Schema.Types.ObjectId },
    executedAt: { type: Date },
  },
  { timestamps: true },
);

paystackChargeSchema.index({ customerId: 1, createdAt: -1 });
paystackChargeSchema.index({ status: 1, executionStatus: 1 });

export const PaystackChargeModel = model<PaystackCharge>(
  'PaystackCharge',
  paystackChargeSchema,
  'paystack-charges',
);

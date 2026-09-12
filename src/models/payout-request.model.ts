import { Schema, model, type Types } from 'mongoose';
import { optionalMoneyField } from './shared.js';

/**
 * A customer-initiated request to take money out, submitted from the portal
 * and decided by a human in the office.
 *
 * Withdrawals stay office-only (client-confirmed): this record never moves
 * money by itself. On approval the office executes the SAME withdrawal service
 * a counter transaction would use, so every existing rule — the susu closing
 * commission, the savings GHS 10 fee, one withdrawal per Accra day, the
 * minimum balance — applies unchanged.
 *
 * Status meaning, in order:
 *   pending   — submitted, awaiting an office decision
 *   rejected  — declined; nothing moved
 *   approved  — the withdrawal was EXECUTED and the account debited; the
 *               Paystack transfer is in flight
 *   paid      — the transfer settled (transfer.success webhook)
 *   failed    — the transfer did not settle. The account is ALREADY DEBITED,
 *               so this is an operational alert: the office either retries the
 *               payout or hands over cash. It never silently re-credits.
 */

export const PAYOUT_REQUEST_KINDS = [
  'savings-withdrawal',
  'susu-partial-withdrawal',
  'susu-closure',
] as const;
export type PayoutRequestKind = (typeof PAYOUT_REQUEST_KINDS)[number];

export const PAYOUT_REQUEST_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'paid',
  'failed',
] as const;
export type PayoutRequestStatus = (typeof PAYOUT_REQUEST_STATUSES)[number];

export interface PayoutRequest {
  _id: Types.ObjectId;
  customerId: Types.ObjectId;
  kind: PayoutRequestKind;
  /** The susu or savings account the money comes out of. */
  targetId: Types.ObjectId;
  /**
   * Amount the customer asked for, in pesewas. Absent for susu-closure, where
   * the payout is the whole balance less commission and is not the customer's
   * to choose.
   */
  amount?: number;
  status: PayoutRequestStatus;

  /** Wallet the money goes to. Defaults to the customer's registered phone. */
  payoutPhone: string;
  payoutProvider: 'mtn' | 'vod' | 'atl';

  /** Idempotency key minted at submission and reused for the withdrawal. */
  idempotencyKey: string;

  reviewedById?: Types.ObjectId;
  reviewedAt?: Date;
  rejectionReason?: string;

  /** The susu payout / savings transaction created when the office approved. */
  resultRecordId?: Types.ObjectId;
  /** What actually left the account, after commission or fee. */
  netAmount?: number;

  transferReference?: string;
  transferCode?: string;
  recipientCode?: string;
  paystackStatus?: string;
  failureReason?: string;
  paidAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const payoutRequestSchema = new Schema<PayoutRequest>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    kind: { type: String, enum: PAYOUT_REQUEST_KINDS, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    amount: optionalMoneyField,
    status: { type: String, enum: PAYOUT_REQUEST_STATUSES, default: 'pending' },
    payoutPhone: { type: String, required: true },
    payoutProvider: { type: String, enum: ['mtn', 'vod', 'atl'], required: true },
    idempotencyKey: { type: String, required: true, unique: true },
    reviewedById: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    rejectionReason: { type: String },
    resultRecordId: { type: Schema.Types.ObjectId },
    netAmount: optionalMoneyField,
    transferReference: { type: String, unique: true, sparse: true },
    transferCode: { type: String },
    recipientCode: { type: String },
    paystackStatus: { type: String },
    failureReason: { type: String },
    paidAt: { type: Date },
  },
  { timestamps: true },
);

payoutRequestSchema.index({ customerId: 1, createdAt: -1 });
payoutRequestSchema.index({ status: 1, createdAt: -1 });
// One open request per account: a customer cannot queue two withdrawals
// against the same balance and have both approved against stale figures.
payoutRequestSchema.index(
  { targetId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);

export const PayoutRequestModel = model<PayoutRequest>(
  'PayoutRequest',
  payoutRequestSchema,
  'payout-requests',
);

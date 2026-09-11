import { Schema, model, type Types } from 'mongoose';
import { moneyField, trashFields, type TrashFields } from './shared.js';

/**
 * A hire purchase agreement (HP guide). Lifecycle:
 *   pending → active → in-arrears → repossessed → closed-redeemed | closed-forfeited
 *   pending → rejected · active → closed-completed (ownership transferred)
 * The redemption window is legally sensitive: redemptionDeadline is stored
 * exactly and surfaced on every read. Item prices are SNAPSHOTTED at signing
 * so later inventory edits never change a signed agreement.
 */
export interface HpAgreement extends TrashFields {
  _id: Types.ObjectId;
  /**
   * `HP` + YYMM + 4-digit monthly sequence, e.g. HP26080001. Optional because
   * agreements predating the scheme have none until the migration backfills them.
   */
  accountNumber?: string;
  customerId: Types.ObjectId;
  itemId: Types.ObjectId;
  itemSnapshot: {
    name: string;
    description?: string;
    costPrice: number;
    sellingPrice: number;
  };
  /** Exactly half the selling price (rounded up), due before release. */
  depositRequired: number;
  /** sellingPrice − depositRequired; interest applies on this (Stage B). */
  financedAmount: number;
  durationMonths: number;
  /** Configured rate captured at signing. Flat, applied once (client-confirmed). */
  interestRatePercent: number;
  /** Set at activation: round(financedAmount × rate / 100). */
  interestAmount?: number;
  /** Set at activation: financedAmount + interestAmount. */
  totalPayable?: number;
  totalPaid: number; // deposit + installments + redemption payments
  status:
    /** Signed at the counter by a teller, waiting on a manager to let it stand. */
    | 'awaiting-approval'
    | 'pending'
    | 'rejected'
    | 'active'
    | 'in-arrears'
    | 'repossessed'
    | 'closed-redeemed'
    | 'closed-forfeited'
    | 'closed-completed';
  createdById: Types.ObjectId;
  itemReleasedAt?: Date;
  arrearsAt?: Date;
  repossessedAt?: Date;
  repossessionReason?: string;
  /** repossessedAt + 1 month — full remaining balance redeems until then. */
  redemptionDeadline?: Date;
  closedAt?: Date;
  rejectionReason?: string;
  /** A picture of the customer's signature on the agreement. */
  signatureUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

const hpAgreementSchema = new Schema<HpAgreement>(
  {
    // Sparse: pre-scheme agreements carry no number until the migration runs.
    accountNumber: { type: String, unique: true, sparse: true, match: /^HP\d{8}$/ },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    itemId: { type: Schema.Types.ObjectId, ref: 'HpItem', required: true },
    itemSnapshot: {
      type: new Schema(
        {
          name: { type: String, required: true },
          description: { type: String },
          costPrice: moneyField,
          sellingPrice: moneyField,
        },
        { _id: false },
      ),
      required: true,
    },
    depositRequired: moneyField,
    financedAmount: moneyField,
    durationMonths: { type: Number, required: true, min: 1, max: 24 },
    interestRatePercent: { type: Number, required: true, min: 0, max: 100 },
    interestAmount: { type: Number, min: 0 },
    totalPayable: { type: Number, min: 0 },
    totalPaid: { ...moneyField, default: 0 },
    status: {
      type: String,
      enum: [
        'awaiting-approval',
        'pending',
        'rejected',
        'active',
        'in-arrears',
        'repossessed',
        'closed-redeemed',
        'closed-forfeited',
        'closed-completed',
      ],
      default: 'pending',
    },
    createdById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    itemReleasedAt: { type: Date },
    arrearsAt: { type: Date },
    repossessedAt: { type: Date },
    repossessionReason: { type: String, trim: true },
    redemptionDeadline: { type: Date },
    closedAt: { type: Date },
    signatureUrl: { type: String },
    rejectionReason: { type: String, trim: true },
    ...trashFields,
  },
  { timestamps: true },
);

hpAgreementSchema.index({ customerId: 1, status: 1 });
hpAgreementSchema.index({ status: 1, redemptionDeadline: 1 });

export const HpAgreementModel = model<HpAgreement>(
  'HpAgreement',
  hpAgreementSchema,
  'hp-agreements',
);

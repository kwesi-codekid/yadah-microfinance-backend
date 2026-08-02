import { Schema, model, type Types } from 'mongoose';
import { moneyField } from './shared.js';

/**
 * A hire purchase agreement (HP guide). Lifecycle:
 *   pending → active → in-arrears → repossessed → closed-redeemed | closed-forfeited
 *   pending → rejected · active → closed-completed (ownership transferred)
 * The redemption window is legally sensitive: redemptionDeadline is stored
 * exactly and surfaced on every read. Item prices are SNAPSHOTTED at signing
 * so later inventory edits never change a signed agreement.
 */
export interface HpAgreement {
  _id: Types.ObjectId;
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
  createdAt: Date;
  updatedAt: Date;
}

const hpAgreementSchema = new Schema<HpAgreement>(
  {
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
    rejectionReason: { type: String, trim: true },
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

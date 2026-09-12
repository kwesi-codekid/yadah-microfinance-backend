import { Schema, model, type Types } from 'mongoose';
import { moneyField, trashFields, type TrashFields } from './shared.js';

/**
 * Tiers: small 1,000–20,000 · big 20,001–50,000 (GHS, stored as pesewas).
 * Flat interest on principal by duration: 3m=10% · 6m=20% · 12m=30%.
 * Escalation past due date: next rate applied to ORIGINAL PRINCIPAL;
 * past 30% the amount freezes and the loan is flagged in arrears.
 * One active loan per customer — enforced in the service layer, no exceptions.
 */
export interface Loan extends TrashFields {
  _id: Types.ObjectId;
  /**
   * `LN` + YYMM + 4-digit monthly sequence, e.g. LN26080001. Optional because
   * loans predating the scheme have none until the migration backfills them.
   */
  accountNumber?: string;
  customerId: Types.ObjectId;
  /**
   * Who stands behind the loan if the borrower does not pay — another
   * registered customer, identified as fully as the borrower is: an ID
   * recorded and both sides of it photographed.
   *
   * Optional on the model and required on new applications. Loans written
   * before guarantors existed have none, and making the field required would
   * make every one of those records invalid.
   */
  guarantorId?: Types.ObjectId;
  /**
   * The guarantor as they were when the application was signed.
   *
   * Snapshotted for the same reason HpAgreement.itemSnapshot is: this is what
   * the paper the guarantor put their name to actually said. They may later
   * change their phone, or replace the ID they stood behind it with, and none
   * of that may quietly rewrite a signed undertaking.
   */
  guarantorSnapshot?: {
    fullName: string;
    phone: string;
    idType?: string;
    idNumber?: string;
  };
  tier: 'small' | 'big';
  principal: number; // pesewas, never changes
  durationMonths: 3 | 6 | 12;
  ratePercent: number; // current rate: 10 | 20 | 30 (moves on escalation)
  interestAmount: number; // pesewas, recomputed from principal on escalation
  totalDue: number; // pesewas: principal + interestAmount
  totalRepaid: number; // pesewas, denormalized from repayments
  status: 'pending' | 'approved' | 'rejected' | 'active' | 'repaid' | 'arrears';
  frozen: boolean; // true once escalation is exhausted (past 30%)
  appliedAt: Date;
  approvedById?: Types.ObjectId;
  approvedAt?: Date;
  disbursedAt?: Date;
  dueDate?: Date; // disbursedAt + durationMonths
  escalatedAt?: Date;
  closedAt?: Date;
  /** Repaid on time → unlocks the big tier (graduation rule). */
  repaidOnTime?: boolean;
  rejectionReason?: string;
  /** A picture of the customer's signature on the application. */
  signatureUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

const loanSchema = new Schema<Loan>(
  {
    // Sparse: pre-scheme loans carry no number until the migration runs.
    accountNumber: { type: String, unique: true, sparse: true, match: /^LN\d{8}$/ },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    guarantorId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    guarantorSnapshot: {
      type: new Schema(
        {
          fullName: { type: String, required: true, trim: true },
          phone: { type: String, required: true, trim: true },
          idType: { type: String },
          idNumber: { type: String },
        },
        { _id: false },
      ),
      required: false,
    },
    tier: { type: String, enum: ['small', 'big'], required: true },
    principal: { ...moneyField, immutable: true },
    durationMonths: { type: Number, enum: [3, 6, 12], required: true },
    ratePercent: { type: Number, enum: [10, 20, 30], required: true },
    interestAmount: moneyField,
    totalDue: moneyField,
    totalRepaid: { ...moneyField, default: 0 },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'active', 'repaid', 'arrears'],
      default: 'pending',
    },
    frozen: { type: Boolean, default: false },
    appliedAt: { type: Date, required: true },
    approvedById: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    disbursedAt: { type: Date },
    dueDate: { type: Date },
    escalatedAt: { type: Date },
    closedAt: { type: Date },
    repaidOnTime: { type: Boolean },
    signatureUrl: { type: String },
    rejectionReason: { type: String, trim: true },
    ...trashFields,
  },
  { timestamps: true },
);

loanSchema.index({ customerId: 1, status: 1 });
// "What is this customer standing behind?" — asked before accepting them as a
// guarantor again, and on their own record.
loanSchema.index({ guarantorId: 1, status: 1 });
loanSchema.index({ status: 1, dueDate: 1 }); // overdue cron scans

export const LoanModel = model<Loan>('Loan', loanSchema, 'loans');

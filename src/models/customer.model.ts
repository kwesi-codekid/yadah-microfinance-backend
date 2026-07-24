import { Schema, model, type Types } from 'mongoose';

/**
 * ghanaCardNumber is optional for susu/savings customers; the loan
 * application flow requires it at the service level (Week 5).
 */
export interface Customer {
  _id: Types.ObjectId;
  fullName: string;
  phone: string;
  altPhone?: string;
  ghanaCardNumber?: string;
  photoUrl?: string;
  residentialAddress?: string;
  /** GhanaPost GPS digital address, e.g. WR-123-4567. */
  ghanaPostGps?: string;
  /** Collector who registered the customer (may differ from assigned). */
  registeredById: Types.ObjectId;
  /** Collector currently responsible for the customer's collections. */
  assignedCollectorId?: Types.ObjectId;
  status: 'active' | 'inactive';
  createdAt: Date;
  updatedAt: Date;
}

const customerSchema = new Schema<Customer>(
  {
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true },
    altPhone: { type: String },
    ghanaCardNumber: { type: String },
    photoUrl: { type: String },
    residentialAddress: { type: String, trim: true },
    ghanaPostGps: { type: String, trim: true, uppercase: true },
    registeredById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    assignedCollectorId: { type: Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true },
);

customerSchema.index({ fullName: 'text' });
customerSchema.index({ assignedCollectorId: 1, status: 1 });
// Unique only when present — optional field, but no two customers may share one.
customerSchema.index({ ghanaCardNumber: 1 }, { unique: true, sparse: true });

export const CustomerModel = model<Customer>('Customer', customerSchema, 'customers');

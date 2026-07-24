import { Schema, model, type Types } from 'mongoose';

export interface Customer {
  _id: Types.ObjectId;
  fullName: string;
  phone: string;
  altPhone?: string;
  ghanaCardNumber: string;
  photoUrl?: string;
  zone?: string;
  assignedCollectorId?: Types.ObjectId;
  status: 'active' | 'inactive';
  createdById: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const customerSchema = new Schema<Customer>(
  {
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true },
    altPhone: { type: String },
    ghanaCardNumber: { type: String, required: true, unique: true },
    photoUrl: { type: String },
    zone: { type: String, trim: true },
    assignedCollectorId: { type: Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

customerSchema.index({ fullName: 'text' });
customerSchema.index({ assignedCollectorId: 1, status: 1 });

export const CustomerModel = model<Customer>('Customer', customerSchema, 'customers');

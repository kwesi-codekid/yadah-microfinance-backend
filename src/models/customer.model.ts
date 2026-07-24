import { Schema, model, type Types } from 'mongoose';

/**
 * Shaped after the client's paper "Savings Account Opening Form".
 * Only fullName + phone are required at the API level — office staff may
 * complete the rest of the profile progressively. Account creation is
 * office-only; the form's account-type section maps to the susu/savings
 * modules, not to this profile.
 */

export const GENDERS = ['male', 'female'] as const;
export const MARITAL_STATUSES = ['single', 'married', 'other'] as const;
export const ID_TYPES = ['ghana-card', 'passport', 'drivers-license', 'voter-id'] as const;

export interface CustomerIdentification {
  idType: (typeof ID_TYPES)[number];
  idNumber: string;
  idExpiryDate?: Date;
  idPlaceOfIssue?: string;
}

export interface NextOfKin {
  fullName: string;
  relationship?: string;
  phone?: string;
  address?: string;
}

export interface Customer {
  _id: Types.ObjectId;
  // Personal
  fullName: string; // as on ID
  dateOfBirth?: Date;
  gender?: (typeof GENDERS)[number];
  nationality?: string;
  maritalStatus?: (typeof MARITAL_STATUSES)[number];
  mothersMaidenName?: string;
  // Contact
  residentialAddress?: string;
  /** GhanaPost GPS digital address, e.g. WR-123-4567. */
  ghanaPostGps?: string;
  postalAddress?: string;
  phone: string;
  altPhone?: string;
  email?: string;
  // Identification (Ghana Card required at loan application, service-level)
  identification?: CustomerIdentification;
  // Occupation
  occupation?: string;
  employerOrBusiness?: string;
  purposeOfAccount?: string;
  // Next of kin
  nextOfKin?: NextOfKin;
  // Attachments
  photoUrl?: string;
  idDocumentUrl?: string;
  // Administration
  registeredById: Types.ObjectId;
  assignedCollectorId?: Types.ObjectId;
  status: 'active' | 'inactive';
  createdAt: Date;
  updatedAt: Date;
}

const identificationSchema = new Schema<CustomerIdentification>(
  {
    idType: { type: String, enum: ID_TYPES, required: true },
    idNumber: { type: String, required: true, trim: true },
    idExpiryDate: { type: Date },
    idPlaceOfIssue: { type: String, trim: true },
  },
  { _id: false },
);

const nextOfKinSchema = new Schema<NextOfKin>(
  {
    fullName: { type: String, required: true, trim: true },
    relationship: { type: String, trim: true },
    phone: { type: String, trim: true },
    address: { type: String, trim: true },
  },
  { _id: false },
);

const customerSchema = new Schema<Customer>(
  {
    fullName: { type: String, required: true, trim: true },
    dateOfBirth: { type: Date },
    gender: { type: String, enum: GENDERS },
    nationality: { type: String, trim: true },
    maritalStatus: { type: String, enum: MARITAL_STATUSES },
    mothersMaidenName: { type: String, trim: true },

    residentialAddress: { type: String, trim: true },
    ghanaPostGps: { type: String, trim: true, uppercase: true },
    postalAddress: { type: String, trim: true },
    phone: { type: String, required: true, unique: true },
    altPhone: { type: String },
    email: { type: String, lowercase: true, trim: true },

    identification: { type: identificationSchema },

    occupation: { type: String, trim: true },
    employerOrBusiness: { type: String, trim: true },
    purposeOfAccount: { type: String, trim: true },

    nextOfKin: { type: nextOfKinSchema },

    photoUrl: { type: String },
    idDocumentUrl: { type: String },

    registeredById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    assignedCollectorId: { type: Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true },
);

customerSchema.index({ fullName: 'text' });
customerSchema.index({ assignedCollectorId: 1, status: 1 });
// No two customers may share the same ID document (when one is recorded).
customerSchema.index(
  { 'identification.idType': 1, 'identification.idNumber': 1 },
  { unique: true, sparse: true },
);

export const CustomerModel = model<Customer>('Customer', customerSchema, 'customers');

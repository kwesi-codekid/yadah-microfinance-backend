import { Schema, model, type Types } from 'mongoose';
import { trashFields, type TrashFields } from './shared.js';

/**
 * Shaped after the client's paper "Savings Account Opening Form".
 * Only fullName + phone are required at the API level — office staff may
 * complete the rest of the profile progressively. Account creation is
 * office-only; the form's account-type section maps to the susu/savings
 * modules, not to this profile.
 */

export const GENDERS = ['male', 'female'] as const;
export const MARITAL_STATUSES = ['single', 'married', 'other'] as const;
/** NHIS is for children above all, who hold no other document (client decision, 5 Oct 2026). */
export const ID_TYPES = ['ghana-card', 'passport', 'drivers-license', 'voter-id', 'nhis'] as const;

export interface CustomerIdentification {
  idType: (typeof ID_TYPES)[number];
  idNumber: string;
}

export interface NextOfKin {
  fullName: string;
  relationship?: string;
  phone?: string;
  address?: string;
}

export interface Customer extends TrashFields {
  _id: Types.ObjectId;
  // Personal
  fullName: string; // as on ID
  dateOfBirth?: Date;
  gender?: (typeof GENDERS)[number];
  nationality?: string;
  maritalStatus?: (typeof MARITAL_STATUSES)[number];
  // Contact
  residentialAddress?: string;
  phone: string;
  altPhone?: string;
  /**
   * Under 18 when the record was last registered or edited, worked out from
   * `dateOfBirth` (see lib/age.ts) — never typed in. It exists for the phone
   * index below: children may share a parent's number, adults may not, and a
   * unique index can only tell the two apart by a stored field. It goes stale
   * on an 18th birthday until the next edit, which then asks for the person's
   * own number. Anything that turns on age right now — credit above all —
   * reads the date of birth, not this.
   */
  isMinor: boolean;
  // Identification (Ghana Card required at loan application, service-level)
  identification?: CustomerIdentification;
  // Occupation
  occupation?: string;
  // Next of kin
  nextOfKin?: NextOfKin;
  // Attachments (URLs from the uploads endpoint)
  photoUrl?: string;
  idDocumentFrontUrl?: string;
  idDocumentBackUrl?: string;
  // Administration
  /**
   * The collector who owns this customer's round. Collectors may only see and
   * collect from their own customers (client decision 2026-08-21), so an
   * unassigned customer is invisible in the field until an admin assigns one.
   */
  assignedCollectorId?: Types.ObjectId;
  /**
   * The customer's susu number, without a cycle month — `SU26090009`, or a
   * grandfathered `482913`. Assigned once, the first time they open a susu
   * book, and never changed: every book they ever hold is this plus `-MMM`
   * (client decision, 12 Sep 2026).
   *
   * It lives here rather than being read off their oldest account because this
   * is the one place it can be claimed atomically. Two tellers opening a first
   * book for the same customer at the same instant would otherwise both find
   * no account, both mint, and leave the customer with two numbers — the very
   * thing the branch reported. A transaction would not help: with no document
   * to conflict on, both snapshots commit.
   *
   * Absent on customers who have never opened a susu book, which is most of
   * them — a number is burnt only when one is actually needed.
   */
  susuNumber?: string;
  /**
   * The Accra day (YYYY-MM-DD) the customer started saving with Yadah — often
   * years before they were entered into the app. Absent on customers
   * registered before the field existed; read their registration day instead.
   */
  joinedOn?: string;
  registeredById: Types.ObjectId;
  status: 'active' | 'inactive';
  createdAt: Date;
  updatedAt: Date;
}

const identificationSchema = new Schema<CustomerIdentification>(
  {
    idType: { type: String, enum: ID_TYPES, required: true },
    idNumber: { type: String, required: true, trim: true },
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

    residentialAddress: { type: String, trim: true },
    phone: { type: String, required: true },
    altPhone: { type: String },
    isMinor: { type: Boolean, default: false },

    identification: { type: identificationSchema },

    occupation: { type: String, trim: true },

    nextOfKin: { type: nextOfKinSchema },

    photoUrl: { type: String },
    idDocumentFrontUrl: { type: String },
    idDocumentBackUrl: { type: String },

    assignedCollectorId: { type: Schema.Types.ObjectId, ref: 'User' },
    // Deliberately NOT `immutable`, though it is written exactly once and must
    // never change afterwards: mongoose strips immutable paths from update
    // operations, and the only thing that ever sets this is an atomic
    // findOneAndUpdate claim, which would then silently write nothing. The
    // claim's own filter (`susuNumber: null`) is what enforces write-once.
    susuNumber: { type: String },
    joinedOn: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    registeredById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    ...trashFields,
  },
  { timestamps: true },
);

customerSchema.index({ fullName: 'text' });
customerSchema.index({ status: 1 });
// Every collector-scoped read filters on this.
customerSchema.index({ assignedCollectorId: 1, status: 1 });
// The one uniqueness the susu scheme still has: no two customers share a
// number. It cannot be enforced on the accounts any more, because there the
// duplicates are the point.
customerSchema.index({ susuNumber: 1 }, { unique: true, sparse: true });
// No two ADULTS share a phone number. Children may use a parent's, or share
// one with a sibling (client decision, 5 Oct 2026). Trashed adults keep theirs
// reserved, as they always have.
customerSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { isMinor: false }, name: 'phone_adult_unique' },
);
// The lookups that are not adult-only — a parent's number to every child on it.
customerSchema.index({ phone: 1, isMinor: 1 });
// No two customers may share the same ID document (when one is recorded).
customerSchema.index(
  { 'identification.idType': 1, 'identification.idNumber': 1 },
  { unique: true, sparse: true },
);

export const CustomerModel = model<Customer>('Customer', customerSchema, 'customers');

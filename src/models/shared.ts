/** Field helpers shared by all models. Money is ALWAYS integer pesewas. */

import { Schema, type Types } from 'mongoose';

export const moneyField = {
  type: Number,
  required: true,
  min: 0,
  validate: {
    validator: Number.isInteger,
    message: 'Money must be integer pesewas',
  },
} as const;

export const optionalMoneyField = { ...moneyField, required: false } as const;

/** 'transfer' is internal-only (inter-account moves) — API inputs accept cash/paystack/momo. */
export const CHANNELS = ['cash', 'paystack', 'momo', 'transfer'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * `teller` is the counter: unscoped like the office, because anyone may walk
 * up, but junior like a collector, because deciding is not their job. That
 * combination is why role alone stopped being enough — see middleware/rbac.ts.
 */
export const ROLES = ['admin', 'manager', 'teller', 'collector'] as const;
export type Role = (typeof ROLES)[number];

/** Someone the account holder sent to collect money out on their behalf. */
export interface CollectedBy {
  name: string;
  phone: string;
}

export const collectedByField = {
  type: new Schema<CollectedBy>(
    {
      name: { type: String, required: true, trim: true, maxlength: 100 },
      phone: { type: String, required: true },
    },
    { _id: false },
  ),
  default: undefined,
} as const;

/**
 * Soft-delete (trash) fields shared by every trashable model. Trashed docs
 * stay in their collection; queries opt out of them with NOT_TRASHED —
 * deliberately explicit per query, no global plugin.
 */
export interface TrashFields {
  deletedAt?: Date | null;
  deletedById?: Types.ObjectId;
  deleteReason?: string;
}

export const trashFields = {
  deletedAt: { type: Date, default: null },
  deletedById: { type: Schema.Types.ObjectId, ref: 'User' },
  deleteReason: { type: String, maxlength: 300 },
} as const;

/** Query fragment excluding trashed docs (`null` also matches missing). */
export const NOT_TRASHED = { deletedAt: null } as const;

/** For trash-only mappers: narrows deletedAt, failing loud on a live doc. */
export function requireDeletedAt(deletedAt: Date | null | undefined): Date {
  if (!deletedAt) throw new Error('Expected a trashed document (deletedAt not set)');
  return deletedAt;
}

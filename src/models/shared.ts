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

export const ROLES = ['admin', 'manager', 'collector'] as const;
export type Role = (typeof ROLES)[number];

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

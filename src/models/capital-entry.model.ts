import { Schema, model, type Types } from 'mongoose';
import { moneyField, trashFields, type TrashFields } from './shared.js';

/**
 * Owner's money in and out — the equity side of the balance sheet.
 *
 * A contribution is the owner putting money into the business; a drawing is
 * taking it out. Neither is income or an expense: they move equity, not
 * profit, which is exactly why they cannot be recorded as expenses.
 *
 * The opening capital at go-live is simply the first contribution.
 */

export const CAPITAL_ENTRY_KINDS = ['contribution', 'drawing'] as const;
export type CapitalEntryKind = (typeof CAPITAL_ENTRY_KINDS)[number];

export interface CapitalEntry extends TrashFields {
  _id: Types.ObjectId;
  kind: CapitalEntryKind;
  amount: number;
  /** Accra day the money moved. */
  occurredOn: string;
  /** Which company account it went into or came out of. */
  cashAccountId?: Types.ObjectId;
  note?: string;
  recordedById: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const capitalEntrySchema = new Schema<CapitalEntry>(
  {
    kind: { type: String, enum: CAPITAL_ENTRY_KINDS, required: true },
    amount: moneyField,
    occurredOn: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    cashAccountId: { type: Schema.Types.ObjectId, ref: 'CashAccount' },
    note: { type: String, trim: true, maxlength: 300 },
    recordedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ...trashFields,
  },
  { timestamps: true },
);

capitalEntrySchema.index({ occurredOn: -1 });
capitalEntrySchema.index({ cashAccountId: 1, occurredOn: -1 });

export const CapitalEntryModel = model<CapitalEntry>(
  'CapitalEntry',
  capitalEntrySchema,
  'capital-entries',
);

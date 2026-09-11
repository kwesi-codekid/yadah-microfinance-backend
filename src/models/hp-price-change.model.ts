import { Schema, model, type Types } from 'mongoose';
import { moneyField } from './shared.js';

/**
 * Every time an item's cost or selling price moves, and why.
 *
 * An item carries ONE cost and ONE selling price — the latest. That is what
 * the shelf charges and what stock is valued at. The problem with only the
 * latest is that it answers "what is it worth now" while destroying the answer
 * to "why did it change" — a delivery invoiced at a new price silently
 * revalues everything already on the shelf, and nobody can see it happened.
 *
 * So the number stays single and this collection remembers the moves. Each row
 * is one field changing once, with the previous value beside the new one and,
 * when the change arrived with a delivery, the supplier and invoice that
 * carried it.
 *
 * Past sales are unaffected either way: HpSaleLine snapshots `unitCost` and
 * `listPrice`, and HpAgreement snapshots the item, so nothing written here can
 * rewrite what a customer was charged or what a sale earned.
 */

export const PRICE_KINDS = ['cost', 'selling'] as const;
export type PriceKind = (typeof PRICE_KINDS)[number];

export interface HpPriceChange {
  _id: Types.ObjectId;
  itemId: Types.ObjectId;
  kind: PriceKind;
  /** Pesewas. What the item was priced at before this change. */
  previous: number;
  /** Pesewas. What it is priced at after. Never equal to `previous`. */
  current: number;
  /** Why, in the words of whoever made the change. */
  reason?: string;

  /** Set when the change came in with a delivery rather than a plain edit. */
  quantityReceived?: number;
  supplier?: string;
  invoiceRef?: string;
  /** The Accra day the goods arrived, which need not be the day it was keyed. */
  receivedOn?: string;

  changedById: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const hpPriceChangeSchema = new Schema<HpPriceChange>(
  {
    itemId: { type: Schema.Types.ObjectId, ref: 'HpItem', required: true },
    kind: { type: String, enum: PRICE_KINDS, required: true },
    previous: moneyField,
    current: moneyField,
    reason: { type: String, trim: true, maxlength: 300 },
    quantityReceived: { type: Number, min: 1 },
    supplier: { type: String, trim: true, maxlength: 160 },
    invoiceRef: { type: String, trim: true, maxlength: 80 },
    receivedOn: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    changedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

hpPriceChangeSchema.index({ itemId: 1, createdAt: -1 });
hpPriceChangeSchema.index({ kind: 1, createdAt: -1 });

export const HpPriceChangeModel = model<HpPriceChange>(
  'HpPriceChange',
  hpPriceChangeSchema,
  'hp-price-changes',
);

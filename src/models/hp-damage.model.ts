import { Schema, model, type Types } from 'mongoose';
import { moneyField, trashFields, type TrashFields } from './shared.js';

/**
 * Stock that can no longer be sold: broken in the shop, damaged in transit,
 * spoiled, or gone missing off the shelf.
 *
 * Reported at the counter, approved by the office. That split is the point of
 * the record — "mark it damaged" is the easiest way to walk goods out of a
 * shop, so the person who reports a loss is never the person who books it, and
 * nothing leaves the shelf until somebody with authority says it may.
 *
 * The cost is SNAPSHOTTED when the report is approved, not recomputed later.
 * An item's price is editable at any moment, and a loss that re-prices itself
 * every time somebody edits the shelf would silently restate closed months —
 * the same reason HpAgreement.itemSnapshot and HpSaleLine.unitCost exist.
 *
 * A damage is a write-off and nothing else: the quantity comes off the shelf
 * and the cost is a loss. There is deliberately no partial recovery, no repair
 * state and no sell-as-damaged path, because each of those is a second
 * valuation of the same goods and the shop asked for one.
 */

export const DAMAGE_CAUSES = [
  /** Arrived broken, or broke in transit to the shop. */
  'delivery',
  /** Broke on the premises: dropped, mishandled, a customer knocked it over. */
  'in-shop',
  /** Water, fire, pests, power — the building's fault rather than a person's. */
  'storage',
  /** Stopped working on its own before it was ever sold. */
  'defective',
  /** On the books but not on the shelf, and nobody can say where it went. */
  'missing',
  'other',
] as const;
export type DamageCause = (typeof DAMAGE_CAUSES)[number];

export const DAMAGE_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type DamageStatus = (typeof DAMAGE_STATUSES)[number];

export interface HpDamage extends TrashFields {
  _id: Types.ObjectId;
  itemId: Types.ObjectId;
  /** The item's name when it was reported — it may be renamed or trashed later. */
  itemName: string;
  quantity: number;
  cause: DamageCause;
  /** What happened, in plain words. This is what the office reads when deciding. */
  description: string;
  /** The Accra day it happened, which need not be the day it was reported. */
  occurredOn: string;

  /**
   * Pesewas. The item's cost price at the moment of APPROVAL, times the
   * quantity — set when the loss is booked, and never recomputed.
   */
  costValue?: number;
  /** The unit cost `costValue` was struck at, kept so the figure can be checked. */
  unitCost?: number;

  status: DamageStatus;
  /** Photographs of the damage. Cloudinary URLs, from the shared uploader. */
  photoUrls: string[];

  reportedById: Types.ObjectId;
  reviewedById?: Types.ObjectId;
  reviewedAt?: Date;
  rejectionReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

const hpDamageSchema = new Schema<HpDamage>(
  {
    itemId: { type: Schema.Types.ObjectId, ref: 'HpItem', required: true },
    itemName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    cause: { type: String, enum: DAMAGE_CAUSES, required: true },
    description: { type: String, required: true, trim: true, maxlength: 300 },
    occurredOn: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    costValue: { ...moneyField, required: false },
    unitCost: { ...moneyField, required: false },
    status: { type: String, enum: DAMAGE_STATUSES, default: 'pending' },
    photoUrls: { type: [String], default: [] },
    reportedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewedById: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    rejectionReason: { type: String, trim: true, maxlength: 300 },
    ...trashFields,
  },
  { timestamps: true },
);

hpDamageSchema.index({ status: 1, createdAt: -1 });
hpDamageSchema.index({ itemId: 1, createdAt: -1 });
hpDamageSchema.index({ occurredOn: -1 });

export const HpDamageModel = model<HpDamage>('HpDamage', hpDamageSchema, 'hp-damages');

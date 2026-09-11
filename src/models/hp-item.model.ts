import { Schema, model, type Types } from 'mongoose';
import { moneyField, trashFields, type TrashFields } from './shared.js';

/**
 * Hire purchase inventory (HP guide: Yadah stocks physical items). Both
 * prices are stored — cost (what Yadah paid) and selling (what the customer
 * pays) — enabling profit-per-item reporting. If they're equal, the office
 * simply enters the same number twice. Cost price is NEVER exposed in
 * customer-facing responses.
 */
export interface HpItem extends TrashFields {
  _id: Types.ObjectId;
  name: string;
  /** Who makes it — a managed label, so "Nasco" is one brand however it was typed. */
  brandId?: Types.ObjectId;
  /** What kind of thing it is — a managed label, likewise. */
  categoryId?: Types.ObjectId;
  description?: string;
  quantityInStock: number;
  costPrice: number; // pesewas — Yadah's private margin input
  sellingPrice: number; // pesewas — what the customer pays
  /** Forfeited repossessions come back as 'used' at a new price. */
  condition: 'new' | 'used';
  status: 'active' | 'discontinued';
  createdById: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const hpItemSchema = new Schema<HpItem>(
  {
    name: { type: String, required: true, trim: true },
    brandId: { type: Schema.Types.ObjectId, ref: 'HpLabel' },
    categoryId: { type: Schema.Types.ObjectId, ref: 'HpLabel' },
    description: { type: String, trim: true },
    quantityInStock: { type: Number, required: true, min: 0 },
    costPrice: moneyField,
    sellingPrice: moneyField,
    condition: { type: String, enum: ['new', 'used'], default: 'new' },
    status: { type: String, enum: ['active', 'discontinued'], default: 'active' },
    createdById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ...trashFields,
  },
  { timestamps: true },
);

hpItemSchema.index({ name: 'text' });
hpItemSchema.index({ status: 1 });
hpItemSchema.index({ brandId: 1 });
hpItemSchema.index({ categoryId: 1 });

export const HpItemModel = model<HpItem>('HpItem', hpItemSchema, 'hp-items');

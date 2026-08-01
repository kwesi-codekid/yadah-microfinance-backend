import { Schema, model, type Types } from 'mongoose';
import { moneyField } from './shared.js';

/**
 * Hire purchase inventory (HP guide: Yadah stocks physical items). Both
 * prices are stored — cost (what Yadah paid) and selling (what the customer
 * pays) — enabling profit-per-item reporting. If they're equal, the office
 * simply enters the same number twice. Cost price is NEVER exposed in
 * customer-facing responses.
 */
export interface HpItem {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  quantityInStock: number;
  costPrice: number; // pesewas — Yadah's private margin input
  sellingPrice: number; // pesewas — what the customer pays
  status: 'active' | 'discontinued';
  createdById: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const hpItemSchema = new Schema<HpItem>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    quantityInStock: { type: Number, required: true, min: 0 },
    costPrice: moneyField,
    sellingPrice: moneyField,
    status: { type: String, enum: ['active', 'discontinued'], default: 'active' },
    createdById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

hpItemSchema.index({ name: 'text' });
hpItemSchema.index({ status: 1 });

export const HpItemModel = model<HpItem>('HpItem', hpItemSchema, 'hp-items');

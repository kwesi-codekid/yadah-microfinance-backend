import { Schema, model, type Types } from 'mongoose';
import { moneyField, optionalMoneyField, trashFields, type TrashFields } from './shared.js';

/**
 * Things the business OWNS rather than spends: collector motorbikes,
 * computers, furniture, premises fittings.
 *
 * Buying one is not a cost — it converts cash into an asset of the same value.
 * The cost reaches the profit and loss gradually, as depreciation, over the
 * asset's useful life.
 *
 * Depreciation is COMPUTED straight-line from these fields rather than posted
 * monthly (see fixed-assets.service.ts). There is no scheduled run to miss and
 * no backfill after downtime: the figure for any date is a function of cost,
 * salvage value, useful life and elapsed months.
 */

export const FIXED_ASSET_CATEGORIES = [
  'motorbike-vehicle',
  'computer-equipment',
  'furniture-fittings',
  'premises',
  'other',
] as const;
export type FixedAssetCategory = (typeof FIXED_ASSET_CATEGORIES)[number];

export interface FixedAsset extends TrashFields {
  _id: Types.ObjectId;
  name: string;
  category: FixedAssetCategory;
  /** What it cost, in pesewas. Immutable — the historical cost never changes. */
  cost: number;
  acquiredOn: string;
  /** Months over which the cost is written off. Straight-line, no residual curve. */
  usefulLifeMonths: number;
  /** What it is expected to be worth at the end of its life. Usually zero. */
  salvageValue: number;
  /** Which account paid for it, so the cash position stays right. */
  cashAccountId?: Types.ObjectId;
  status: 'active' | 'disposed';
  disposedOn?: string;
  /** Cash received on disposal — money back IN, not a negative expense. */
  disposalProceeds?: number;
  disposalNote?: string;
  serialNumber?: string;
  /** Set when a motorbike or phone is issued to a named collector. */
  assignedToId?: Types.ObjectId;
  createdById: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const fixedAssetSchema = new Schema<FixedAsset>(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    category: { type: String, enum: FIXED_ASSET_CATEGORIES, required: true },
    cost: { ...moneyField, immutable: true },
    acquiredOn: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    usefulLifeMonths: { type: Number, required: true, min: 1, max: 600 },
    salvageValue: { ...moneyField, default: 0 },
    cashAccountId: { type: Schema.Types.ObjectId, ref: 'CashAccount' },
    status: { type: String, enum: ['active', 'disposed'], default: 'active' },
    disposedOn: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    disposalProceeds: optionalMoneyField,
    disposalNote: { type: String, maxlength: 300 },
    serialNumber: { type: String, trim: true, maxlength: 80 },
    assignedToId: { type: Schema.Types.ObjectId, ref: 'User' },
    createdById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ...trashFields,
  },
  { timestamps: true },
);

fixedAssetSchema.index({ status: 1, acquiredOn: -1 });
fixedAssetSchema.index({ category: 1 });

export const FixedAssetModel = model<FixedAsset>('FixedAsset', fixedAssetSchema, 'fixed-assets');

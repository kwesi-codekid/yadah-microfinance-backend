import { Schema, model, type Types } from 'mongoose';
import { CHANNELS, moneyField, type Channel } from './shared.js';

/**
 * An outright sale from the hire-purchase stock — the counter/POS case the
 * client raised on 2026-08-21: plenty of people buy a product and pay for it
 * there and then, with no agreement, no deposit and no instalments.
 *
 * Two things it deliberately does differently from an HP agreement:
 *
 *   - There need not be a registered customer. Registering someone (which
 *     requires a photo and both sides of an ID) to sell them a kettle is
 *     absurd, so a walk-in is recorded by name alone.
 *   - It is a basket, not a single item. A counter sale is usually several
 *     things at once.
 *
 * Every price is snapshotted at the point of sale, so later inventory edits
 * never rewrite what a customer was charged or what the profit was.
 */
export interface HpSaleLine {
  itemId: Types.ObjectId;
  /** Snapshot — the item may be renamed or discontinued later. */
  name: string;
  quantity: number;
  /** What was actually charged per unit, pesewas. */
  unitPrice: number;
  /** The item's listed selling price at the time — makes a discount visible. */
  listPrice: number;
  /** Yadah's cost at the time, pesewas. Never exposed to customers. */
  unitCost: number;
  /** unitPrice × quantity. */
  lineTotal: number;
}

export interface HpSale {
  _id: Types.ObjectId;
  /** Set only when the buyer is a registered customer; walk-ins have none. */
  customerId?: Types.ObjectId;
  /** Always present — the registered customer's name, or the walk-in's. */
  buyerName: string;
  buyerPhone?: string;
  lines: HpSaleLine[];
  /** Sum of listPrice × quantity — what the basket would have cost at list. */
  subtotal: number;
  /** subtotal − total. Zero unless a line was sold below list. */
  discount: number;
  /** What the buyer actually paid. */
  total: number;
  /** Sum of unitCost × quantity. Internal only. */
  totalCost: number;
  /** total − totalCost. Internal only. */
  profit: number;
  channel: Channel;
  soldById: Types.ObjectId;
  idempotencyKey?: string;
  /**
   * A voided sale keeps its row — the ledger never forgets — but its stock is
   * returned and it stops counting toward revenue.
   */
  status: 'completed' | 'voided';
  voidedAt?: Date;
  voidedById?: Types.ObjectId;
  voidReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const hpSaleLineSchema = new Schema<HpSaleLine>(
  {
    itemId: { type: Schema.Types.ObjectId, ref: 'HpItem', required: true },
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: moneyField,
    listPrice: moneyField,
    unitCost: moneyField,
    lineTotal: moneyField,
  },
  { _id: false },
);

const hpSaleSchema = new Schema<HpSale>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    buyerName: { type: String, required: true, trim: true },
    buyerPhone: { type: String, trim: true },
    lines: { type: [hpSaleLineSchema], required: true },
    subtotal: moneyField,
    discount: { ...moneyField, default: 0 },
    total: moneyField,
    totalCost: moneyField,
    profit: { type: Number, required: true },
    channel: { type: String, enum: CHANNELS, default: 'cash' },
    soldById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    idempotencyKey: { type: String },
    status: { type: String, enum: ['completed', 'voided'], default: 'completed' },
    voidedAt: { type: Date },
    voidedById: { type: Schema.Types.ObjectId, ref: 'User' },
    voidReason: { type: String, trim: true },
  },
  { timestamps: true },
);

hpSaleSchema.index({ createdAt: -1 });
hpSaleSchema.index({ customerId: 1, createdAt: -1 });
hpSaleSchema.index({ status: 1, createdAt: -1 });
hpSaleSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const HpSaleModel = model<HpSale>('HpSale', hpSaleSchema, 'hp-sales');

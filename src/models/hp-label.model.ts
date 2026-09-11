import { Schema, model, type Types } from 'mongoose';

/**
 * The two labels an inventory item carries besides its name: who makes it and
 * what kind of thing it is. Managed rather than typed free — "Nasco", "NASCO"
 * and "Nasco Ghana" on three fridges is not three brands, and a shelf that
 * cannot be grouped by brand is not much of a shelf. Each label is one row
 * here, and an item points at it by id, so a rename reaches every item.
 */
export const HP_LABEL_KINDS = ['brand', 'category'] as const;
export type HpLabelKind = (typeof HP_LABEL_KINDS)[number];

export interface HpLabel {
  _id: Types.ObjectId;
  kind: HpLabelKind;
  name: string;
  /** `name` lowercased and squeezed, so "Nasco" and "NASCO" collide on the index. */
  nameKey: string;
  description?: string;
  createdById: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/** The form a name is compared in: letters and digits, lowercased. */
export function labelKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const hpLabelSchema = new Schema<HpLabel>(
  {
    kind: { type: String, enum: HP_LABEL_KINDS, required: true },
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true },
    description: { type: String, trim: true },
    createdById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

hpLabelSchema.index({ kind: 1, nameKey: 1 }, { unique: true });

export const HpLabelModel = model<HpLabel>('HpLabel', hpLabelSchema, 'hp-labels');

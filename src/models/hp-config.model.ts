import { Schema, model, type Types } from 'mongoose';

/**
 * Singleton — admin-configurable HP settings (HP guide: the interest rate
 * is not fixed; the admin changes it in-app). The interest METHOD (flat vs
 * declining balance) is an open client question — until it's answered, the
 * rate is stored and snapshotted onto agreements but no schedule math uses it.
 */
export interface HpConfig {
  _id: Types.ObjectId;
  interestRatePercent: number;
  updatedById?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const hpConfigSchema = new Schema<HpConfig>(
  {
    interestRatePercent: { type: Number, required: true, min: 0, max: 100 },
    updatedById: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const HpConfigModel = model<HpConfig>('HpConfig', hpConfigSchema, 'hp-config');

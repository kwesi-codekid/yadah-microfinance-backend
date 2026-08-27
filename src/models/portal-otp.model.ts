import { Schema, model, type Types } from 'mongoose';

/**
 * One active login OTP per customer, mirroring auth-otps for staff. Only the
 * SHA-256 hash of the code is stored; documents self-delete at expiresAt via
 * the TTL index.
 *
 * Kept separate from auth-otps rather than made polymorphic: a customer and a
 * staff member can share a phone number (a collector who is also a customer),
 * and a login code for one must never satisfy the other.
 */
export interface PortalOtp {
  _id: Types.ObjectId;
  customerId: Types.ObjectId;
  phone: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  lastSentAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const portalOtpSchema = new Schema<PortalOtp>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, unique: true },
    phone: { type: String, required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    lastSentAt: { type: Date, required: true },
  },
  { timestamps: true },
);

portalOtpSchema.index({ phone: 1 });
portalOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PortalOtpModel = model<PortalOtp>('PortalOtp', portalOtpSchema, 'portal-otps');

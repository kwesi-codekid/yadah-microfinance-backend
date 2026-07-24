import { Schema, model, type Types } from 'mongoose';

/**
 * One active login OTP per user. Only the SHA-256 hash of the code is
 * stored; documents self-delete at expiresAt via TTL index.
 */
export interface AuthOtp {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  phone: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  lastSentAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const authOtpSchema = new Schema<AuthOtp>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    phone: { type: String, required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    lastSentAt: { type: Date, required: true },
  },
  { timestamps: true },
);

authOtpSchema.index({ phone: 1 });
authOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthOtpModel = model<AuthOtp>('AuthOtp', authOtpSchema, 'auth-otps');

import { Schema, model, type Types } from 'mongoose';

/**
 * A customer's refresh-token family for the portal.
 *
 * Deliberately its own collection rather than an array on the customer, the
 * way staff sessions live on the user: customer documents are returned by
 * listing endpoints and rendered on office screens, and a token hash must
 * never ride along in one of those payloads by accident.
 *
 * Expired documents self-delete via the TTL index.
 */
export interface PortalSession {
  _id: Types.ObjectId;
  customerId: Types.ObjectId;
  /** Rotation family: survives each refresh, dies on reuse detection. */
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const portalSessionSchema = new Schema<PortalSession>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    familyId: { type: String, required: true, unique: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

portalSessionSchema.index({ customerId: 1, createdAt: -1 });
portalSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PortalSessionModel = model<PortalSession>(
  'PortalSession',
  portalSessionSchema,
  'portal-sessions',
);

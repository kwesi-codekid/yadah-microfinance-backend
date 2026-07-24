import { Schema, model, type Types } from 'mongoose';
import { optionalMoneyField } from './shared.js';

/**
 * Append-only record of every mutating money action (rule 3): who did what
 * to which entity, with before/after amounts. Never updated, never deleted.
 */
export interface AuditLog {
  _id: Types.ObjectId;
  actorId: Types.ObjectId;
  action: string; // e.g. "susu.deposit.record", "loan.repayment.record"
  entityType: string; // e.g. "susu-account"
  entityId: Types.ObjectId;
  amountBefore?: number; // pesewas
  amountAfter?: number; // pesewas
  before?: unknown; // snapshot of changed fields
  after?: unknown;
  requestId?: string;
  createdAt: Date;
}

const auditLogSchema = new Schema<AuditLog>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    amountBefore: optionalMoneyField,
    amountAfter: optionalMoneyField,
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    requestId: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });

export const AuditLogModel = model<AuditLog>('AuditLog', auditLogSchema, 'audit-logs');

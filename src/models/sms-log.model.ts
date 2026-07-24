import { Schema, model, type Types } from 'mongoose';

/**
 * Queue + monthly-cap counter, NOT a delivery log — the smsonlinegh
 * dashboard is the permanent record of sends/deliveries. Documents drive
 * the fire-and-forget retry worker ('queued' rows survive restarts) and
 * back the 3,000/month cap check via monthKey. TTL-deleted after 60 days.
 */
export interface SmsLog {
  _id: Types.ObjectId;
  to: string;
  template: string;
  message: string;
  status: 'queued' | 'sent' | 'failed';
  attempts: number;
  monthKey: string; // "YYYY-MM", Accra time
  relatedEntityType?: string;
  relatedEntityId?: Types.ObjectId;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const smsLogSchema = new Schema<SmsLog>(
  {
    to: { type: String, required: true },
    template: { type: String, required: true },
    message: { type: String, required: true },
    status: { type: String, enum: ['queued', 'sent', 'failed'], default: 'queued' },
    attempts: { type: Number, default: 0 },
    monthKey: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    relatedEntityType: { type: String },
    relatedEntityId: { type: Schema.Types.ObjectId },
    lastError: { type: String },
  },
  { timestamps: true },
);

smsLogSchema.index({ monthKey: 1, status: 1 }); // monthly cap counting
smsLogSchema.index({ status: 1, createdAt: 1 }); // queue worker scans
smsLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 }); // 60-day TTL

export const SmsLogModel = model<SmsLog>('SmsLog', smsLogSchema, 'sms-logs');

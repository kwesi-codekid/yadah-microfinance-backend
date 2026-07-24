import { Schema, model, type Types } from 'mongoose';

/**
 * Every SMS attempt is logged and counted against the 3,000/month cap.
 * monthKey (e.g. "2026-07") backs the cap counter. SMS is fire-and-forget:
 * failures here must never affect the money transaction they announce.
 */
export interface SmsLog {
  _id: Types.ObjectId;
  to: string;
  template: string;
  message: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed';
  attempts: number;
  monthKey: string; // "YYYY-MM", Accra time
  relatedEntityType?: string;
  relatedEntityId?: Types.ObjectId;
  lastError?: string;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const smsLogSchema = new Schema<SmsLog>(
  {
    to: { type: String, required: true },
    template: { type: String, required: true },
    message: { type: String, required: true },
    status: { type: String, enum: ['queued', 'sent', 'delivered', 'failed'], default: 'queued' },
    attempts: { type: Number, default: 0 },
    monthKey: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    relatedEntityType: { type: String },
    relatedEntityId: { type: Schema.Types.ObjectId },
    lastError: { type: String },
    sentAt: { type: Date },
  },
  { timestamps: true },
);

smsLogSchema.index({ monthKey: 1, status: 1 }); // monthly cap counting
smsLogSchema.index({ status: 1, createdAt: 1 }); // queue worker scans

export const SmsLogModel = model<SmsLog>('SmsLog', smsLogSchema, 'sms-logs');

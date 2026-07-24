import type { HydratedDocument, Types } from 'mongoose';
import { env } from '../config/env.js';
import { SmsLogModel, type SmsLog } from '../models/index.js';
import { accraMonthKey } from './time.js';
import { logger } from './logger.js';

const MAX_ATTEMPTS = 5;
/** A login OTP older than this must never be delivered late. */
const OTP_FRESHNESS_MS = 10 * 60 * 1000;
const GATEWAY_URL = 'https://api.smsonlinegh.com/v5/message/sms/send';

interface GatewayResult {
  ok: boolean;
  error?: string;
}

async function callGateway(to: string, text: string): Promise<GatewayResult> {
  if (env.SMS_API_KEY === '') return { ok: false, error: 'SMS_API_KEY not configured' };
  try {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `key ${env.SMS_API_KEY}`,
      },
      body: JSON.stringify({ text, type: 0, sender: env.SMS_SENDER_ID, destinations: [to] }),
    });
    const data = (await res.json().catch(() => null)) as {
      handshake?: { id?: number; label?: string };
    } | null;
    const label = data?.handshake?.label;
    if (res.ok && label === 'HSHK_OK') return { ok: true };
    return { ok: false, error: label ?? `HTTP ${String(res.status)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network error' };
  }
}

async function attemptSend(doc: HydratedDocument<SmsLog>): Promise<void> {
  if (doc.template === 'login-otp' && Date.now() - doc.createdAt.getTime() > OTP_FRESHNESS_MS) {
    doc.status = 'failed';
    doc.lastError = 'expired before send';
    await doc.save();
    return;
  }

  doc.attempts += 1;
  const result = await callGateway(doc.to, doc.message);
  if (result.ok) {
    doc.status = 'sent';
  } else {
    doc.status = doc.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
    doc.lastError = result.error ?? 'unknown error';
    logger.warn(
      { to: doc.to, template: doc.template, attempts: doc.attempts, error: doc.lastError },
      'sms send failed',
    );
  }
  await doc.save();
}

export interface EnqueueSmsOptions {
  to: string;
  template: string;
  message: string;
  relatedEntityType?: string;
  relatedEntityId?: Types.ObjectId;
}

/**
 * Fire-and-forget (rule 8): persists the message, then attempts delivery in
 * the background. Never throws into the caller — a gateway failure must not
 * fail the flow that triggered the SMS. Undelivered messages are retried by
 * the worker until MAX_ATTEMPTS.
 */
export async function enqueueSms(opts: EnqueueSmsOptions): Promise<void> {
  const doc = await SmsLogModel.create({ ...opts, status: 'queued', monthKey: accraMonthKey() });
  attemptSend(doc).catch((err: unknown) => {
    logger.warn({ err, to: opts.to }, 'sms immediate attempt errored');
  });
}

/** Retries everything still queued, oldest first. */
export async function drainSmsQueue(limit = 20): Promise<void> {
  const docs = await SmsLogModel.find({ status: 'queued', attempts: { $lt: MAX_ATTEMPTS } })
    .sort({ createdAt: 1 })
    .limit(limit);
  for (const doc of docs) {
    await attemptSend(doc);
  }
}

let workerTimer: NodeJS.Timeout | null = null;

export function startSmsWorker(intervalMs = 60_000): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    drainSmsQueue().catch((err: unknown) => {
      logger.warn({ err }, 'sms worker pass errored');
    });
  }, intervalMs);
  workerTimer.unref();
}

export function stopSmsWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

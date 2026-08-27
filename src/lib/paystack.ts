import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from './errors.js';

/**
 * Thin Paystack Charge API client — plain fetch, no SDK. Amounts are pesewas,
 * which map 1:1 to Paystack's GHS subunit. Ghana mobile money charges are
 * `pay_offline`: the customer approves a prompt on their handset and Paystack
 * reports the outcome on the charge.success webhook.
 */

const BASE_URL = 'https://api.paystack.co';
const TIMEOUT_MS = 15_000;

export const MOMO_PROVIDERS = ['mtn', 'vod', 'atl'] as const;
export type MomoProvider = (typeof MOMO_PROVIDERS)[number];

export function assertPaymentsConfigured(): void {
  if (!env.PAYSTACK_SECRET_KEY) {
    throw new AppError('PAYMENTS_NOT_CONFIGURED', 'Paystack is not configured', 503);
  }
}

interface PaystackResponse {
  status: boolean;
  message?: string;
  data?: {
    status?: string;
    reference?: string;
    display_text?: string;
    amount?: number;
    currency?: string;
    // Transfer endpoints (money out) return these instead.
    recipient_code?: string;
    transfer_code?: string;
  };
}

async function call(path: string, init: RequestInit): Promise<PaystackResponse> {
  assertPaymentsConfigured();
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AppError('PAYSTACK_ERROR', 'Could not reach Paystack — try again', 502);
  }
  const body = (await res.json().catch(() => null)) as PaystackResponse | null;
  if (!body || (!res.ok && !body.status)) {
    throw new AppError('PAYSTACK_ERROR', body?.message ?? 'Paystack rejected the request', 502, {
      httpStatus: res.status,
    });
  }
  return body;
}

export interface ChargeInitiation {
  paystackStatus: string;
  displayText: string | null;
}

/** Start a mobile-money charge; the outcome arrives via webhook. */
export async function initiateCharge(args: {
  email: string;
  amount: number; // pesewas
  reference: string;
  phone: string;
  provider: MomoProvider;
}): Promise<ChargeInitiation> {
  const body = await call('/charge', {
    method: 'POST',
    body: JSON.stringify({
      email: args.email,
      amount: args.amount,
      currency: 'GHS',
      reference: args.reference,
      mobile_money: { phone: args.phone, provider: args.provider },
    }),
  });
  return {
    paystackStatus: body.data?.status ?? 'unknown',
    displayText: body.data?.display_text ?? null,
  };
}

export interface VerificationResult {
  paystackStatus: string;
  amount: number | null;
  currency: string | null;
}

/** Fallback for missed webhooks: ask Paystack for the charge outcome. */
export async function verifyTransaction(reference: string): Promise<VerificationResult> {
  const body = await call(`/transaction/verify/${encodeURIComponent(reference)}`, {
    method: 'GET',
  });
  return {
    paystackStatus: body.data?.status ?? 'unknown',
    amount: body.data?.amount ?? null,
    currency: body.data?.currency ?? null,
  };
}

/** HMAC-SHA512 of the raw webhook body, compared in constant time. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!env.PAYSTACK_SECRET_KEY || !signature) return false;
  const expected = createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
  const got = Buffer.from(signature, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return got.length === want.length && timingSafeEqual(got, want);
}

// ------------------------------------------------------------------ transfers

/**
 * Paystack Transfers — money OUT to a customer's mobile wallet.
 *
 * The opposite direction from the charge API above, and a different shape: a
 * recipient is created once per (phone, provider), then transfers are pushed
 * to its code. Paystack settles asynchronously, so the outcome arrives on the
 * transfer.success / transfer.failed / transfer.reversed webhooks — never
 * treat a 200 here as money delivered.
 *
 * Requires the Paystack account to be enabled for transfers, with a funded
 * balance and a secret key that carries transfer permissions.
 */

/** Paystack's bank codes for Ghanaian mobile money wallets. */
const MOMO_BANK_CODE: Record<MomoProvider, string> = {
  mtn: 'MTN',
  vod: 'VOD',
  atl: 'ATL',
};

/**
 * Create (or re-fetch) a transfer recipient for a mobile wallet. Paystack is
 * idempotent on (type, account_number, bank_code) and returns the existing
 * recipient code rather than duplicating it.
 */
export async function createTransferRecipient(args: {
  name: string;
  phone: string;
  provider: MomoProvider;
}): Promise<string> {
  const body = await call('/transferrecipient', {
    method: 'POST',
    body: JSON.stringify({
      type: 'mobile_money',
      name: args.name,
      account_number: args.phone,
      bank_code: MOMO_BANK_CODE[args.provider],
      currency: 'GHS',
    }),
  });

  const code = body.data?.recipient_code;
  if (!code) {
    throw new AppError('PAYSTACK_ERROR', 'Paystack did not return a recipient code', 502);
  }
  return code;
}

export interface TransferInitiation {
  transferCode: string;
  reference: string;
  /** Paystack's view: usually 'pending' or 'otp' when 2FA is on the account. */
  paystackStatus: string;
}

/**
 * Push money to a recipient. `reference` is ours and must be unique — Paystack
 * rejects a duplicate, which is what makes a retried approval safe.
 */
export async function initiateTransfer(args: {
  recipientCode: string;
  amount: number; // pesewas
  reference: string;
  reason: string;
}): Promise<TransferInitiation> {
  const body = await call('/transfer', {
    method: 'POST',
    body: JSON.stringify({
      source: 'balance',
      amount: args.amount,
      recipient: args.recipientCode,
      reference: args.reference,
      reason: args.reason,
      currency: 'GHS',
    }),
  });

  const transferCode = body.data?.transfer_code;
  if (!transferCode) {
    throw new AppError('PAYSTACK_ERROR', 'Paystack did not return a transfer code', 502);
  }
  return {
    transferCode,
    reference: body.data?.reference ?? args.reference,
    paystackStatus: body.data?.status ?? 'pending',
  };
}

/** Ask Paystack directly about a transfer — the fallback for a missed webhook. */
export async function fetchTransfer(reference: string): Promise<{ paystackStatus: string }> {
  const body = await call(`/transfer/verify/${encodeURIComponent(reference)}`, {
    method: 'GET',
  });
  return { paystackStatus: body.data?.status ?? 'unknown' };
}

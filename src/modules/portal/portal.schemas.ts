import { z } from 'zod';
import { PAYOUT_REQUEST_KINDS, PAYOUT_REQUEST_STATUSES } from '../../models/index.js';
import { ghanaPhone, objectId, pagination, positiveMoneyPesewas } from '../../schemas/common.js';

export const otpRequestBody = z.object({ phone: ghanaPhone });
export type OtpRequestBody = z.infer<typeof otpRequestBody>;

export const otpVerifyBody = z.object({
  phone: ghanaPhone,
  code: z.string().regex(/^\d{6}$/, 'Expected the 6-digit code from the SMS'),
});
export type OtpVerifyBody = z.infer<typeof otpVerifyBody>;

export const refreshBody = z.object({ refreshToken: z.string().min(10) });
export type RefreshBody = z.infer<typeof refreshBody>;

/**
 * A withdrawal request. `amount` is required for savings and susu partial
 * withdrawals and rejected for a closure, where the payout is the whole
 * balance less commission and is not the customer's to choose.
 */
export const createRequestBody = z
  .object({
    kind: z.enum(PAYOUT_REQUEST_KINDS),
    targetId: objectId,
    amount: positiveMoneyPesewas.optional(),
    /** Defaults to the customer's registered number when omitted. */
    payoutPhone: ghanaPhone.optional(),
    payoutProvider: z.enum(['mtn', 'vod', 'atl']),
  })
  .check((ctx) => {
    const { kind, amount } = ctx.value;
    if (kind === 'susu-closure' && amount !== undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'A closure pays the whole balance less commission — do not send an amount',
        path: ['amount'],
        input: amount,
      });
    }
    if (kind !== 'susu-closure' && amount === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'Specify how much to withdraw',
        path: ['amount'],
        input: amount,
      });
    }
  });
export type CreateRequestBody = z.infer<typeof createRequestBody>;

export const listRequestsQuery = pagination.extend({
  status: z.enum(PAYOUT_REQUEST_STATUSES).optional(),
});
export type ListRequestsQuery = z.infer<typeof listRequestsQuery>;

export const requestIdParams = z.object({ id: objectId });
export type RequestIdParams = z.infer<typeof requestIdParams>;

export const rejectRequestBody = z.object({
  reason: z.string().min(3).max(300).trim(),
});
export type RejectRequestBody = z.infer<typeof rejectRequestBody>;

/** Portal charge: the customer pays into one of their OWN accounts. */
export const portalChargeBody = z.object({
  kind: z.enum(['susu-deposit', 'savings-deposit', 'loan-repayment']),
  targetId: objectId,
  amount: positiveMoneyPesewas,
  phone: ghanaPhone,
  provider: z.enum(['mtn', 'vod', 'atl']),
});
export type PortalChargeBody = z.infer<typeof portalChargeBody>;

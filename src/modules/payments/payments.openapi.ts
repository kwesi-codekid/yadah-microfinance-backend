import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import { chargeBody } from './payments.schemas.js';

const charge = z
  .object({
    reference: z.string().describe('Server-generated, unique — poll with it'),
    status: z.enum(['pending', 'success', 'failed']).describe('Paystack’s view of the money'),
    executionStatus: z
      .enum(['pending', 'applied', 'failed'])
      .describe('Whether the paid amount has been applied to the target record'),
    kind: z.enum([
      'susu-deposit',
      'savings-deposit',
      'loan-repayment',
      'hp-deposit',
      'hp-installment',
      'hp-redemption',
    ]),
    targetId: z.string(),
    customerId: z.string(),
    amount: z.number().int().describe('Pesewas'),
    phone: z.string(),
    provider: z.enum(['mtn', 'vod', 'atl']),
    displayText: z.string().optional().describe('Paystack instruction to show the customer'),
    failureReason: z.string().optional(),
    resultRecordId: z
      .string()
      .optional()
      .describe('The deposit/txn/repayment created when applied'),
    createdAt: z.iso.datetime(),
    executedAt: z.iso.datetime().optional(),
  })
  .meta({ id: 'PaystackCharge' });

const chargeResult = z.object({ charge });
const security = [{ bearerAuth: [] }];
const referenceParam = z.object({ reference: z.string() });

export const paymentPaths: ZodOpenApiPathsObject = {
  '/payments/charges': {
    post: {
      tags: ['Payments'],
      summary: 'Charge a customer’s mobile-money wallet via Paystack',
      description:
        'Validates the target first (susu multiples, savings minimum, loan/HP state), ' +
        'then initiates a Paystack Charge (pay_offline: the customer approves the ' +
        'prompt on their handset). The money is applied to the target when Paystack ' +
        'confirms payment — via webhook or POST /payments/charges/{reference}/verify — ' +
        'through the same audited, idempotent paths cash uses, with channel ' +
        '`paystack`. Loan and hire purchase charges are office only; hp-redemption ' +
        'omits `amount` (always the full remaining balance). Poll ' +
        'GET /payments/charges/{reference} for status.',
      security,
      requestBody: jsonBody(chargeBody),
      responses: {
        '201': jsonResponse('Charge initiated', chargeResult),
        '403': errorResponse('FORBIDDEN — loan/HP charges are office only'),
        '404': errorResponse('NOT_FOUND — target or customer'),
        '422': errorResponse(
          'ACCOUNT_NOT_ACTIVE, AMOUNT_MISMATCH, EXCEEDS_REMAINING, AMOUNT_TOO_SMALL, ' +
            'LOAN_NOT_OPEN, EXCEEDS_BALANCE, AGREEMENT_NOT_PENDING, DEPOSIT_MISMATCH, ' +
            'AGREEMENT_NOT_OPEN, NOT_REDEEMABLE, or NOTHING_TO_REDEEM',
        ),
        '502': errorResponse('PAYSTACK_ERROR — Paystack unreachable or rejected the charge'),
        '503': errorResponse('PAYMENTS_NOT_CONFIGURED'),
      },
    },
  },
  '/payments/charges/{reference}': {
    get: {
      tags: ['Payments'],
      summary: 'Charge status (poll after initiating)',
      security,
      requestParams: { path: referenceParam },
      responses: {
        '200': jsonResponse('Current status', chargeResult),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/payments/charges/{reference}/verify': {
    post: {
      tags: ['Payments'],
      summary: 'Verify with Paystack and apply (missed-webhook fallback)',
      description:
        'Asks Paystack for the charge outcome and applies it if paid. Safe to call ' +
        'repeatedly — application is idempotent.',
      security,
      requestParams: { path: referenceParam },
      responses: {
        '200': jsonResponse('Verified (see status fields)', chargeResult),
        '404': errorResponse('NOT_FOUND'),
        '502': errorResponse('PAYSTACK_ERROR'),
        '503': errorResponse('PAYMENTS_NOT_CONFIGURED'),
      },
    },
  },
  '/payments/paystack/webhook': {
    post: {
      tags: ['Payments'],
      summary: 'Paystack webhook (Paystack calls this — not for clients)',
      description:
        'Unauthenticated but HMAC-SHA512-signed (x-paystack-signature over the raw ' +
        'body). charge.success events apply the paid amount to the target. Retries ' +
        'are safe: application is deduplicated by charge state and idempotency key. ' +
        'A paid charge whose target state changed becomes executionStatus=failed ' +
        'for the office to resolve — the endpoint still answers 200 so Paystack ' +
        'does not retry forever.',
      responses: {
        '200': jsonResponse('Acknowledged', z.object({ received: z.boolean() })),
        '400': errorResponse('BAD_REQUEST — not raw JSON'),
        '401': errorResponse('BAD_SIGNATURE'),
      },
    },
  },
};

import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { PAYOUT_REQUEST_KINDS, PAYOUT_REQUEST_STATUSES } from '../../models/index.js';
import { errorResponse, jsonResponse } from '../../openapi/shared.js';
import {
  createRequestBody,
  listRequestsQuery,
  otpRequestBody,
  otpVerifyBody,
  portalChargeBody,
  refreshBody,
  rejectRequestBody,
} from './portal.schemas.js';

/**
 * The portal uses its own bearer scheme in the spec so the docs never suggest
 * a staff token works here — the two are signed with different keys.
 */
const portalSecurity = [{ portalAuth: [] }];
const staffSecurity = [{ bearerAuth: [] }];
const tags = ['Customer Portal'];
const officeTags = ['Payout Requests'];

const tokens = z.object({
  accessToken: z.string().describe('Bearer token for /portal routes. Expires in 15 minutes.'),
  refreshToken: z.string().describe('Opaque, rotated on every refresh. Valid 30 days.'),
});

const profile = z
  .object({
    id: z.string(),
    fullName: z.string(),
    phone: z.string(),
    photoUrl: z.string().optional(),
    status: z.string(),
  })
  .meta({ id: 'PortalProfile' });

const portalAccounts = z
  .object({
    susu: z.array(
      z.object({
        accountId: z.string(),
        accountNumber: z
          .string()
          .describe(
            "The customer's susu number — shared by every book they hold, so two " +
              'cycles in one month carry the same string. Not an identifier.',
          ),
        cycleMonth: z.string().optional().describe('The month this book is called'),
        ref: z.string().describe('The book itself, rendered: 260912134501-a3f9. Always distinct'),
        status: z.string(),
        dailyAmount: z.number().int(),
        depositsCount: z.number().int(),
        cycleLength: z.number().int().describe('Always 31'),
        daysRemaining: z.number().int(),
        totalDeposited: z.number().int(),
        withdrawnAmount: z.number().int(),
        balance: z.number().int(),
        maxPartialWithdrawal: z
          .number()
          .int()
          .describe('Most that can be taken with the account left open — one day stays reserved'),
        closurePreview: z.object({
          commission: z.number().int().describe("Exactly one day's deposit"),
          payout: z.number().int(),
        }),
      }),
    ),
    savings: z.array(
      z.object({
        accountId: z.string(),
        accountNumber: z.string(),
        accountType: z.string(),
        status: z.string(),
        balance: z.number().int(),
        available: z
          .number()
          .int()
          .describe('balance − the minimum balance − the GHS 10 fee, floored at zero'),
        minBalance: z.number().int(),
        withdrawalFee: z.number().int(),
      }),
    ),
    loans: z.array(z.unknown()),
    hirePurchase: z.array(z.unknown()),
    totals: z.object({
      saved: z.number().int().describe('Open susu + savings balances'),
      owed: z.number().int().describe('Open loan + hire purchase balances'),
    }),
  })
  .meta({ id: 'PortalAccounts' });

const payoutRequest = z
  .object({
    id: z.string(),
    customerId: z.string(),
    customerName: z.string().optional().describe('Office responses only'),
    kind: z.enum(PAYOUT_REQUEST_KINDS),
    targetId: z.string(),
    amount: z.number().int().nullable().describe('Null for a closure — the payout is computed'),
    status: z.enum(PAYOUT_REQUEST_STATUSES),
    payoutPhone: z.string(),
    payoutProvider: z.string(),
    netAmount: z
      .number()
      .int()
      .nullable()
      .describe('What actually left the account, after commission or fee. Set on approval.'),
    rejectionReason: z.string().optional(),
    paystackStatus: z.string().optional(),
    failureReason: z.string().optional(),
    reviewedAt: z.iso.datetime().optional(),
    paidAt: z.iso.datetime().optional(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'PayoutRequest' });

export const portalPaths: ZodOpenApiPathsObject = {
  '/portal/auth/otp/request': {
    post: {
      tags,
      summary: 'Send a login code to a registered customer phone',
      description:
        'Any ACTIVE customer can log in on the number already on their record — there is ' +
        'no separate enrolment step.\n\n' +
        'Always returns 202, whether or not the number belongs to a customer: a different ' +
        'response would turn this into a way to discover who banks here. One code at a ' +
        'time, valid 5 minutes, 5 attempts, one resend per minute.',
      requestBody: { content: { 'application/json': { schema: otpRequestBody } } },
      responses: {
        '202': jsonResponse(
          'Code sent if the number is registered',
          z.object({ sent: z.boolean() }),
        ),
        '429': errorResponse('Asked again within the resend cooldown'),
      },
    },
  },
  '/portal/auth/otp/verify': {
    post: {
      tags,
      summary: 'Exchange the code for portal tokens',
      description:
        'A wrong code and an unknown number return the SAME error, so the endpoint cannot ' +
        'be used to enumerate customers. The code is single-use.',
      requestBody: { content: { 'application/json': { schema: otpVerifyBody } } },
      responses: {
        '200': jsonResponse('Signed in', z.object({ tokens, customer: profile })),
        '401': errorResponse('Code incorrect or expired'),
        '429': errorResponse('Too many attempts — request a new code'),
      },
    },
  },
  '/portal/auth/refresh': {
    post: {
      tags,
      summary: 'Rotate the portal session',
      description:
        'Refresh tokens rotate on every use. Replaying an old one revokes the whole ' +
        'session family, on the assumption it was stolen.',
      requestBody: { content: { 'application/json': { schema: refreshBody } } },
      responses: {
        '200': jsonResponse('New token pair', tokens),
        '401': errorResponse('Invalid, expired, or replayed'),
      },
    },
  },
  '/portal/auth/logout': {
    post: {
      tags,
      summary: 'End this portal session',
      requestBody: { content: { 'application/json': { schema: refreshBody } } },
      responses: { '204': { description: 'Signed out' } },
    },
  },
  '/portal/me': {
    get: {
      tags,
      summary: 'The signed-in customer',
      security: portalSecurity,
      responses: { '200': jsonResponse('Profile', z.object({ customer: profile })) },
    },
  },
  '/portal/accounts': {
    get: {
      tags,
      summary: 'Every product the customer holds, with figures already derived',
      description:
        'Susu cycles, savings, loans and hire purchase in one call, including the values a ' +
        'handset should not have to compute: available savings balance, the most that can ' +
        'be withdrawn from a susu account without closing it, and what closing would pay.\n\n' +
        'The customer is taken from the TOKEN, never a parameter. Closed and settled ' +
        'records are included so history stays visible — filter on `status`.',
      security: portalSecurity,
      responses: { '200': jsonResponse('Accounts', portalAccounts) },
    },
  },
  '/portal/transactions': {
    get: {
      tags,
      summary: "The customer's own transaction history",
      description:
        'The unified feed, scoped to the signed-in customer. Unapplied mobile money shows ' +
        'with `status: "pending"` and is excluded from `totals`.',
      security: portalSecurity,
      responses: { '200': jsonResponse('Transactions', z.unknown()) },
    },
  },
  '/portal/statement': {
    get: {
      tags,
      summary: 'Statement of account over a date range',
      security: portalSecurity,
      responses: { '200': jsonResponse('Statement', z.unknown()) },
    },
  },
  '/portal/payments/charges': {
    post: {
      tags,
      summary: 'Pay into your own account by mobile money',
      description:
        "Starts a Paystack charge against one of the CUSTOMER'S OWN accounts — ownership " +
        "is the whole authorisation, and another customer's account id returns 404 rather " +
        'than 403 so the portal never confirms it exists.\n\n' +
        'Money is recorded only when the charge.success webhook confirms it, never here. ' +
        'Loan and hire-purchase targets are rejected: those are office-collected.',
      security: portalSecurity,
      requestBody: { content: { 'application/json': { schema: portalChargeBody } } },
      responses: {
        '201': jsonResponse('Charge started', z.object({ charge: z.unknown() })),
        '404': errorResponse('Account not found or not yours'),
      },
    },
  },
  '/portal/payments/charges/{reference}': {
    get: {
      tags,
      summary: 'Poll a charge you started',
      security: portalSecurity,
      responses: { '200': jsonResponse('Charge', z.object({ charge: z.unknown() })) },
    },
  },
  '/portal/requests': {
    post: {
      tags,
      summary: 'Request a withdrawal',
      description:
        'Submits a request for an office decision — **it never moves money by itself**. ' +
        'Withdrawals stay office-only; approval runs the same service a counter ' +
        'transaction would, so the susu closing commission, the GHS 10 savings fee, the ' +
        'one-withdrawal-per-day rule and the minimum balance all still apply.\n\n' +
        'The same limits are checked here at submission, so a customer is told what they ' +
        'can take now rather than after waiting for a rejection. One open request per ' +
        'account. `amount` is required except for `susu-closure`, where the payout is the ' +
        "whole balance less commission and is not the customer's to choose.",
      security: portalSecurity,
      requestBody: { content: { 'application/json': { schema: createRequestBody } } },
      responses: {
        '201': jsonResponse('Request submitted', z.object({ request: payoutRequest })),
        '409': errorResponse('A request on this account is already pending'),
        '422': errorResponse('More than the account allows'),
      },
    },
    get: {
      tags,
      summary: 'Your withdrawal requests',
      security: portalSecurity,
      requestParams: { query: listRequestsQuery },
      responses: { '200': jsonResponse('Requests', z.object({ items: z.array(payoutRequest) })) },
    },
  },
  '/payout-requests': {
    get: {
      tags: officeTags,
      summary: 'Customer withdrawal requests awaiting a decision',
      security: staffSecurity,
      requestParams: { query: listRequestsQuery },
      responses: { '200': jsonResponse('Requests', z.object({ items: z.array(payoutRequest) })) },
    },
  },
  '/payout-requests/{id}': {
    get: {
      tags: officeTags,
      summary: 'One request',
      security: staffSecurity,
      responses: { '200': jsonResponse('Request', z.object({ request: payoutRequest })) },
    },
  },
  '/payout-requests/{id}/approve': {
    post: {
      tags: officeTags,
      summary: 'Approve: execute the withdrawal, then send the money',
      description:
        '**Order matters and is deliberate.** The withdrawal executes first through the ' +
        'ordinary office service, so the ledger write is committed before any external ' +
        'call. Only then does the Paystack transfer go out.\n\n' +
        'The consequence: if the transfer later fails the account is ALREADY DEBITED and ' +
        'the request moves to `failed` as an operational alert — it is never auto-reversed, ' +
        "because re-crediting an account on a webhook's word is not something this system " +
        'does. The office retries the payout or pays cash.\n\n' +
        'Requires Paystack transfers to be enabled on the account with a funded balance.',
      security: staffSecurity,
      responses: {
        '200': jsonResponse('Approved', z.object({ request: payoutRequest })),
        '409': errorResponse('Already decided'),
        '503': errorResponse('Paystack is not configured'),
      },
    },
  },
  '/payout-requests/{id}/reject': {
    post: {
      tags: officeTags,
      summary: 'Decline a request — nothing moves',
      security: staffSecurity,
      requestBody: { content: { 'application/json': { schema: rejectRequestBody } } },
      responses: { '200': jsonResponse('Rejected', z.object({ request: payoutRequest })) },
    },
  },
  '/payout-requests/{id}/verify-transfer': {
    post: {
      tags: officeTags,
      summary: 'Fallback when a transfer webhook was missed',
      description: 'Asks Paystack directly and applies the outcome, like the charge fallback.',
      security: staffSecurity,
      responses: { '200': jsonResponse('Refreshed', z.object({ request: payoutRequest })) },
    },
  },
};

import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import {
  applyBody,
  listLoansQuery,
  putConfigBody,
  rejectBody,
  repayBody,
  susuRepayBody,
} from './loans.schemas.js';

const publicLoan = z
  .object({
    id: z.string(),
    customerId: z.string(),
    customerName: z.string().optional().describe('On list responses'),
    tier: z.enum(['small', 'big']),
    principal: z.number().int().describe('Pesewas, immutable'),
    durationMonths: z.number().int(),
    ratePercent: z.number().int().describe('Current rate — moves up the ladder on escalation'),
    interestAmount: z.number().int(),
    totalDue: z.number().int().describe('principal + interest at the CURRENT rate'),
    totalRepaid: z.number().int(),
    remaining: z.number().int(),
    status: z.enum(['pending', 'active', 'repaid', 'rejected', 'arrears']),
    frozen: z.boolean().describe('True once escalation is exhausted'),
    appliedAt: z.iso.datetime(),
    approvedAt: z.iso.datetime().optional(),
    dueDate: z.iso.datetime().optional(),
    escalatedAt: z.iso.datetime().optional(),
    closedAt: z.iso.datetime().optional(),
    repaidOnTime: z.boolean().optional().describe('Set at settlement; unlocks the big tier'),
    rejectionReason: z.string().optional(),
  })
  .meta({ id: 'Loan' });

const loanResult = z.object({ loan: publicLoan });
const repaymentResult = z.object({
  repayment: z.object({ id: z.string(), amount: z.number().int(), source: z.string() }),
  loan: publicLoan,
  replayed: z.boolean(),
  susuClosure: z
    .object({ accountId: z.string(), commission: z.number().int(), payout: z.number().int() })
    .optional(),
});
const security = [{ bearerAuth: [] }];
const idParam = z.object({ id: z.string().describe('Loan id') });

export const loanPaths: ZodOpenApiPathsObject = {
  '/loans/config': {
    get: {
      tags: ['Loans'],
      summary: 'Current tiers, rates, durations',
      security,
      responses: { '200': jsonResponse('Active config', z.object({ config: z.unknown() })) },
    },
    put: {
      tags: ['Loans'],
      summary: 'Update loan parameters (office)',
      description: 'Applies to NEW applications/approvals only; running loans are untouched.',
      security,
      requestBody: jsonBody(putConfigBody),
      responses: { '200': jsonResponse('Updated config', z.object({ config: z.unknown() })) },
    },
  },
  '/loans/eligibility/{customerId}': {
    get: {
      tags: ['Loans'],
      summary: 'History summary for the human loan decision',
      description:
        'The API summarizes ~4 months of susu/savings history; a human admin decides. ' +
        'No auto-approval exists.',
      security,
      requestParams: { path: z.object({ customerId: z.string() }) },
      responses: {
        '200': jsonResponse(
          'Summary',
          z.object({
            customer: z.object({ id: z.string(), fullName: z.string(), hasGhanaCard: z.boolean() }),
            firstActivityAt: z.iso.datetime().nullable(),
            monthsOfHistory: z.number().int(),
            susu: z.object({
              accounts: z.number(),
              activeAccounts: z.number(),
              totalDeposited: z.number(),
            }),
            savings: z.object({ accounts: z.number(), totalBalance: z.number() }),
            openLoan: publicLoan.nullable(),
            bigTierUnlocked: z.boolean(),
          }),
        ),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/loans/applications': {
    post: {
      tags: ['Loans'],
      summary: 'Apply for a loan (office records the application)',
      description:
        'Tiers: small 1,000–20,000, big to 50,000 GHS. Requires a Ghana Card on the ' +
        'profile. One open loan per customer — a second application is always ' +
        'refused. Big tier requires a previous small loan repaid on time.',
      security,
      requestBody: jsonBody(applyBody),
      responses: {
        '201': jsonResponse('Application recorded (pending)', loanResult),
        '409': errorResponse('LOAN_EXISTS — customer already has an open loan'),
        '422': errorResponse(
          'GHANA_CARD_REQUIRED, PRINCIPAL_OUT_OF_RANGE, BIG_TIER_LOCKED, or CUSTOMER_INACTIVE',
        ),
      },
    },
  },
  '/loans': {
    get: {
      tags: ['Loans'],
      summary: 'List loans',
      security,
      requestParams: { query: listLoansQuery },
      responses: {
        '200': jsonResponse(
          'Paginated loans',
          z.object({
            items: z.array(publicLoan),
            page: z.number(),
            limit: z.number(),
            total: z.number(),
          }),
        ),
      },
    },
  },
  '/loans/{id}': {
    get: {
      tags: ['Loans'],
      summary: 'Loan detail with schedule and repayment history',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse(
          'Detail',
          z.object({
            loan: publicLoan,
            schedule: z.array(
              z.object({
                installmentNumber: z.number().int(),
                dueDate: z.iso.datetime(),
                amountDue: z.number().int(),
                amountPaid: z.number().int(),
                status: z.string(),
              }),
            ),
            repayments: z.array(
              z.object({
                id: z.string(),
                amount: z.number().int(),
                source: z.string(),
                susuAccountId: z.string().optional(),
                recordedById: z.string(),
                createdAt: z.iso.datetime(),
              }),
            ),
          }),
        ),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/loans/{id}/approve': {
    post: {
      tags: ['Loans'],
      summary: 'Approve a pending loan (the human decision)',
      description:
        'Activates the loan, locks rate/interest from current config, generates the ' +
        'monthly schedule (remainder folds into the last instalment), sends the ' +
        'approval SMS.',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Approved and active', loanResult),
        '409': errorResponse('NOT_PENDING'),
      },
    },
  },
  '/loans/{id}/reject': {
    post: {
      tags: ['Loans'],
      summary: 'Reject a pending loan',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(rejectBody),
      responses: {
        '200': jsonResponse('Rejected', loanResult),
        '409': errorResponse('NOT_PENDING'),
      },
    },
  },
  '/loans/{id}/repayments': {
    post: {
      tags: ['Loans'],
      summary: 'Record a cash repayment',
      description:
        'Allocated to instalments oldest-first. Overpayment is refused with the ' +
        'exact remaining balance. Settling exactly flips the loan to repaid and ' +
        'stamps repaidOnTime. Idempotency key required.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(repayBody),
      responses: {
        '201': jsonResponse('Recorded', repaymentResult),
        '200': jsonResponse('Replay of an earlier request', repaymentResult),
        '422': errorResponse('EXCEEDS_BALANCE (details.remaining) or LOAN_NOT_OPEN'),
      },
    },
  },
  '/loans/{id}/repayments/susu-closure': {
    post: {
      tags: ['Loans'],
      summary: 'Repay by closing a susu account (atomic across modules)',
      description:
        'One transaction: the susu account stops with normal commission math and its ' +
        'payout is applied to the loan (capped at the remaining balance). Any excess ' +
        'either stays in the susu account pending withdrawal (default — collect via ' +
        'POST /susu/accounts/{id}/payout) or, with excessTo=savings, is credited to ' +
        'the customer’s active savings account in the same transaction.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(susuRepayBody),
      responses: {
        '201': jsonResponse('Closed and applied', repaymentResult),
        '200': jsonResponse('Replay of an earlier request', repaymentResult),
        '409': errorResponse('ALREADY_CLOSED'),
        '422': errorResponse(
          'PAYOUT_EXCEEDS_BALANCE, CUSTOMER_MISMATCH, NO_PAYOUT, or LOAN_NOT_OPEN',
        ),
      },
    },
  },
};

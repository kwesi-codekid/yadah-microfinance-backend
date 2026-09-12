import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { CORRECTION_KINDS, CORRECTION_STATUSES } from '../../models/index.js';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import { listCorrectionsQuery, rejectCorrectionBody } from './corrections.schemas.js';

/**
 * A teller's request to correct a transaction's amount. One shape for every
 * kind: the asking and the deciding are the same whatever the figure is on.
 */
export const txnCorrection = z
  .object({
    id: z.string(),
    kind: z
      .enum(CORRECTION_KINDS)
      .describe(
        'What the figure is on: a susu deposit, a savings deposit or withdrawal, a loan ' +
          'repayment, or a hire-purchase instalment',
      ),
    targetId: z
      .string()
      .describe('The record the transaction belongs to: susu/savings account, loan, agreement'),
    txnId: z.string().describe('The transaction itself'),
    customerId: z.string(),
    customerName: z.string().optional().describe('Joined for display'),
    targetNumber: z
      .string()
      .optional()
      .describe('The account, loan or agreement number, where the record has one'),
    targetLabel: z
      .string()
      .optional()
      .describe("A susu account's own ref, or the item on a hire-purchase agreement"),
    amountBefore: z
      .number()
      .int()
      .describe('The transaction as it stood when the teller asked, pesewas'),
    amount: z.number().int().describe('What the teller asked for, pesewas'),
    unitsBefore: z.number().int().optional().describe('Susu only: days covered before'),
    units: z.number().int().optional().describe('Susu only: days covered after'),
    reason: z.string(),
    status: z.enum(CORRECTION_STATUSES),
    requestedById: z.string(),
    requestedByName: z.string().optional(),
    reviewedById: z
      .string()
      .optional()
      .describe('Whoever decided — or, for a cancellation, whoever withdrew it'),
    reviewedByName: z.string().optional(),
    reviewedAt: z.iso.datetime().optional(),
    rejectionReason: z.string().optional(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'TxnCorrection' });

const security = [{ bearerAuth: [] }];
const correctionIdParam = z.object({ correctionId: z.string().describe('Correction id') });
const correctionResult = z.object({ correction: txnCorrection });

/**
 * What a decision answers with. `target` and `txn` are the record and the
 * transaction after the change, in the shape the owning module's own
 * endpoints use — a SusuAccount and SusuDeposit, a SavingsAccount and
 * SavingsTxn, a Loan and its repayment, an HpAgreement and its payment.
 */
const appliedResult = z.object({
  correction: txnCorrection,
  target: z.unknown().describe('The account, loan or agreement after the change'),
  txn: z.unknown().describe('The transaction after the change'),
});

export const correctionPaths: ZodOpenApiPathsObject = {
  '/corrections': {
    get: {
      tags: ['Corrections'],
      summary: 'Corrections waiting on, or decided by, the office (counter)',
      description:
        'Newest first. Every counter role reads the whole queue, so a teller can see ' +
        'that a request is already waiting on a transaction. Filter by status, kind, ' +
        'or the account, loan or agreement the transaction belongs to.',
      security,
      requestParams: { query: listCorrectionsQuery },
      responses: {
        '200': jsonResponse(
          'Paginated corrections',
          z.object({
            items: z.array(txnCorrection),
            page: z.number(),
            limit: z.number(),
            total: z.number(),
          }),
        ),
      },
    },
  },
  '/corrections/{correctionId}/approve': {
    post: {
      tags: ['Corrections'],
      summary: 'Apply a teller’s correction (office only)',
      description:
        'Runs the same correction as the owning module’s PATCH, against the record as ' +
        'it stands now, and marks the request approved in the same transaction — the ' +
        'figure changes and the request is approved together, or neither happens. A ' +
        'rule that refuses the correction (a newer transaction has landed, the account ' +
        'has closed) leaves the request pending with that refusal as the answer: decline ' +
        'it with the reason, or put the record right and retry. The teller who asked ' +
        'is notified.',
      security,
      requestParams: { path: correctionIdParam },
      responses: {
        '200': jsonResponse('Applied', appliedResult),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_PENDING (already decided) or CONFLICT (concurrent update)'),
        '422': errorResponse(
          'The owning module’s refusal — CANNOT_CORRECT, AMOUNT_MISMATCH, ' +
            'EXCEEDS_REMAINING, EXCEEDS_AVAILABLE, EXCEEDS_BALANCE or AMOUNT_TOO_SMALL — ' +
            'because the record has moved since the teller asked',
        ),
      },
    },
  },
  '/corrections/{correctionId}/reject': {
    post: {
      tags: ['Corrections'],
      summary: 'Decline a teller’s correction (office only)',
      description: 'The transaction is untouched. The teller who asked reads the reason.',
      security,
      requestParams: { path: correctionIdParam },
      requestBody: jsonBody(rejectCorrectionBody),
      responses: {
        '200': jsonResponse('Declined', correctionResult),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_PENDING — already decided'),
      },
    },
  },
  '/corrections/{correctionId}/cancel': {
    post: {
      tags: ['Corrections'],
      summary: 'Take back a correction before it is decided (counter)',
      description:
        'Whoever asked may cancel; so may the office. Another teller may not — a ' +
        'request is its author’s until it is decided.',
      security,
      requestParams: { path: correctionIdParam },
      responses: {
        '200': jsonResponse('Cancelled', correctionResult),
        '403': errorResponse('FORBIDDEN — not yours to cancel'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_PENDING — already decided'),
      },
    },
  },
};

/**
 * The two paths every correctable module adds under its own transaction:
 * the office's outright PATCH and the counter's request. Built here so the
 * four modules describe them identically.
 */
export function correctionPathsFor(
  tag: string,
  what: string,
  rules: string,
  pathParams: z.ZodObject,
  txnSchema: z.ZodType,
  targetSchema: z.ZodType,
): ZodOpenApiPathsObject[string] {
  return {
    patch: {
      tags: [tag],
      summary: `Correct the amount of ${what} (office only)`,
      description:
        `Data-entry fixes. ${rules} A teller cannot call this: they ask through the ` +
        'sibling POST .../corrections and the office applies the request, which runs ' +
        'this same correction.',
      security,
      requestParams: { path: pathParams },
      requestBody: jsonBody(z.object({ amount: z.number().int().min(1) })),
      responses: {
        '200': jsonResponse('Corrected', z.object({ target: targetSchema, txn: txnSchema })),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('CONFLICT — concurrent update, retry'),
        '422': errorResponse('The module’s refusal, named in the description above'),
      },
    },
  };
}

export function proposeCorrectionPathFor(
  tag: string,
  what: string,
  pathParams: z.ZodObject,
): ZodOpenApiPathsObject[string] {
  return {
    post: {
      tags: [tag],
      summary: `Ask the office to correct ${what} (counter)`,
      description:
        'The teller’s door to a correction. Nothing on the ledger moves: the request ' +
        'waits for an office decision under /corrections. It is refused on the spot for ' +
        'anything the correction itself would refuse, and checked again when applied, ' +
        'against the record as it stands then. One open request per transaction. The ' +
        'office is notified.',
      security,
      requestParams: { path: pathParams },
      requestBody: jsonBody(
        z.object({ amount: z.number().int().min(1), reason: z.string().min(3).max(300) }),
      ),
      responses: {
        '201': jsonResponse('Waiting for a decision', correctionResult),
        '403': errorResponse('FORBIDDEN — collectors may not ask'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse(
          'CORRECTION_PENDING — a request is already waiting on this transaction',
        ),
        '422': errorResponse('The module’s refusal, or NO_CHANGE (already that amount)'),
      },
    },
  };
}

import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import {
  adjustStockBody,
  createAgreementBody,
  createItemBody,
  depositBody,
  listAgreementsQuery,
  listItemsQuery,
  putConfigBody,
  reasonBody,
  updateItemBody,
} from './hp.schemas.js';

const hpItem = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    quantityInStock: z.number().int(),
    costPrice: z.number().int().describe('What Yadah paid — office-only, never shown to customers'),
    sellingPrice: z.number().int().describe('What the customer pays'),
    status: z.enum(['active', 'discontinued']),
  })
  .meta({ id: 'HpItem' });

const hpAgreement = z
  .object({
    id: z.string(),
    customerId: z.string(),
    customerName: z.string().optional().describe('On list responses'),
    item: z.object({
      name: z.string(),
      description: z.string().optional(),
      sellingPrice: z.number().int(),
    }),
    depositRequired: z.number().int().describe('Exactly 50% of the selling price'),
    financedAmount: z.number().int().describe('The remaining half — interest applies (Stage B)'),
    durationMonths: z.number().int(),
    interestRatePercent: z.number().int().describe('Snapshotted at signing; METHOD pending client'),
    totalPaid: z.number().int(),
    status: z.enum([
      'pending',
      'rejected',
      'active',
      'in-arrears',
      'repossessed',
      'closed-redeemed',
      'closed-forfeited',
      'closed-completed',
    ]),
    itemReleasedAt: z.iso.datetime().optional(),
    arrearsAt: z.iso.datetime().optional(),
    repossessedAt: z.iso.datetime().optional(),
    repossessionReason: z.string().optional(),
    redemptionDeadline: z.iso
      .datetime()
      .optional()
      .describe(
        'repossessedAt + 1 month — full-balance redemption until then (legally sensitive, always exact)',
      ),
    closedAt: z.iso.datetime().optional(),
    rejectionReason: z.string().optional(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'HpAgreement' });

const agreementResult = z.object({ agreement: hpAgreement });
const security = [{ bearerAuth: [] }];
const idParam = z.object({ id: z.string() });
const stageB =
  ' Installment schedules and payments arrive in Stage B once the client confirms the interest method.';

export const hpPaths: ZodOpenApiPathsObject = {
  '/hire-purchase/items': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Add an inventory item',
      description:
        'Cost and selling price are both stored (profit-per-item reporting). If equal, enter the same number twice.',
      security,
      requestBody: jsonBody(createItemBody),
      responses: { '201': jsonResponse('Created', z.object({ item: hpItem })) },
    },
    get: {
      tags: ['Hire Purchase'],
      summary: 'List inventory',
      security,
      requestParams: { query: listItemsQuery },
      responses: {
        '200': jsonResponse(
          'Paginated items',
          z.object({
            items: z.array(hpItem),
            page: z.number(),
            limit: z.number(),
            total: z.number(),
          }),
        ),
      },
    },
  },
  '/hire-purchase/items/{id}': {
    patch: {
      tags: ['Hire Purchase'],
      summary: 'Update an item (prices, status)',
      description: 'Never changes already-signed agreements — they snapshot prices at signing.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(updateItemBody),
      responses: {
        '200': jsonResponse('Updated', z.object({ item: hpItem })),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/hire-purchase/items/{id}/adjust-stock': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Adjust stock with a reason (audited)',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(adjustStockBody),
      responses: {
        '200': jsonResponse('Adjusted', z.object({ item: hpItem })),
        '422': errorResponse('STOCK_UNDERFLOW'),
      },
    },
  },
  '/hire-purchase/config': {
    get: {
      tags: ['Hire Purchase'],
      summary: 'HP settings (interest rate; method pending client decision)',
      security,
      responses: { '200': jsonResponse('Config', z.object({ config: z.unknown() })) },
    },
    put: {
      tags: ['Hire Purchase'],
      summary: 'Update the admin-configurable interest rate',
      security,
      requestBody: jsonBody(putConfigBody),
      responses: { '200': jsonResponse('Updated', z.object({ config: z.unknown() })) },
    },
  },
  '/hire-purchase/eligibility/{customerId}': {
    get: {
      tags: ['Hire Purchase'],
      summary: 'HP eligibility summary',
      description:
        'Requires an active susu or savings account, ≥3 months saving history, no active loan ' +
        '(loans and HP block each other), and no open HP agreement.',
      security,
      requestParams: { path: z.object({ customerId: z.string() }) },
      responses: {
        '200': jsonResponse('Summary with reasons', z.unknown()),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/hire-purchase/agreements': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Sign an agreement (decrements stock, snapshots prices)',
      description:
        'Deposit = exactly 50% of the selling price, due before the item is released.' + stageB,
      security,
      requestBody: jsonBody(createAgreementBody),
      responses: {
        '201': jsonResponse('Agreement created (pending deposit)', agreementResult),
        '409': errorResponse('OUT_OF_STOCK (race)'),
        '422': errorResponse('NOT_ELIGIBLE (details.reasons) or OUT_OF_STOCK'),
      },
    },
    get: {
      tags: ['Hire Purchase'],
      summary: 'List agreements',
      security,
      requestParams: { query: listAgreementsQuery },
      responses: {
        '200': jsonResponse(
          'Paginated agreements',
          z.object({
            items: z.array(hpAgreement),
            page: z.number(),
            limit: z.number(),
            total: z.number(),
          }),
        ),
      },
    },
  },
  '/hire-purchase/agreements/{id}': {
    get: {
      tags: ['Hire Purchase'],
      summary: 'Agreement detail with payments',
      security,
      requestParams: { path: idParam },
      responses: { '200': jsonResponse('Detail', z.unknown()), '404': errorResponse('NOT_FOUND') },
    },
  },
  '/hire-purchase/agreements/{id}/deposit': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Record the 50% deposit — releases the item',
      description:
        'Amount must equal depositRequired exactly. Idempotency key required. SMS receipt sent.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(depositBody),
      responses: {
        '201': jsonResponse(
          'Deposit recorded, agreement active',
          z.object({ agreement: hpAgreement, replayed: z.boolean() }),
        ),
        '200': jsonResponse(
          'Replay of an earlier request',
          z.object({ agreement: hpAgreement, replayed: z.boolean() }),
        ),
        '422': errorResponse('DEPOSIT_MISMATCH (details.required) or NOT_PENDING'),
      },
    },
  },
  '/hire-purchase/agreements/{id}/reject': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Reject a pending agreement (restores stock)',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(reasonBody),
      responses: {
        '200': jsonResponse('Rejected', agreementResult),
        '409': errorResponse('NOT_PENDING'),
      },
    },
  },
  '/hire-purchase/agreements/{id}/mark-arrears': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Flag an active agreement as in arrears (office action)',
      description:
        'Sends the arrears-warning SMS. Automatic flagging (installment ≥1 month overdue) arrives with Stage B schedules.',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('In arrears', agreementResult),
        '409': errorResponse('INVALID_TRANSITION'),
      },
    },
  },
  '/hire-purchase/agreements/{id}/repossess': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Record a repossession — starts the 1-month redemption window',
      description:
        'Payments made so far are kept. redemptionDeadline = repossession + 1 month, exact. ' +
        'The customer may redeem by paying the full remaining balance before it.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(reasonBody),
      responses: {
        '200': jsonResponse('Repossessed', agreementResult),
        '409': errorResponse('INVALID_TRANSITION'),
      },
    },
  },
  '/hire-purchase/agreements/{id}/forfeit': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Close as forfeited after the redemption window lapses',
      description:
        'Refused while the window is still open. Item and payments are forfeited to Yadah for good.',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Forfeited', agreementResult),
        '409': errorResponse('INVALID_TRANSITION'),
        '422': errorResponse('REDEMPTION_WINDOW_OPEN (details.redemptionDeadline)'),
      },
    },
  },
};

import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import {
  adjustStockBody,
  createAgreementBody,
  createItemBody,
  depositBody,
  forfeitBody,
  listAgreementsQuery,
  listItemsQuery,
  listSalesQuery,
  paymentBody,
  putConfigBody,
  reasonBody,
  recordSaleBody,
  redeemBody,
  trashBody,
  trashListQuery,
  updateItemBody,
  voidSaleBody,
} from './hp.schemas.js';

const hpItem = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    quantityInStock: z.number().int(),
    costPrice: z.number().int().describe('What Yadah paid — office-only, never shown to customers'),
    sellingPrice: z.number().int().describe('What the customer pays'),
    condition: z.enum(['new', 'used']).describe('Forfeited repossessions restock as used'),
    status: z.enum(['active', 'discontinued']),
    createdAt: z.iso.datetime(),
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
    interestRatePercent: z.number().int().describe('Snapshotted at signing; flat, applied once'),
    interestAmount: z.number().int().optional().describe('Set at activation'),
    totalPayable: z
      .number()
      .int()
      .optional()
      .describe('financed + interest — what remains after the deposit'),
    remaining: z
      .number()
      .int()
      .describe('totalPayable minus payments (deposit excluded); 0 before activation'),
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

const trashedHpItem = hpItem.extend({
  deletedAt: z.iso.datetime(),
  deletedById: z.string().optional(),
  deleteReason: z.string().optional(),
});

const trashedHpAgreement = hpAgreement.extend({
  deletedAt: z.iso.datetime(),
  deletedById: z.string().optional(),
  deleteReason: z.string().optional(),
});

const agreementResult = z.object({ agreement: hpAgreement });
const hpSale = z
  .object({
    id: z.string(),
    receiptNo: z.string().describe('Quotable reference, e.g. SALE-1A2B3C4D'),
    customerId: z.string().nullable().describe('null for a walk-in buyer'),
    buyerName: z.string(),
    buyerPhone: z.string().optional(),
    lines: z.array(
      z.object({
        itemId: z.string(),
        name: z.string().describe('Snapshotted at the sale'),
        quantity: z.number().int(),
        unitPrice: z.number().int().describe('What was actually charged per unit'),
        listPrice: z.number().int().describe('The listed price then — makes a discount visible'),
        lineTotal: z.number().int(),
      }),
    ),
    subtotal: z.number().int().describe('What the basket would have cost at list'),
    discount: z.number().int(),
    total: z.number().int().describe('What the buyer paid'),
    channel: z.string(),
    soldById: z.string(),
    status: z.enum(['completed', 'voided']),
    voidedAt: z.iso.datetime().optional(),
    voidReason: z.string().optional(),
    createdAt: z.iso.datetime(),
  })
  .describe('Cost price and profit are internal and never appear here')
  .meta({ id: 'HpSale' });

const security = [{ bearerAuth: [] }];
const idParam = z.object({ id: z.string() });
const stageB =
  ' Installment schedules and payments arrive in Stage B once the client confirms the interest method.';

export const hpPaths: ZodOpenApiPathsObject = {
  '/hire-purchase/sales': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Record an outright counter sale (office only)',
      description:
        'The counter/POS case: stock out, money in, no agreement, no deposit, no ' +
        'instalments. Two things differ from an HP agreement. First, the buyer need NOT ' +
        'be a registered customer — pass buyerName for a walk-in instead of customerId, ' +
        'since requiring a photo and both sides of an ID to sell a kettle is absurd. ' +
        'Second, it is a basket: several items in one sale. Every price is snapshotted, ' +
        'so later inventory edits never rewrite what a buyer was charged. Per-line ' +
        'unitPrice is optional and defaults to the item’s selling price — pass it only to ' +
        'record a haggled price, which then shows against the list price. Stock is ' +
        'decremented inside the transaction under a guard, so two tills cannot sell the ' +
        'same unit. Idempotent on idempotencyKey.',
      security,
      requestBody: jsonBody(recordSaleBody),
      responses: {
        '201': jsonResponse('Sale recorded', z.object({ sale: hpSale, replayed: z.boolean() })),
        '200': jsonResponse('Replay of an earlier identical request', z.object({})),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND (customer) or ITEM_NOT_FOUND (details.itemId)'),
        '409': errorResponse('INSUFFICIENT_STOCK — sold out while ringing up'),
        '422': errorResponse(
          'ITEM_DISCONTINUED, or INSUFFICIENT_STOCK ' +
            '(details.requested, details.quantityInStock)',
        ),
      },
    },
    get: {
      tags: ['Hire Purchase'],
      summary: 'List outright sales (office only)',
      description:
        'Newest first. `totals` covers the whole filter rather than the page, and always ' +
        'excludes voided sales. Filter with walkInOnly=true for sales with no registered ' +
        'customer behind them. Pass format=csv or format=xlsx to download — the ' +
        'spreadsheet includes cost and profit per sale, which the JSON deliberately ' +
        'never exposes.',
      security,
      requestParams: { query: listSalesQuery },
      responses: {
        '200': jsonResponse(
          'Paginated sales',
          z.object({
            items: z.array(hpSale),
            page: z.number().int(),
            limit: z.number().int(),
            total: z.number().int(),
            totals: z.object({
              salesCount: z.number().int(),
              revenue: z.number().int(),
              profit: z.number().int(),
            }),
          }),
        ),
      },
    },
  },
  '/hire-purchase/sales/{id}': {
    get: {
      tags: ['Hire Purchase'],
      summary: 'Get one outright sale (office only)',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('The sale', z.object({ sale: hpSale })),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/hire-purchase/sales/{id}/receipt': {
    get: {
      tags: ['Hire Purchase'],
      summary: 'Printable sales receipt (office only)',
      description:
        'A4 receipt with one line per basket item, then the totals. A discounted line ' +
        'shows the list price alongside what was charged. A voided sale still prints, ' +
        'stamped VOIDED with its reason. Binary response (application/pdf).',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': {
          description: 'The receipt',
          content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
        },
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/hire-purchase/sales/{id}/void': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Void a sale rung up in error (office only)',
      description:
        'Returns the stock and stops the sale counting toward revenue, but keeps the row ' +
        'and records who voided it and why — a ledger never forgets, it annotates. ' +
        'Voided sales drop out of the transactions feed and the revenue report.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(voidSaleBody),
      responses: {
        '200': jsonResponse('Voided', z.object({ sale: hpSale })),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('ALREADY_VOIDED'),
      },
    },
  },

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
      description: 'Pass format=csv or format=xlsx to download the listing as a spreadsheet.',
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
  '/hire-purchase/items/trash': {
    get: {
      tags: ['Hire Purchase'],
      summary: 'List trashed inventory items',
      description: 'Newest-trashed first. Restore via POST /hire-purchase/items/{id}/restore.',
      security,
      requestParams: { query: trashListQuery },
      responses: {
        '200': jsonResponse(
          'Paginated trashed items',
          z.object({
            items: z.array(trashedHpItem),
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
    delete: {
      tags: ['Hire Purchase'],
      summary: 'Move an item to the trash (soft delete)',
      description:
        'Only items never used by an agreement can be trashed. Trashed items vanish from normal listings until restored.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(trashBody),
      responses: {
        '200': jsonResponse('Trashed', z.object({ item: trashedHpItem })),
        '404': errorResponse('NOT_FOUND'),
        '422': errorResponse('CANNOT_TRASH (details.agreements)'),
      },
    },
  },
  '/hire-purchase/items/{id}/restore': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Restore an item from the trash',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Restored', z.object({ item: hpItem })),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_TRASHED'),
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
      description: 'Pass format=csv or format=xlsx to download the listing as a spreadsheet.',
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
  '/hire-purchase/agreements/trash': {
    get: {
      tags: ['Hire Purchase'],
      summary: 'List trashed agreements',
      description: 'Newest-trashed first. Restore via POST /hire-purchase/agreements/{id}/restore.',
      security,
      requestParams: { query: trashListQuery },
      responses: {
        '200': jsonResponse(
          'Paginated trashed agreements',
          z.object({
            items: z.array(trashedHpAgreement),
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
    delete: {
      tags: ['Hire Purchase'],
      summary: 'Move an agreement to the trash (soft delete)',
      description:
        'Only unpaid pending or rejected agreements. Trashing a pending agreement restocks its item (the item never left the shop).',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(trashBody),
      responses: {
        '200': jsonResponse('Trashed', z.object({ agreement: trashedHpAgreement })),
        '404': errorResponse('NOT_FOUND'),
        '422': errorResponse('CANNOT_TRASH (details.status, details.payments)'),
      },
    },
  },
  '/hire-purchase/agreements/{id}/restore': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Restore an agreement from the trash',
      description:
        'Restoring a pending agreement re-reserves a unit of its item — refused if the item is out of stock.',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Restored', agreementResult),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_TRASHED'),
        '422': errorResponse('OUT_OF_STOCK'),
      },
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
  '/hire-purchase/agreements/{id}/payments': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Record a monthly payment',
      description:
        'Interest is flat, applied once at activation (client-confirmed) — early ' +
        'settlement pays the same total. Oldest instalment first; overpay refused ' +
        'with the exact remaining. Settling transfers ownership. Clearing all ' +
        'month-overdue instalments lifts an arrears flag automatically.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(paymentBody),
      responses: {
        '201': jsonResponse(
          'Recorded',
          z.object({ agreement: hpAgreement, replayed: z.boolean() }),
        ),
        '200': jsonResponse(
          'Replay of an earlier request',
          z.object({ agreement: hpAgreement, replayed: z.boolean() }),
        ),
        '422': errorResponse('EXCEEDS_BALANCE (details.remaining) or AGREEMENT_NOT_OPEN'),
      },
    },
  },
  '/hire-purchase/agreements/{id}/redeem': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Redeem a repossessed item (full remaining balance)',
      description:
        'Only while the 1-month redemption window is open. The amount is computed ' +
        'server-side — the full remaining balance — and returned in the response.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(redeemBody),
      responses: {
        '201': jsonResponse(
          'Redeemed — ownership transferred',
          z.object({ agreement: hpAgreement, amount: z.number().int(), replayed: z.boolean() }),
        ),
        '409': errorResponse('INVALID_TRANSITION'),
        '422': errorResponse('REDEMPTION_WINDOW_LAPSED'),
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
        'Refused while the window is still open. Item and payments are forfeited to ' +
        'Yadah for good. Pass `restock` to put the item back in inventory as USED at ' +
        'a new office-set price (client-confirmed flow).',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(forfeitBody),
      responses: {
        '200': jsonResponse(
          'Forfeited',
          z.object({ agreement: hpAgreement, restockedItem: hpItem.optional() }),
        ),
        '409': errorResponse('INVALID_TRANSITION'),
        '422': errorResponse('REDEMPTION_WINDOW_OPEN (details.redemptionDeadline)'),
      },
    },
  },
};

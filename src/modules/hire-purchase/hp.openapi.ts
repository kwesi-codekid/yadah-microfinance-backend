import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import { DAMAGE_CAUSES, DAMAGE_STATUSES, PRICE_KINDS } from '../../models/index.js';
import {
  IMPORT_COLUMNS as ITEM_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS as ITEM_IMPORT_MAX_ROWS,
} from './hp.import.js';
import {
  adjustStockBody,
  createAgreementBody,
  createItemBody,
  importItemRowsBody,
  labelBody,
  listDamagesQuery,
  listLabelsQuery,
  listPriceChangesQuery,
  rangeOnlyQuery,
  receiveStockBody,
  rejectDamageBody,
  reportDamageBody,
  updateDamageBody,
  updateLabelBody,
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

const itemImportField = z
  .enum(ITEM_IMPORT_COLUMNS.map((c) => c.field) as [string, ...string[]])
  .describe('The column an issue belongs to');

const itemRowIssue = z.object({
  field: itemImportField.nullable().describe('Null when the fault is the row as a whole'),
  message: z.string(),
});

const labelRef = z.object({ id: z.string(), name: z.string() });

const itemImportPreview = z
  .object({
    rows: z.array(
      z.object({
        row: z.number().int().describe('The line in the sheet, so a message can name it'),
        values: z
          .record(z.string(), z.string())
          .describe('Every column as text, ready to be corrected and sent back'),
        brandId: z.string().describe('Resolved from the brand cell; empty when it matched nothing'),
        categoryId: z
          .string()
          .describe('Resolved from the category cell; empty when it matched nothing'),
        issues: z.array(itemRowIssue),
      }),
    ),
    unknownHeaders: z.array(z.string()).describe('Headings that matched no column'),
    brands: z.array(labelRef).describe('Every brand, for correcting a row that named none'),
    categories: z.array(labelRef).describe('Every category, likewise'),
    counts: z.object({
      total: z.number().int(),
      ready: z.number().int(),
      blocked: z.number().int(),
    }),
  })
  .meta({ id: 'InventoryImportPreview' });

const itemImportOutcome = z
  .object({
    created: z.array(z.object({ row: z.number().int(), id: z.string(), name: z.string() })),
    failed: z.array(z.object({ row: z.number().int(), issues: z.array(itemRowIssue) })),
    counts: z.object({
      total: z.number().int(),
      created: z.number().int(),
      failed: z.number().int(),
    }),
  })
  .meta({ id: 'InventoryImportOutcome' });

const itemImportColumnList = ITEM_IMPORT_COLUMNS.map(
  (c) => `${c.header}${c.required ? ' (required)' : ''}`,
).join(', ');

const hpLabel = z
  .object({
    id: z.string(),
    kind: z.enum(['brand', 'category']),
    name: z.string(),
    description: z.string().optional(),
    itemCount: z
      .number()
      .int()
      .describe('Items on the shelf filed under it, trashed ones excluded'),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'HpLabel' });

/**
 * Brands and categories are the same shape behind two paths, so their
 * documentation is written once and stamped for each.
 */
function labelPaths(plural: 'brands' | 'categories', noun: string): ZodOpenApiPathsObject {
  return {
    [`/hire-purchase/${plural}`]: {
      get: {
        tags: ['Hire Purchase'],
        summary: `List ${plural}`,
        description: `Alphabetical, with how many items are filed under each. \`search\` matches the name.`,
        security,
        requestParams: { query: listLabelsQuery },
        responses: {
          '200': jsonResponse(
            `Paginated ${plural}`,
            z.object({
              items: z.array(hpLabel),
              page: z.number(),
              limit: z.number(),
              total: z.number(),
            }),
          ),
        },
      },
      post: {
        tags: ['Hire Purchase'],
        summary: `Add a ${noun} (counter)`,
        description: `Names are unique within ${plural}, whatever the capitals or spacing.`,
        security,
        requestBody: jsonBody(labelBody),
        responses: {
          '201': jsonResponse('Created', z.object({ label: hpLabel })),
          '409': errorResponse('LABEL_TAKEN — details.id names the existing one'),
        },
      },
    },
    [`/hire-purchase/${plural}/{id}`]: {
      get: {
        tags: ['Hire Purchase'],
        summary: `One ${noun}`,
        description: `Its items are GET /hire-purchase/items?${noun}Id={id}.`,
        security,
        requestParams: { path: idParam },
        responses: {
          '200': jsonResponse('Detail', z.object({ label: hpLabel })),
          '404': errorResponse('NOT_FOUND'),
        },
      },
      patch: {
        tags: ['Hire Purchase'],
        summary: `Rename or describe a ${noun} (counter)`,
        description: 'A rename reaches every item filed under it. description: null clears it.',
        security,
        requestParams: { path: idParam },
        requestBody: jsonBody(updateLabelBody),
        responses: {
          '200': jsonResponse('Updated', z.object({ label: hpLabel })),
          '404': errorResponse('NOT_FOUND'),
          '409': errorResponse('LABEL_TAKEN'),
        },
      },
      delete: {
        tags: ['Hire Purchase'],
        summary: `Delete a ${noun} (office only)`,
        description:
          'Gone for good — there is no trash for a label. Refused while any item is still filed under it; move those first.',
        security,
        requestParams: { path: idParam },
        responses: {
          '204': { description: 'Deleted' },
          '404': errorResponse('NOT_FOUND'),
          '409': errorResponse('LABEL_IN_USE — details.itemCount says how many'),
        },
      },
    },
  };
}

const hpItem = z
  .object({
    id: z.string(),
    name: z.string(),
    brand: labelRef.optional().describe('Who makes it — one of GET /hire-purchase/brands'),
    category: labelRef
      .optional()
      .describe('What kind of thing it is — one of GET /hire-purchase/categories'),
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
      'awaiting-approval',
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
    signatureUrl: z
      .string()
      .optional()
      .describe("A picture of the customer's signature on the agreement"),
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
const hpPriceChange = z
  .object({
    id: z.string(),
    itemId: z.string(),
    kind: z.enum(PRICE_KINDS).describe('Which price moved: what it costs, or what it sells for'),
    previous: z.number().int().describe('Pesewas, before the change'),
    current: z.number().int().describe('Pesewas, after'),
    delta: z.number().int().describe('current − previous; negative when the price came down'),
    reason: z.string().optional(),
    quantityReceived: z
      .number()
      .int()
      .optional()
      .describe('Set when the change arrived with a delivery rather than an edit'),
    supplier: z.string().optional(),
    invoiceRef: z.string().optional(),
    receivedOn: z.string().optional().describe('Accra day the goods arrived (YYYY-MM-DD)'),
    changedById: z.string(),
    changedByName: z.string().optional(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'HpPriceChange' });

const hpDamage = z
  .object({
    id: z.string(),
    itemId: z.string(),
    itemName: z.string().describe('The item’s name when it was reported — it may be renamed later'),
    quantity: z.number().int(),
    cause: z.enum(DAMAGE_CAUSES),
    description: z.string(),
    occurredOn: z.string().describe('Accra day it happened (YYYY-MM-DD)'),
    status: z.enum(DAMAGE_STATUSES),
    costValue: z
      .number()
      .int()
      .optional()
      .describe(
        'Pesewas. Struck at APPROVAL from the item’s cost at that moment, and never ' +
          'recomputed. Absent while pending and on a rejection.',
      ),
    unitCost: z.number().int().optional().describe('The unit cost costValue was struck at'),
    photoUrls: z.array(z.string()),
    reportedById: z.string(),
    reportedByName: z.string().optional(),
    reviewedById: z.string().optional(),
    reviewedByName: z.string().optional(),
    reviewedAt: z.iso.datetime().optional(),
    rejectionReason: z.string().optional(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'HpDamage' });

const trashedHpDamage = hpDamage.extend({
  deletedAt: z.iso.datetime(),
  deletedById: z.string().optional(),
  deleteReason: z.string().optional(),
});

const damageSummary = z
  .object({
    from: z.string().nullable(),
    to: z.string().nullable(),
    totalCostValue: z.number().int(),
    totalQuantity: z.number().int(),
    byCause: z.array(
      z.object({
        cause: z.enum(DAMAGE_CAUSES),
        count: z.number().int(),
        quantity: z.number().int(),
        costValue: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'HpDamageSummary' });

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
      summary: 'Add an inventory item (counter)',
      description:
        'Cost and selling price are both stored (profit-per-item reporting). If equal, enter the same number twice. ' +
        'brandId and categoryId name managed labels — see GET /hire-purchase/brands and /categories.',
      security,
      requestBody: jsonBody(createItemBody),
      responses: { '201': jsonResponse('Created', z.object({ item: hpItem })) },
    },
    get: {
      tags: ['Hire Purchase'],
      summary: 'List inventory',
      description:
        'Search matches the name, brand and category; `brandId` and `categoryId` filter on one. ' +
        'Pass format=csv or format=xlsx to download the listing as a spreadsheet.',
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
  '/hire-purchase/items/import/template': {
    get: {
      tags: ['Hire Purchase'],
      summary: 'Download the blank stock-import sheet (counter)',
      description:
        'Headings the importer reads, plus one example row. Columns: ' +
        `${itemImportColumnList}. Headings are matched on letters and digits only, and a few ` +
        'common alternatives are accepted (e.g. "Qty" for Quantity, "Make" for Brand). ' +
        'Prices are written in cedis. format=csv (default) or xlsx.',
      security,
      requestParams: { query: z.object({ format: z.enum(['csv', 'xlsx']).optional() }) },
      responses: {
        '200': {
          description: 'The template',
          content: { 'text/csv': { schema: { type: 'string' } } },
        },
      },
    },
  },
  '/hire-purchase/items/import/preview': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Check a filled stock sheet (counter, writes nothing)',
      description:
        'Multipart form with a `file` field carrying a .csv or .xlsx (max 5 MB, ' +
        `${String(ITEM_IMPORT_MAX_ROWS)} rows). Every row is held to the rules one item is, and the ` +
        'findings come back per cell. Also catches what only the whole file and the shelf can ' +
        'answer: the same item twice in the sheet, or one already stocked. A brand or category ' +
        'cell must name a managed label; one that does not is flagged with the list to pick from. ' +
        'NOTHING IS CREATED by this call.',
      security,
      requestBody: {
        content: {
          'multipart/form-data': {
            schema: z.object({ file: z.string().meta({ format: 'binary' }) }),
          },
        },
      },
      responses: {
        '200': jsonResponse('Every row, with what is wrong with it', itemImportPreview),
        '413': errorResponse('FILE_TOO_LARGE'),
        '415': errorResponse('UNSUPPORTED_FILE_TYPE — .csv or .xlsx only'),
        '422': errorResponse('EMPTY_FILE, NO_KNOWN_COLUMNS, TOO_MANY_ROWS, or UNREADABLE_FILE'),
      },
    },
  },
  '/hire-purchase/items/import': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Stock the corrected rows (counter)',
      description:
        'Takes the rows the preview returned, with whatever was changed. Every row is checked ' +
        'again and then added one at a time. A row that fails does not stop the rest: it comes ' +
        'back in `failed` with its reason, while the rows that went in are absent from the retry.',
      security,
      requestBody: jsonBody(importItemRowsBody),
      responses: {
        '201': jsonResponse('What was stocked and what was not', itemImportOutcome),
        '422': errorResponse('EMPTY_IMPORT or TOO_MANY_ROWS'),
      },
    },
  },
  '/hire-purchase/items/trash': {
    get: {
      tags: ['Hire Purchase'],
      summary: 'List trashed inventory items (office only)',
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
      summary: 'Update an item (counter)',
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
        'Requires both sides of the ID document on the profile, an active susu or savings ' +
        'account, ≥3 months saving history, no active loan (loans and HP block each other), ' +
        'and no open HP agreement. Each unmet condition is listed in `reasons`.',
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
        'Restoring a pending agreement re-checks the ID document rule and re-reserves a unit ' +
        'of its item — refused if the item is out of stock.',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Restored', agreementResult),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_TRASHED'),
        '422': errorResponse('OUT_OF_STOCK or ID_DOCUMENT_REQUIRED'),
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
        '422': errorResponse(
          'DEPOSIT_MISMATCH (details.required), NOT_PENDING, or NOT_APPROVED ' +
            'while the agreement is still awaiting-approval',
        ),
      },
    },
  },
  '/hire-purchase/agreements/{id}/approve': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Let a counter-signed agreement stand (office only)',
      description:
        'An agreement signed by a teller is created awaiting-approval: the unit is ' +
        'reserved but no deposit may be taken and the customer has not been told the ' +
        'terms. Approving moves it to pending — where an office-signed agreement ' +
        'starts — and sends the signing SMS. Refused with NOT_AWAITING_APPROVAL for ' +
        'an agreement in any other state.',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Approved; now pending its deposit', agreementResult),
        '409': errorResponse('NOT_AWAITING_APPROVAL'),
      },
    },
  },
  '/hire-purchase/agreements/{id}/reject': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Reject an agreement before its deposit (restores stock)',
      description:
        'Takes an agreement that is pending or awaiting-approval. Nothing has been ' +
        'paid in either state and the unit goes back on the shelf either way.',
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
  '/hire-purchase/agreements/{id}/payments/{paymentId}/receipt': {
    get: {
      tags: ['Hire Purchase'],
      summary: 'Printable receipt for a deposit, instalment or redemption payment',
      description:
        'One endpoint for all three payment types — they are the same document with a ' +
        'different title. Balances are rebuilt as at THIS payment, so a reprint shows the ' +
        'position at the time it was issued rather than the position today.\n\n' +
        'A deposit receipt shows no remaining-balance figure: the deposit is not part of the ' +
        'financed balance, so the number would be meaningless until the agreement is ' +
        'priced. Binary response (application/pdf).',
      security,
      requestParams: {
        path: z.object({ id: z.string().describe('Agreement id'), paymentId: z.string() }),
      },
      responses: {
        '200': {
          description: 'The receipt',
          content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
        },
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/hire-purchase/items/{id}/receive': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Book a delivery, and reconcile the shelf with the invoice',
      description:
        'Adds the quantity and sets the cost to what this delivery actually cost per ' +
        'unit. The unit cost is required every time: the invoice is the only place the ' +
        'real figure exists, and a delivery is the moment somebody is holding it. When ' +
        'it differs from the shelf, the shelf moves and the move is written to the ' +
        'item’s price history with the supplier and invoice reference. Pass ' +
        '`sellingPrice` only when the delivery is also a repricing. Counter and office.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(receiveStockBody),
      responses: {
        '200': jsonResponse(
          'Received',
          z.object({
            item: hpItem,
            changes: z
              .array(hpPriceChange)
              .describe('The moves this delivery caused. Empty when the invoice matched.'),
          }),
        ),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('CONFLICT — stock changed concurrently, retry'),
        '422': errorResponse('INVALID_PRICING — the selling price is below cost'),
      },
    },
  },
  '/hire-purchase/items/{id}/price-changes': {
    get: {
      tags: ['Hire Purchase'],
      summary: 'Why this item’s cost or selling price moved, newest first',
      description:
        'One row per price that actually moved, from any route into the shelf: the edit ' +
        'drawer, a delivery, or the bulk importer. A delivery’s rows carry the quantity, ' +
        'supplier and invoice that brought the change. Filter with `kind`.',
      security,
      requestParams: { path: idParam, query: listPriceChangesQuery },
      responses: {
        '200': jsonResponse(
          'Price history',
          z.object({
            items: z.array(hpPriceChange),
            page: z.number(),
            limit: z.number(),
            total: z.number(),
          }),
        ),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/hire-purchase/damages': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Report damaged or missing stock',
      description:
        'Counter and office. Writes NOTHING off — the shelf is untouched until the ' +
        'office approves, so a mistaken report costs only a rejection. Photographs go ' +
        'through POST /uploads/images with kind=photo first.',
      security,
      requestBody: jsonBody(reportDamageBody),
      responses: {
        '201': jsonResponse('Reported', z.object({ damage: hpDamage })),
        '404': errorResponse('NOT_FOUND — no such item'),
        '422': errorResponse('OUT_OF_STOCK (details.quantityInStock) or FUTURE_DATE'),
      },
    },
    get: {
      tags: ['Hire Purchase'],
      summary: 'List damage reports',
      description:
        'Newest first by the day it happened. `totalCostValue` counts APPROVED reports ' +
        'only — a pending report is not a loss yet.' +
        ' Pass format=csv or xlsx for a download.',
      security,
      requestParams: { query: listDamagesQuery },
      responses: {
        '200': jsonResponse(
          'Damage reports',
          z.object({
            items: z.array(hpDamage),
            page: z.number(),
            limit: z.number(),
            total: z.number(),
            totalCostValue: z.number().int(),
            pendingCount: z.number().int(),
          }),
        ),
      },
    },
  },
  '/hire-purchase/damages/summary': {
    get: {
      tags: ['Hire Purchase'],
      summary: 'What the shop lost to damage in a period, by cause',
      description: 'Approved reports only, dated by the day the damage happened.',
      security,
      requestParams: { query: rangeOnlyQuery },
      responses: { '200': jsonResponse('Summary', damageSummary) },
    },
  },
  '/hire-purchase/damages/trash': {
    get: {
      tags: ['Hire Purchase'],
      summary: 'List binned damage reports (office only)',
      security,
      requestParams: { query: trashListQuery },
      responses: {
        '200': jsonResponse(
          'Binned reports',
          z.object({
            items: z.array(trashedHpDamage),
            page: z.number(),
            limit: z.number(),
            total: z.number(),
          }),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
      },
    },
  },
  '/hire-purchase/damages/{id}': {
    get: {
      tags: ['Hire Purchase'],
      summary: 'One damage report',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Report', z.object({ damage: hpDamage })),
        '404': errorResponse('NOT_FOUND'),
      },
    },
    patch: {
      tags: ['Hire Purchase'],
      summary: 'Correct a report that has not been decided',
      description:
        'Only while pending: once the office has approved or rejected it, changing what ' +
        'they decided on would make the decision meaningless.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(updateDamageBody),
      responses: {
        '200': jsonResponse('Updated', z.object({ damage: hpDamage })),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('ALREADY_REVIEWED'),
      },
    },
    delete: {
      tags: ['Hire Purchase'],
      summary: 'Bin a damage report (office only)',
      description:
        'Pending or rejected only. An approved damage has already moved the shelf and ' +
        'struck a loss; hiding the row would leave the stock short with nothing to ' +
        'explain it.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(trashBody),
      responses: {
        '200': jsonResponse('Binned', z.object({ damage: trashedHpDamage })),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '422': errorResponse('CANNOT_TRASH — the report was approved'),
      },
    },
  },
  '/hire-purchase/damages/{id}/approve': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Approve a damage: take it off the shelf and strike the loss (office only)',
      description:
        'The stock move and the valuation happen together, in one transaction. The cost ' +
        'is read from the item at that moment and stored on the report, never recomputed ' +
        'later — prices are editable, and a loss that re-priced itself would silently ' +
        'restate closed months. The person who reported the damage may not approve it.',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Approved', z.object({ damage: hpDamage })),
        '403': errorResponse('FORBIDDEN — office only, or SELF_APPROVAL'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('ALREADY_REVIEWED or CONFLICT'),
        '422': errorResponse(
          'OUT_OF_STOCK (details.quantityInStock, details.quantity) — fewer are on the ' +
            'shelf than the report claims; reject it and record the real quantity',
        ),
      },
    },
  },
  '/hire-purchase/damages/{id}/reject': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Refuse a damage report (office only)',
      description: 'The shelf is untouched — it never moved. The reporter sees the reason.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(rejectDamageBody),
      responses: {
        '200': jsonResponse('Rejected', z.object({ damage: hpDamage })),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('ALREADY_REVIEWED'),
      },
    },
  },
  '/hire-purchase/damages/{id}/restore': {
    post: {
      tags: ['Hire Purchase'],
      summary: 'Restore a binned damage report (office only)',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Restored', z.object({ damage: hpDamage })),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_TRASHED'),
      },
    },
  },
  ...labelPaths('brands', 'brand'),
  ...labelPaths('categories', 'category'),
};

import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import { pagination, trashBody } from '../../schemas/common.js';
import { rangeQuery } from '../reports/reports.schemas.js';
import { txnTotals, unifiedTransaction } from '../reports/reports.openapi.js';
import {
  bulkReassignBody,
  createCustomerBody,
  importRowsBody,
  listCustomersQuery,
  reassignCollectorBody,
  updateCustomerBody,
} from './customers.schemas.js';
import { IMPORT_COLUMNS, MAX_IMPORT_ROWS } from './customers.import.js';

const publicCustomer = z
  .object({
    id: z.string(),
    fullName: z.string().describe('As on the ID document'),
    dateOfBirth: z.iso.datetime().optional(),
    gender: z.enum(['male', 'female']).optional(),
    nationality: z.string().optional(),
    maritalStatus: z.enum(['single', 'married', 'other']).optional(),
    residentialAddress: z.string().optional(),
    phone: z.string(),
    altPhone: z.string().optional(),
    identification: z
      .object({
        idType: z.enum(['ghana-card', 'passport', 'drivers-license', 'voter-id']),
        idNumber: z.string(),
      })
      .optional()
      .describe('Optional for susu/savings; loans require a Ghana Card'),
    occupation: z.string().optional(),
    assignedCollectorId: z
      .string()
      .optional()
      .describe(
        'Collector who owns this customer; only they may collect from them. Absent ' +
          'for a customer who brings their deposits to the office and is on no round.',
      ),
    nextOfKin: z
      .object({
        fullName: z.string(),
        relationship: z.string().optional(),
        phone: z.string().optional(),
        address: z.string().optional(),
      })
      .optional(),
    photoUrl: z.string().optional().describe('From POST /uploads/images'),
    idDocumentFrontUrl: z
      .string()
      .optional()
      .describe(
        'ID front — from POST /uploads/images?kind=document. Optional on the profile; ' +
          'both sides must be on file before a loan or HP agreement can be opened',
      ),
    idDocumentBackUrl: z
      .string()
      .optional()
      .describe('ID back — from POST /uploads/images?kind=document. Optional, as above'),
    registeredById: z.string(),
    status: z.enum(['active', 'inactive']),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Customer' });

const customerResult = z.object({ customer: publicCustomer });
const customerList = z.object({
  items: z.array(publicCustomer),
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
});
const trashedCustomer = publicCustomer.extend({
  deletedAt: z.iso.datetime(),
  deletedById: z.string().optional(),
  deleteReason: z.string().optional(),
});
const trashedCustomerResult = z.object({ customer: trashedCustomer });
const trashedCustomerList = z.object({
  items: z.array(trashedCustomer),
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
});
const security = [{ bearerAuth: [] }];
const idParam = z.object({ id: z.string().describe('Customer id (24-char hex)') });

const customerStatement = z
  .object({
    customer: z.object({
      id: z.string(),
      fullName: z.string(),
      phone: z.string(),
      residentialAddress: z.string().nullable(),
    }),
    period: z.object({ from: z.string(), to: z.string() }),
    generatedAt: z.iso.datetime(),
    products: z.object({
      susu: z.array(
        z.object({
          accountId: z.string(),
          accountNumber: z
            .string()
            .describe("The customer's susu number — shared by every book they hold"),
          cycleMonth: z.string().optional().describe('The month this book is called'),
          ref: z.string().describe('This book itself: 260912134501-a3f9. Always distinct'),
          status: z.string(),
          dailyAmount: z.number().int(),
          depositsCount: z.number().int(),
          totalDeposited: z.number().int(),
          payoutRemaining: z.number().int(),
        }),
      ),
      savings: z.array(
        z.object({
          accountId: z.string(),
          accountNumber: z.string(),
          accountType: z.enum(['standard', 'student']),
          status: z.string(),
          openingBalance: z.number().int().describe('Balance at the start of the period'),
          closingBalance: z.number().int().describe('Balance at the end of the period'),
          currentBalance: z.number().int(),
        }),
      ),
      loans: z.array(
        z.object({
          loanId: z.string(),
          tier: z.string(),
          status: z.string(),
          principal: z.number().int(),
          totalDue: z.number().int(),
          totalRepaid: z.number().int(),
          remaining: z.number().int(),
          dueDate: z.iso.datetime().nullable(),
        }),
      ),
      hirePurchase: z.array(
        z.object({
          agreementId: z.string(),
          itemName: z.string(),
          status: z.string(),
          totalPayable: z.number().int().nullable(),
          totalPaid: z.number().int(),
          remaining: z.number().int().nullable(),
        }),
      ),
    }),
    totals: txnTotals,
    transactions: z
      .array(unifiedTransaction)
      .describe('Chronological (oldest first) within the period'),
    truncated: z.boolean().describe('True when the period held over 5,000 rows — narrow the range'),
  })
  .meta({ id: 'CustomerStatement' });

const importField = z
  .enum(IMPORT_COLUMNS.map((c) => c.field) as [string, ...string[]])
  .describe('The column an issue belongs to');

const rowIssue = z.object({
  field: importField.nullable().describe('Null when the fault is the row as a whole'),
  message: z.string(),
});

const previewRow = z.object({
  row: z.number().int().describe('The line in the sheet, so a message can name it'),
  values: z
    .record(z.string(), z.string())
    .describe('Every column as text, ready to be corrected and sent back'),
  assignedCollectorId: z
    .string()
    .describe(
      'Resolved from the collector cell. Empty when the cell was blank (the customer ' +
        'pays at the office) or when a name matched nobody, which is flagged as an issue.',
    ),
  issues: z.array(rowIssue),
});

const importPreview = z
  .object({
    rows: z.array(previewRow),
    unknownHeaders: z.array(z.string()).describe('Headings that matched no column'),
    collectors: z
      .array(z.object({ id: z.string(), name: z.string() }))
      .describe('Active collectors, for correcting a row that named nobody'),
    counts: z.object({
      total: z.number().int(),
      ready: z.number().int(),
      blocked: z.number().int(),
    }),
  })
  .meta({ id: 'CustomerImportPreview' });

const importOutcome = z
  .object({
    created: z.array(z.object({ row: z.number().int(), id: z.string(), fullName: z.string() })),
    failed: z.array(z.object({ row: z.number().int(), issues: z.array(rowIssue) })),
    counts: z.object({
      total: z.number().int(),
      created: z.number().int(),
      failed: z.number().int(),
    }),
  })
  .meta({ id: 'CustomerImportOutcome' });

const importColumnList = IMPORT_COLUMNS.map(
  (c) => `${c.header}${c.required ? ' (required)' : ''}`,
).join(', ');

export const customerPaths: ZodOpenApiPathsObject = {
  '/customers/import/template': {
    get: {
      tags: ['Customers'],
      summary: 'Download the blank import sheet (office only)',
      description:
        'Headings the importer reads, plus one example row. Columns: ' +
        `${importColumnList}. Headings are matched on letters and digits only, so ` +
        'case and spacing do not matter, and a few common alternatives are accepted ' +
        '(e.g. "Mobile" for Phone). format=csv (default) or xlsx.',
      security,
      requestParams: { query: z.object({ format: z.enum(['csv', 'xlsx']).optional() }) },
      responses: {
        '200': {
          description: 'The template',
          content: { 'text/csv': { schema: { type: 'string' } } },
        },
        '403': errorResponse('FORBIDDEN — office only'),
      },
    },
  },
  '/customers/import/preview': {
    post: {
      tags: ['Customers'],
      summary: 'Check a filled import sheet (office only, writes nothing)',
      description:
        'Multipart form with a `file` field carrying a .csv or .xlsx (max 5 MB, ' +
        `${String(MAX_IMPORT_ROWS)} rows). Every row is held to the same rules a single ` +
        'registration is, and the findings come back per cell so the office can correct ' +
        'them before anything is written. Also catches what only the whole file and the ' +
        'books can answer: a number repeated inside the sheet, or one already on a ' +
        'customer. NOTHING IS CREATED by this call.\n\n' +
        'A customer photo is the one thing a sheet cannot carry, so imported customers ' +
        'arrive without one — it is added at the counter later, as the ID scans are.',
      security,
      requestBody: {
        content: {
          'multipart/form-data': {
            schema: z.object({ file: z.string().meta({ format: 'binary' }) }),
          },
        },
      },
      responses: {
        '200': jsonResponse('Every row, with what is wrong with it', importPreview),
        '403': errorResponse('FORBIDDEN — office only'),
        '413': errorResponse('FILE_TOO_LARGE'),
        '415': errorResponse('UNSUPPORTED_FILE_TYPE — .csv or .xlsx only'),
        '422': errorResponse('EMPTY_FILE, NO_KNOWN_COLUMNS, TOO_MANY_ROWS, or UNREADABLE_FILE'),
      },
    },
  },
  '/customers/import': {
    post: {
      tags: ['Customers'],
      summary: 'Register the corrected rows (office only)',
      description:
        'Takes the rows the preview returned, with whatever the office changed. Every ' +
        'row is checked again — a preview may have sat open while somebody else took a ' +
        'phone number — and then registered one at a time. A row that fails does not ' +
        'stop the rest: it comes back in `failed` with its reason, ready to be corrected ' +
        'and sent again, while the rows that succeeded are simply absent from the retry.',
      security,
      requestBody: jsonBody(importRowsBody),
      responses: {
        '201': jsonResponse('What was registered and what was not', importOutcome),
        '403': errorResponse('FORBIDDEN — office only'),
        '422': errorResponse('EMPTY_IMPORT or TOO_MANY_ROWS'),
      },
    },
  },
  '/customers': {
    post: {
      tags: ['Customers'],
      summary: 'Register a customer (office only)',
      description:
        'Account creation happens at the office — collectors cannot create customers. ' +
        'The customer photo is required — upload it via POST /uploads/images first. The ' +
        'ID document images (front and back) are optional here, but no loan or hire-purchase ' +
        'agreement can be opened until both are on file. Phone numbers are accepted as ' +
        '0241234567, +233241234567 or 233241234567 (spaces, dashes and brackets are ' +
        'ignored) and always stored as the local 0-prefixed form; mobile prefixes only. ' +
        'Optional fields may be submitted blank ("" or null) and are simply omitted. ' +
        'Phone, alternate phone and ' +
        'next-of-kin phone must all be different numbers. ID numbers are format-checked ' +
        'per type (Ghana Card GHA-123456789-0, voter ID 8 digits, passport G12345678, ' +
        "driver's licence 10-20 alphanumerics). Customers must be at least 10 years old.",
      security,
      requestBody: jsonBody(createCustomerBody),
      responses: {
        '201': jsonResponse('Created', customerResult),
        '409': errorResponse('PHONE_TAKEN or ID_TAKEN'),
        '422': errorResponse(
          'INVALID_COLLECTOR — assignedCollectorId names somebody who is not an active ' +
            'collector. Omitting it entirely is allowed: that is a customer who pays at ' +
            'the office.',
        ),
      },
    },
    get: {
      tags: ['Customers'],
      summary: 'List customers',
      description:
        'Collectors see ONLY the customers assigned to them; office roles see ' +
        'all and may narrow with assignedCollectorId, or find gaps with ' +
        'unassigned=true (both ignored for collectors, who are always pinned ' +
        'to their own round). `search` is fuzzy (typo-tolerant name, ' +
        'phone) and returns results in relevance order. Pass format=csv or ' +
        'format=xlsx to download the listing as a spreadsheet (pagination is ' +
        'ignored; capped at 10,000 rows).',
      security,
      requestParams: { query: listCustomersQuery },
      responses: {
        '200': jsonResponse('Paginated customers', customerList),
      },
    },
  },
  '/customers/trash': {
    get: {
      tags: ['Customers'],
      summary: 'List trashed customers (office only)',
      description: 'Paginated, most recently trashed first.',
      security,
      requestParams: { query: pagination },
      responses: {
        '200': jsonResponse('Paginated trashed customers', trashedCustomerList),
      },
    },
  },
  '/customers/reassign-collector': {
    post: {
      tags: ['Customers'],
      summary: "Hand a collector's whole round to another collector (admin only)",
      description:
        'Bulk reassignment for when a collector leaves or swaps zones. Transactional: ' +
        'either every customer moves or none does. Writes one audit entry per customer, ' +
        'so the ledger can still answer "who owned this customer on that day?".',
      security,
      requestBody: jsonBody(bulkReassignBody),
      responses: {
        '200': jsonResponse(
          'How many moved',
          z.object({
            fromCollectorId: z.string(),
            toCollectorId: z.string(),
            reassigned: z.number().int(),
          }),
        ),
        '403': errorResponse('FORBIDDEN — admin only'),
        '422': errorResponse('INVALID_COLLECTOR — toCollectorId is not an active collector'),
      },
    },
  },
  '/customers/{id}/collector': {
    patch: {
      tags: ['Customers'],
      summary: 'Move one customer between rounds, or off them (counter)',
      description:
        'Counter work — admin, manager or teller: whoever registers a customer puts ' +
        'them on a round, and the same people may move them. Handing over a whole ' +
        'round (POST /customers/reassign-collector) stays admin-only. ' +
        'Idempotent when the customer is already where ' +
        'you are putting them. Send `collectorId: null` to take the customer off ' +
        'every round — the customer who brings deposits to the counter instead of ' +
        'being collected from. This is the ONLY way to change assignedCollectorId — ' +
        'PATCH /customers/{id} ignores the field.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(reassignCollectorBody),
      responses: {
        '200': jsonResponse('Updated customer', customerResult),
        '403': errorResponse('FORBIDDEN — collectors may not move customers'),
        '404': errorResponse('NOT_FOUND'),
        '422': errorResponse('INVALID_COLLECTOR — not an active collector account'),
      },
    },
  },
  '/customers/{id}': {
    get: {
      tags: ['Customers'],
      summary: 'Get one customer',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('The customer', customerResult),
        '403': errorResponse('CUSTOMER_NOT_ASSIGNED — collector reaching outside their round'),
        '404': errorResponse('NOT_FOUND'),
      },
    },
    delete: {
      tags: ['Customers'],
      summary: 'Move a customer to the trash (office only)',
      description:
        'Soft delete: the customer disappears from normal listings and lookups but stays ' +
        'restorable via POST /customers/{id}/restore. Refused (CANNOT_TRASH) while the ' +
        'customer still has open susu accounts, savings accounts, loans or hire-purchase ' +
        'agreements. The phone number stays reserved (unique index) while the customer is ' +
        'in the trash.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(trashBody),
      responses: {
        '200': jsonResponse('Trashed customer', trashedCustomerResult),
        '404': errorResponse('NOT_FOUND'),
        '422': errorResponse('CANNOT_TRASH — details: { susu, savings, loans, hirePurchase }'),
      },
    },
    patch: {
      tags: ['Customers'],
      summary: 'Update customer profile (office only)',
      description:
        'Inactive customers cannot be edited — reactivate first. Optional fields accept ' +
        '"" or null to CLEAR them; omit a field to leave it unchanged. The ID document ' +
        'images clear the same way, except while the customer has an open loan or ' +
        'hire-purchase agreement (ID_DOCUMENT_IN_USE) — replacing a scan is always fine. ' +
        'assignedCollectorId is ignored here — use PATCH /customers/{id}/collector.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(updateCustomerBody),
      responses: {
        '200': jsonResponse('Updated customer', customerResult),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('PHONE_TAKEN, ID_TAKEN, or CUSTOMER_INACTIVE'),
        '422': errorResponse(
          'PHONES_NOT_DISTINCT, or ID_DOCUMENT_IN_USE — details: { loans, hirePurchase }',
        ),
      },
    },
  },
  '/customers/{id}/registration-form': {
    get: {
      tags: ['Customers'],
      summary: 'Printable registration form PDF (office only)',
      description:
        'A4 PDF of the full registration record — personal details, contact, ' +
        'identification, occupation, next of kin, administration — with the ' +
        'customer photo embedded and signature lines at the bottom. ' +
        'Binary response (application/pdf).',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': {
          description: 'The registration form',
          content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
        },
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/customers/{id}/statement': {
    get: {
      tags: ['Customers'],
      summary: 'Statement of account (office only)',
      description:
        'Every product the customer holds (susu, savings, loans, hire purchase) with ' +
        'period opening/closing positions, plus the unified transaction history for an ' +
        'inclusive Accra-day range (defaults to the last 30 days). All amounts are ' +
        'integer pesewas. Pass format=csv to download the transaction rows as CSV.',
      security,
      requestParams: { path: idParam, query: rangeQuery },
      responses: {
        '200': jsonResponse('The statement', customerStatement),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/customers/{id}/deactivate': {
    post: {
      tags: ['Customers'],
      summary: 'Deactivate a customer (office only)',
      description:
        'Idempotent. Deactivation blocks edits but keeps the customer visible; ' +
        'to remove one from listings use DELETE /customers/{id}, which moves it to the trash.',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Deactivated customer', customerResult),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/customers/{id}/activate': {
    post: {
      tags: ['Customers'],
      summary: 'Reactivate a customer (office only)',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Reactivated customer', customerResult),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/customers/{id}/restore': {
    post: {
      tags: ['Customers'],
      summary: 'Restore a customer from the trash (office only)',
      description: 'Clears the trash fields; the customer reappears in normal listings.',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Restored customer', customerResult),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_TRASHED — the customer is not in the trash'),
      },
    },
  },
};

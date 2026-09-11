import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { EXPENSE_CATEGORIES, EXPENSE_STATUSES } from '../../models/index.js';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import { trashBody } from '../../schemas/common.js';
import {
  attachReceiptBody,
  createExpenseBody,
  expenseSummaryQuery,
  listExpensesQuery,
  payExpenseBody,
  rejectExpenseBody,
  trashListQuery,
  updateExpenseBody,
} from './expenses.schemas.js';

const security = [{ bearerAuth: [] }];
const csvNote = ' Pass format=csv or xlsx for a download of the whole filtered set.';
const idParam = z.object({ id: z.string() });
const money = z.number().int().describe('Integer pesewas');

const expense = z
  .object({
    id: z.string(),
    category: z.enum(EXPENSE_CATEGORIES),
    description: z.string(),
    amount: money,
    payee: z.string().optional(),
    incurredOn: z
      .string()
      .describe('The Accra day the COST belongs to — August salaries paid in September are August'),
    status: z.enum(EXPENSE_STATUSES),
    cashAccountId: z.string().optional().describe('Set at payment, never before'),
    paidOn: z.string().optional(),
    recordedById: z.string(),
    recordedByName: z.string().optional(),
    approvedById: z.string().optional(),
    approvedByName: z.string().optional(),
    approvedAt: z.iso.datetime().optional(),
    rejectionReason: z.string().optional(),
    receiptUrl: z.string().optional(),
    reference: z.string().optional(),
    writeOffEntityType: z.string().optional(),
    writeOffEntityId: z.string().optional(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Expense' });

const trashedExpense = expense.extend({
  deletedAt: z.iso.datetime(),
  deletedById: z.string().optional(),
  deleteReason: z.string().optional(),
});

const expenseSummary = z
  .object({
    from: z.string().nullable(),
    to: z.string().nullable(),
    totalAmount: money.describe('Every non-rejected expense in the period'),
    totalCount: z.number().int(),
    byCategory: z.array(
      z.object({
        category: z.enum(EXPENSE_CATEGORIES),
        count: z.number().int(),
        amount: money,
      }),
    ),
    byStatus: z.array(z.object({ status: z.string(), count: z.number().int(), amount: money })),
    outstandingAmount: money.describe('Incurred but not yet paid'),
  })
  .meta({ id: 'ExpenseSummary' });

export const expensePaths: ZodOpenApiPathsObject = {
  '/expenses': {
    post: {
      tags: ['Expenses'],
      summary: 'Record a cost',
      description:
        'Counter and office. Records a cost; it does NOT move money — only ' +
        'POST /expenses/{id}/pay does that, which is why only that step names an ' +
        'account. Dated by the day the cost BELONGS to, not the day it was keyed.',
      security,
      requestBody: jsonBody(createExpenseBody),
      responses: { '201': jsonResponse('Recorded', z.object({ expense })) },
    },
    get: {
      tags: ['Expenses'],
      summary: 'Expenses, filtered by category, status, account or date' + csvNote,
      security,
      requestParams: { query: listExpensesQuery },
      responses: {
        '200': jsonResponse(
          'Expenses',
          z.object({
            items: z.array(expense),
            page: z.number(),
            limit: z.number(),
            total: z.number(),
            totalAmount: money.describe('Across ALL pages matching the filters'),
          }),
        ),
      },
    },
  },
  '/expenses/summary': {
    get: {
      tags: ['Expenses'],
      summary: 'What was spent in a period, by category and by status',
      description:
        'Dated by incurredOn, like the profit and loss, so the two agree. Rejected ' +
        'expenses are left out of the totals — they are not costs — but kept in the ' +
        'status breakdown so the counts still add up.',
      security,
      requestParams: { query: expenseSummaryQuery },
      responses: { '200': jsonResponse('Summary', expenseSummary) },
    },
  },
  '/expenses/trash': {
    get: {
      tags: ['Expenses'],
      summary: 'List binned expenses (office only)',
      security,
      requestParams: { query: trashListQuery },
      responses: {
        '200': jsonResponse(
          'Binned expenses',
          z.object({
            items: z.array(trashedExpense),
            page: z.number(),
            limit: z.number(),
            total: z.number(),
          }),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
      },
    },
  },
  '/expenses/{id}': {
    get: {
      tags: ['Expenses'],
      summary: 'One expense',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Expense', z.object({ expense })),
        '404': errorResponse('NOT_FOUND'),
      },
    },
    patch: {
      tags: ['Expenses'],
      summary: 'Correct an expense that has not been approved',
      description:
        'Only while pending: once somebody has approved an amount, changing it behind ' +
        'them would make the approval meaningless.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(updateExpenseBody),
      responses: {
        '200': jsonResponse('Updated', z.object({ expense })),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_PENDING'),
      },
    },
    delete: {
      tags: ['Expenses'],
      summary: 'Bin an expense (office only)',
      description:
        'Pending or rejected only. An approved expense is already a liability on the ' +
        'balance sheet and a paid one has already moved cash; removing either would ' +
        'silently restate a period somebody may have acted on.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(trashBody),
      responses: {
        '200': jsonResponse('Binned', z.object({ expense: trashedExpense })),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '422': errorResponse('CANNOT_TRASH — the expense is approved or paid'),
      },
    },
  },
  '/expenses/{id}/receipt': {
    post: {
      tags: ['Expenses'],
      summary: 'Attach or replace the receipt photograph',
      description:
        'Allowed at any status: a receipt turning up after approval is the ordinary ' +
        'case. Upload through POST /uploads/images with kind=document first.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(attachReceiptBody),
      responses: {
        '200': jsonResponse('Attached', z.object({ expense })),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/expenses/{id}/approve': {
    post: {
      tags: ['Expenses'],
      summary: 'Approve an expense (office only)',
      description:
        'Makes it a liability on the balance sheet. Still moves no cash. The person who ' +
        'recorded it may not approve it.',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Approved', z.object({ expense })),
        '403': errorResponse('FORBIDDEN — office only, or SELF_APPROVAL'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_PENDING'),
      },
    },
  },
  '/expenses/{id}/reject': {
    post: {
      tags: ['Expenses'],
      summary: 'Reject an expense (office only)',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(rejectExpenseBody),
      responses: {
        '200': jsonResponse('Rejected', z.object({ expense })),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_PENDING'),
      },
    },
  },
  '/expenses/{id}/pay': {
    post: {
      tags: ['Expenses'],
      summary: 'Pay an approved expense from a named account (office only)',
      description:
        'The only step that moves money, which is why it is the only one that names an ' +
        'account. The payment day may differ from the day the cost belongs to.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(payExpenseBody),
      responses: {
        '200': jsonResponse('Paid', z.object({ expense })),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('ALREADY_PAID'),
        '422': errorResponse('NOT_APPROVED or BEFORE_OPENING_DATE'),
      },
    },
  },
  '/expenses/{id}/restore': {
    post: {
      tags: ['Expenses'],
      summary: 'Restore a binned expense (office only)',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Restored', z.object({ expense })),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_TRASHED'),
      },
    },
  },
};

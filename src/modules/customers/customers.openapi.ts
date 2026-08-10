import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import { rangeQuery } from '../reports/reports.schemas.js';
import { txnTotals, unifiedTransaction } from '../reports/reports.openapi.js';
import { createCustomerBody, listCustomersQuery, updateCustomerBody } from './customers.schemas.js';

const publicCustomer = z
  .object({
    id: z.string(),
    fullName: z.string().describe('As on the ID document'),
    dateOfBirth: z.iso.datetime().optional(),
    gender: z.enum(['male', 'female']).optional(),
    nationality: z.string().optional(),
    maritalStatus: z.enum(['single', 'married', 'other']).optional(),
    mothersMaidenName: z.string().optional(),
    residentialAddress: z.string().optional(),
    ghanaPostGps: z.string().optional(),
    postalAddress: z.string().optional(),
    phone: z.string(),
    altPhone: z.string().optional(),
    email: z.string().optional(),
    identification: z
      .object({
        idType: z.enum(['ghana-card', 'passport', 'drivers-license', 'voter-id']),
        idNumber: z.string(),
        idExpiryDate: z.iso.datetime().optional(),
        idPlaceOfIssue: z.string().optional(),
      })
      .optional()
      .describe('Optional for susu/savings; loans require a Ghana Card'),
    occupation: z.string().optional(),
    employerOrBusiness: z.string().optional(),
    purposeOfAccount: z.string().optional(),
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
      .describe('ID front — from POST /uploads/images?kind=document'),
    idDocumentBackUrl: z
      .string()
      .optional()
      .describe('ID back — from POST /uploads/images?kind=document'),
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
const security = [{ bearerAuth: [] }];
const idParam = z.object({ id: z.string().describe('Customer id (24-char hex)') });

const customerStatement = z
  .object({
    customer: z.object({
      id: z.string(),
      fullName: z.string(),
      phone: z.string(),
      email: z.string().nullable(),
      residentialAddress: z.string().nullable(),
    }),
    period: z.object({ from: z.string(), to: z.string() }),
    generatedAt: z.iso.datetime(),
    products: z.object({
      susu: z.array(
        z.object({
          accountId: z.string(),
          accountNumber: z.string(),
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

export const customerPaths: ZodOpenApiPathsObject = {
  '/customers': {
    post: {
      tags: ['Customers'],
      summary: 'Register a customer (office only)',
      description:
        'Account creation happens at the office — collectors cannot create customers. ' +
        'The customer photo and both ID document images (front and back) are required — ' +
        'upload them via POST /uploads/images first. Phone, alternate phone and ' +
        'next-of-kin phone must all be different numbers. ID numbers are format-checked ' +
        'per type (Ghana Card GHA-123456789-0, voter ID 8 digits, passport G12345678, ' +
        "driver's licence 10-20 alphanumerics). Customers must be at least 10 years old.",
      security,
      requestBody: jsonBody(createCustomerBody),
      responses: {
        '201': jsonResponse('Created', customerResult),
        '409': errorResponse('PHONE_TAKEN or ID_TAKEN'),
      },
    },
    get: {
      tags: ['Customers'],
      summary: 'List customers',
      description:
        'All roles see all customers. `search` is fuzzy (typo-tolerant name, ' +
        'phone) and returns results in relevance order.',
      security,
      requestParams: { query: listCustomersQuery },
      responses: {
        '200': jsonResponse('Paginated customers', customerList),
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

        '404': errorResponse('NOT_FOUND'),
      },
    },
    patch: {
      tags: ['Customers'],
      summary: 'Update customer profile (office only)',
      description: 'Inactive customers cannot be edited — reactivate first.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(updateCustomerBody),
      responses: {
        '200': jsonResponse('Updated customer', customerResult),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('PHONE_TAKEN, ID_TAKEN, or CUSTOMER_INACTIVE'),
        '422': errorResponse('PHONES_NOT_DISTINCT'),
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
      description: 'Idempotent. No delete exists — history must stay intact.',
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
};

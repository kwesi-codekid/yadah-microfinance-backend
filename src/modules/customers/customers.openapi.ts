import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
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

export const customerPaths: ZodOpenApiPathsObject = {
  '/customers': {
    post: {
      tags: ['Customers'],
      summary: 'Register a customer (office only)',
      description: 'Account creation happens at the office — collectors cannot create customers.',
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
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(updateCustomerBody),
      responses: {
        '200': jsonResponse('Updated customer', customerResult),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('PHONE_TAKEN or ID_TAKEN'),
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

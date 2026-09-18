import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { ROLES } from '../../models/index.js';
import { errorResponse, jsonResponse } from '../../openapi/shared.js';
import { listAuditLogsQuery } from './audit-logs.schemas.js';

/**
 * One entry in the trail: who did what to which record, and the figures
 * before and after where money moved.
 */
export const auditLog = z
  .object({
    id: z.string(),
    actorId: z.string().describe('The staff account that made the change'),
    actorName: z.string().optional().describe('Joined for display'),
    actorRole: z.enum(ROLES).optional().describe('The role that account holds now'),
    action: z
      .string()
      .describe(
        'Dot-notation, module first: susu.deposit.record, loan.approve, ' +
          'customer.collector.reassign, user.disable',
      ),
    entityType: z
      .string()
      .describe('Kebab-case record type: customer, susu-account, loan, hp-agreement, user…'),
    entityId: z.string(),
    entityLabel: z
      .string()
      .optional()
      .describe(
        'The record’s own name or number — a customer’s name, an account number ' +
          'with its # — where the type has one and the record still exists',
      ),
    amountBefore: z
      .number()
      .int()
      .optional()
      .describe('Money mutations only: the balance or total before, pesewas'),
    amountAfter: z.number().int().optional().describe('…and after, pesewas'),
    before: z.unknown().optional().describe('Snapshot of the fields as they were'),
    after: z.unknown().optional().describe('Snapshot of the fields as they became'),
    requestId: z
      .string()
      .optional()
      .describe('The HTTP request that made the change, for matching against the server logs'),
    method: z.string().optional().describe('The HTTP method of that request: POST, PATCH…'),
    path: z
      .string()
      .optional()
      .describe('The endpoint as called, without the query string: /api/v1/susu/accounts/…'),
    userAgent: z
      .string()
      .optional()
      .describe('The caller’s user agent: the browser, or the collector app’s HTTP client'),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AuditLog' });

const security = [{ bearerAuth: [] }];

export const auditLogPaths: ZodOpenApiPathsObject = {
  '/audit-logs': {
    get: {
      tags: ['Audit Log'],
      summary: 'The trail of every change made through the API (office only)',
      description:
        'Newest first. Every mutating action writes one entry alongside the change, in ' +
        'the same transaction, so a change with no entry and an entry with no change are ' +
        'both impossible. Each entry also records where the change came from — the ' +
        'endpoint and the caller’s user agent — read off the request; a ' +
        'background worker’s entries carry none of that. Read-only: nothing here can be ' +
        'written, edited or deleted.\n\n' +
        'Narrow by who (`actorId`), by what kind of record and which one (`entityType`, ' +
        '`entityId`), by when (`from`/`to`, inclusive Accra days), or by action. `action` ' +
        'is a prefix: `susu` reaches every susu action, `susu.deposit` the deposit ones, ' +
        '`susu.deposit.record` exactly that one. Several prefixes may be given ' +
        'comma-separated.\n\n' +
        '`format=csv|xlsx` downloads the filtered set as a spreadsheet, ignoring ' +
        'pagination and capped at 10,000 rows. The `before` and `after` snapshots travel ' +
        'as JSON in one cell each.',
      security,
      requestParams: { query: listAuditLogsQuery },
      responses: {
        '200': jsonResponse(
          'Paginated entries, or a CSV/XLSX attachment when format is set',
          z.object({
            items: z.array(auditLog),
            page: z.number(),
            limit: z.number(),
            total: z.number(),
          }),
        ),
        '400': errorResponse('VALIDATION_ERROR'),
        '403': errorResponse('FORBIDDEN — office only'),
      },
    },
  },
};

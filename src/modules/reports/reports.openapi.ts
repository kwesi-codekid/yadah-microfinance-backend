import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { jsonResponse } from '../../openapi/shared.js';
import { formatOnlyQuery, rangeQuery } from './reports.schemas.js';

const security = [{ bearerAuth: [] }];
const csvNote = ' Pass format=csv for a downloadable CSV.';

export const reportPaths: ZodOpenApiPathsObject = {
  '/reports/collections': {
    get: {
      tags: ['Reports'],
      summary: 'Collections by staff member over a date range',
      description:
        'Susu and savings deposits recorded per user (reconciliation: who brought in what). ' +
        'Defaults to the last 30 Accra days.' +
        csvNote,
      security,
      requestParams: { query: rangeQuery },
      responses: { '200': jsonResponse('Report', z.unknown()) },
    },
  },
  '/reports/loans/outstanding': {
    get: {
      tags: ['Reports'],
      summary: 'All open loans with remaining balances and days overdue',
      description: 'Active and arrears loans, soonest due first.' + csvNote,
      security,
      requestParams: { query: formatOnlyQuery },
      responses: { '200': jsonResponse('Report', z.unknown()) },
    },
  },
  '/reports/loans/aging': {
    get: {
      tags: ['Reports'],
      summary: 'Arrears aging buckets (1–30 / 31–90 / 90+ days)',
      security,
      requestParams: { query: formatOnlyQuery },
      responses: { '200': jsonResponse('Report', z.unknown()) },
    },
  },
  '/reports/commission': {
    get: {
      tags: ['Reports'],
      summary: 'Revenue earned: susu commissions + savings fees',
      description:
        'Susu closure commissions and savings withdrawal/closure fees in the range.' + csvNote,
      security,
      requestParams: { query: rangeQuery },
      responses: { '200': jsonResponse('Report', z.unknown()) },
    },
  },
};

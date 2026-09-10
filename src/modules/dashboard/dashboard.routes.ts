import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireCounter } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import { listTransactions } from '../reports/transactions.service.js';
import * as alertsService from './alerts.service.js';
import * as dashboardService from './dashboard.service.js';
import * as seriesService from './series.service.js';
import {
  efficiencyQuery,
  recentQuery,
  seriesQuery,
  type EfficiencyQuery,
  type RecentQuery,
  type SeriesQuery,
} from './dashboard.schemas.js';

/**
 * Everything the office dashboard screen reads, grouped behind one prefix so
 * the frontend has a single surface to work against rather than assembling the
 * screen from five different modules.
 *
 * JSON only — these payloads are nested and would not flatten to a meaningful
 * CSV. Exports live on /reports, which is the reporting surface.
 *
 * Office-only, like /reports: collectors have no whole-business view (see
 * lib/realtime.ts, which keeps the admin socket feed office-only for the same
 * reason).
 */
export const dashboardRouter = Router();
// Read-only figures about money the counter itself handles, so the counter
// may see them. A collector still gets their own day instead, from
// /collectors/me/day, which is scoped to them.
dashboardRouter.use(requireAuth, requireCounter);

dashboardRouter.get('/summary', (_req, res, next) => {
  dashboardService
    .dashboardMetrics()
    .then((metrics) => res.json(metrics))
    .catch(next);
});

dashboardRouter.get('/series', validate({ query: seriesQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: SeriesQuery }>(req);
  seriesService
    .cashSeries(query)
    .then((series) => res.json(series))
    .catch(next);
});

dashboardRouter.get('/efficiency', validate({ query: efficiencyQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: EfficiencyQuery }>(req);
  seriesService
    .collectionEfficiency(query.from, query.to)
    .then((efficiency) => res.json(efficiency))
    .catch(next);
});

dashboardRouter.get('/alerts', (_req, res, next) => {
  alertsService
    .dashboardAlerts()
    .then((result) => res.json(result))
    .catch(next);
});

// A short window onto the transaction feed for the dashboard's activity panel.
// Deeper filtering and paging belong on /reports/transactions.
dashboardRouter.get('/recent-transactions', validate({ query: recentQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: RecentQuery }>(req);
  listTransactions({
    page: 1,
    limit: query.limit,
    includePending: query.includePending,
    format: 'json',
  })
    .then((feed) => res.json({ items: feed.items, totals: feed.totals }))
    .catch(next);
});

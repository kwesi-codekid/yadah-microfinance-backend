import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireCounter } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import { collectorDayQuery, type CollectorDayQuery } from './collectors.schemas.js';
import * as service from './collectors.service.js';

/**
 * The field app's two home screens. Open to collectors — unlike /dashboard,
 * which is the whole-business office view — and to office roles inspecting a
 * named collector.
 */
export const collectorsRouter = Router();
collectorsRouter.use(requireAuth);

/**
 * The roster, for the counter. Registering a customer means putting them on
 * somebody's round, so whoever is at the counter has to be able to see who
 * those somebodies are — without being handed the staff directory, which is
 * what `GET /users` is and which stays the office's.
 *
 * Registered before `/me/*` so neither shadows the other.
 */
collectorsRouter.get('/', requireCounter, (_req, res, next) => {
  service
    .listCollectors()
    .then((collectors) => res.json({ collectors }))
    .catch(next);
});

// What still has to be collected today.
collectorsRouter.get('/me/round', validate({ query: collectorDayQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: CollectorDayQuery }>(req);
  service
    .collectorRound(getAuth(req), query.date, query.collectorId)
    .then((round) => res.json(round))
    .catch(next);
});

// What has been collected so far, across susu and savings.
collectorsRouter.get('/me/day', validate({ query: collectorDayQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: CollectorDayQuery }>(req);
  service
    .collectorDay(getAuth(req), query.date, query.collectorId)
    .then((day) => res.json(day))
    .catch(next);
});

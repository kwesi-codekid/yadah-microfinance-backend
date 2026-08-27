import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
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

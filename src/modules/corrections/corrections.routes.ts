import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireCounter, requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  correctionIdParams,
  listCorrectionsQuery,
  rejectCorrectionBody,
  type CorrectionIdParams,
  type ListCorrectionsQuery,
  type RejectCorrectionBody,
} from './corrections.schemas.js';
import * as corrections from './corrections.service.js';

/**
 * The queue of corrections tellers asked for, and the office's decisions on
 * them. Asking lives with the transaction being asked about — each module's
 * `POST .../corrections` — because the rules on the amount are the module's;
 * the queue and the deciding are the same whatever the figure is on, so they
 * live here.
 *
 * The whole counter reads the queue (see the service for why); only the
 * office decides. Approving applies the correction, so it is gated exactly
 * as the module's own PATCH is.
 */
export const correctionsRouter = Router();
correctionsRouter.use(requireAuth);

correctionsRouter.get(
  '/',
  requireCounter,
  validate({ query: listCorrectionsQuery }),
  (req, res, next) => {
    const { query } = getValidated<{ query: ListCorrectionsQuery }>(req);
    corrections
      .list(getAuth(req), query)
      .then((list) => res.json(list))
      .catch(next);
  },
);

correctionsRouter.post(
  '/:correctionId/approve',
  requireOffice,
  validate({ params: correctionIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: CorrectionIdParams }>(req);
    corrections
      .approve(getAuth(req), params.correctionId, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);

correctionsRouter.post(
  '/:correctionId/reject',
  requireOffice,
  validate({ params: correctionIdParams, body: rejectCorrectionBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{
      params: CorrectionIdParams;
      body: RejectCorrectionBody;
    }>(req);
    corrections
      .reject(getAuth(req), params.correctionId, body.reason, req.id as string)
      .then((correction) => res.json({ correction }))
      .catch(next);
  },
);

// Whoever asked takes it back. The service holds the line on who that is.
correctionsRouter.post(
  '/:correctionId/cancel',
  requireCounter,
  validate({ params: correctionIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: CorrectionIdParams }>(req);
    corrections
      .cancel(getAuth(req), params.correctionId, req.id as string)
      .then((correction) => res.json({ correction }))
      .catch(next);
  },
);

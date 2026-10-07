import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import { trashBody, type TrashBody } from '../../schemas/common.js';
import {
  createMoveBody,
  listCommissionsQuery,
  listMovesQuery,
  moveIdParams,
  type CreateMoveBody,
  type ListCommissionsQuery,
  type ListMovesQuery,
  type MoveIdParams,
} from './commissions.schemas.js';
import * as commissions from './commissions.service.js';

export const commissionsRouter = Router();

/**
 * Yadah's commission account is the company's money, not a customer's: the
 * office reads it and moves it on (client decision, 7 Oct 2026).
 */
commissionsRouter.use(requireAuth, requireOffice);

commissionsRouter.get('/summary', (_req, res, next) => {
  commissions
    .summary()
    .then((result) => res.json(result))
    .catch(next);
});

commissionsRouter.get('/', validate({ query: listCommissionsQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListCommissionsQuery }>(req);
  commissions
    .listCommissions(query)
    .then((result) => res.json(result))
    .catch(next);
});

commissionsRouter.get('/moves', validate({ query: listMovesQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListMovesQuery }>(req);
  commissions
    .listMoves(query)
    .then((result) => res.json(result))
    .catch(next);
});

commissionsRouter.post('/moves', validate({ body: createMoveBody }), (req, res, next) => {
  const { body } = getValidated<{ body: CreateMoveBody }>(req);
  commissions
    .createMove(getAuth(req), body, req.id as string)
    .then((result) => res.status(result.replayed ? 200 : 201).json(result))
    .catch(next);
});

commissionsRouter.post(
  '/moves/:id/trash',
  validate({ params: moveIdParams, body: trashBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: MoveIdParams; body: TrashBody }>(req);
    commissions
      .trashMove(getAuth(req), params.id, body.reason, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);

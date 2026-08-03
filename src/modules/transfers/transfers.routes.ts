import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import { transferBody, type TransferBody } from './transfers.schemas.js';
import * as transfersService from './transfers.service.js';

export const transfersRouter = Router();
transfersRouter.use(requireAuth, requireOffice);

transfersRouter.post('/', validate({ body: transferBody }), (req, res, next) => {
  const { body } = getValidated<{ body: TransferBody }>(req);
  transfersService
    .transfer(getAuth(req), body, req.id as string)
    .then((result) => res.status(result.replayed ? 200 : 201).json(result))
    .catch(next);
});

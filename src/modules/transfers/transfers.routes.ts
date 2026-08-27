import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import { z } from 'zod';
import { objectId } from '../../schemas/common.js';
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

const transferIdParams = z.object({ id: objectId });
type TransferIdParams = z.infer<typeof transferIdParams>;

// Printable proof of an internal move, for the customer's own records.
transfersRouter.get('/:id/receipt', validate({ params: transferIdParams }), (req, res, next) => {
  const { params } = getValidated<{ params: TransferIdParams }>(req);
  transfersService
    .transferReceipt(params.id)
    .then(({ buffer, filename }) => {
      res.type('application/pdf').attachment(filename).send(buffer);
    })
    .catch(next);
});

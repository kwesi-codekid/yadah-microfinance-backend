import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  listRequestsQuery,
  rejectRequestBody,
  requestIdParams,
  type ListRequestsQuery,
  type RejectRequestBody,
  type RequestIdParams,
} from './portal.schemas.js';
import * as service from './payout-requests.service.js';

/**
 * The office side of customer withdrawal requests.
 *
 * Office-only, because approving one EXECUTES the withdrawal — the same
 * office-only action it would be at the counter.
 */
export const payoutRequestsRouter = Router();
payoutRequestsRouter.use(requireAuth, requireOffice);

payoutRequestsRouter.get('/', validate({ query: listRequestsQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListRequestsQuery }>(req);
  service
    .listRequests(query)
    .then((list) => res.json(list))
    .catch(next);
});

payoutRequestsRouter.get('/:id', validate({ params: requestIdParams }), (req, res, next) => {
  const { params } = getValidated<{ params: RequestIdParams }>(req);
  service
    .getRequest(params.id)
    .then((request) => res.json({ request }))
    .catch(next);
});

// Executes the withdrawal, then pushes the money to the customer's wallet.
payoutRequestsRouter.post(
  '/:id/approve',
  validate({ params: requestIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: RequestIdParams }>(req);
    service
      .approveRequest(getAuth(req), params.id, req.id as string)
      .then((request) => res.json({ request }))
      .catch(next);
  },
);

payoutRequestsRouter.post(
  '/:id/reject',
  validate({ params: requestIdParams, body: rejectRequestBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{
      params: RequestIdParams;
      body: RejectRequestBody;
    }>(req);
    service
      .rejectRequest(getAuth(req), params.id, body.reason, req.id as string)
      .then((request) => res.json({ request }))
      .catch(next);
  },
);

// Fallback when a transfer webhook was missed — ask Paystack directly.
payoutRequestsRouter.post(
  '/:id/verify-transfer',
  validate({ params: requestIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: RequestIdParams }>(req);
    service
      .verifyTransferNow(params.id)
      .then((request) => res.json({ request }))
      .catch(next);
  },
);

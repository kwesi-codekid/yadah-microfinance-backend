import { Router, type Request, type RequestHandler, type Response } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { getValidated, validate } from '../../middleware/validate.js';
import { verifyWebhookSignature } from '../../lib/paystack.js';
import {
  chargeBody,
  referenceParams,
  type ChargeBody,
  type ReferenceParams,
} from './payments.schemas.js';
import * as paymentsService from './payments.service.js';

export const paymentsRouter = Router();
paymentsRouter.use(requireAuth);

// Kick off a mobile-money charge; the customer approves on their handset and
// the outcome lands via the webhook (or POST /charges/:reference/verify).
paymentsRouter.post('/charges', validate({ body: chargeBody }), (req, res, next) => {
  const { body } = getValidated<{ body: ChargeBody }>(req);
  paymentsService
    .initiateCharge(getAuth(req), body, req.id as string)
    .then((charge) => res.status(201).json({ charge }))
    .catch(next);
});

paymentsRouter.get(
  '/charges/:reference',
  validate({ params: referenceParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: ReferenceParams }>(req);
    paymentsService
      .getCharge(params.reference)
      .then((charge) => res.json({ charge }))
      .catch(next);
  },
);

paymentsRouter.post(
  '/charges/:reference/verify',
  validate({ params: referenceParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: ReferenceParams }>(req);
    paymentsService
      .verifyAndApply(params.reference)
      .then((charge) => res.json({ charge }))
      .catch(next);
  },
);

/**
 * Paystack webhook — mounted in app.ts BEFORE express.json() with a raw body,
 * because the HMAC-SHA512 signature covers the exact bytes. Unauthenticated by
 * design; the signature is the authentication.
 */
export const paystackWebhookHandler: RequestHandler = (req: Request, res: Response, next) => {
  const raw = req.body as unknown;
  if (!Buffer.isBuffer(raw)) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Expected a raw body' } });
    return;
  }
  const signature = req.get('x-paystack-signature');
  if (!verifyWebhookSignature(raw, signature)) {
    res.status(401).json({ error: { code: 'BAD_SIGNATURE', message: 'Signature check failed' } });
    return;
  }

  let event: unknown;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } });
    return;
  }

  paymentsService
    .handleWebhookEvent(event as Parameters<typeof paymentsService.handleWebhookEvent>[0])
    .then(() => res.json({ received: true }))
    // Unexpected errors → 500 so Paystack retries; idempotency makes that safe.
    .catch(next);
};

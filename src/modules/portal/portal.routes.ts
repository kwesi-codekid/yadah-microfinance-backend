import { Router } from 'express';
import { getPortalAuth, requireCustomer } from '../../middleware/portal-auth.js';
import { getValidated, validate } from '../../middleware/validate.js';
import { customerStatement, listTransactions } from '../reports/transactions.service.js';
import { getPortalCharge, initiatePortalCharge } from '../payments/payments.service.js';
import { Types } from 'mongoose';
import * as auth from './portal-auth.service.js';
import * as portal from './portal.service.js';
import * as requests from './payout-requests.service.js';
import {
  createRequestBody,
  listRequestsQuery,
  otpRequestBody,
  otpVerifyBody,
  portalChargeBody,
  refreshBody,
  type CreateRequestBody,
  type ListRequestsQuery,
  type OtpRequestBody,
  type OtpVerifyBody,
  type PortalChargeBody,
  type RefreshBody,
} from './portal.schemas.js';
import { pagination, type Pagination } from '../../schemas/common.js';
import { rangeQuery, type RangeQuery } from '../reports/reports.schemas.js';

/**
 * The customer-facing portal.
 *
 * Every authenticated route reads the customer id from the portal TOKEN, never
 * from a path or query parameter, so there is no id a caller could swap to
 * reach someone else's money. Portal tokens are signed with a different key
 * from staff tokens and cannot satisfy requireAuth (see portal-auth.service).
 */
export const portalRouter = Router();

// ---------------------------------------------------------------- auth (open)

/**
 * Always 202, whether or not the number belongs to a customer — a different
 * response would turn this into a way to discover who banks here.
 */
portalRouter.post('/auth/otp/request', validate({ body: otpRequestBody }), (req, res, next) => {
  const { body } = getValidated<{ body: OtpRequestBody }>(req);
  auth
    .requestOtp(body.phone)
    .then(() => res.status(202).json({ sent: true }))
    .catch(next);
});

portalRouter.post('/auth/otp/verify', validate({ body: otpVerifyBody }), (req, res, next) => {
  const { body } = getValidated<{ body: OtpVerifyBody }>(req);
  auth
    .verifyOtp(body.phone, body.code)
    .then((result) => res.json(result))
    .catch(next);
});

portalRouter.post('/auth/refresh', validate({ body: refreshBody }), (req, res, next) => {
  const { body } = getValidated<{ body: RefreshBody }>(req);
  auth
    .refresh(body.refreshToken)
    .then((tokens) => res.json(tokens))
    .catch(next);
});

portalRouter.post('/auth/logout', validate({ body: refreshBody }), (req, res, next) => {
  const { body } = getValidated<{ body: RefreshBody }>(req);
  auth
    .logout(body.refreshToken)
    .then(() => res.status(204).end())
    .catch(next);
});

// ---------------------------------------------------------------- authenticated
portalRouter.use(requireCustomer);

portalRouter.get('/me', (req, res, next) => {
  auth
    .getProfile(getPortalAuth(req).sub)
    .then((customer) => res.json({ customer }))
    .catch(next);
});

// Every product the customer holds, with the handset-ready figures derived.
portalRouter.get('/accounts', (req, res, next) => {
  portal
    .myAccounts(getPortalAuth(req).sub)
    .then((accounts) => res.json(accounts))
    .catch(next);
});

portalRouter.get('/transactions', validate({ query: pagination }), (req, res, next) => {
  const { query } = getValidated<{ query: Pagination }>(req);
  listTransactions({
    ...query,
    customerId: new Types.ObjectId(getPortalAuth(req).sub),
    includePending: true,
    format: 'json',
  })
    .then((feed) => res.json(feed))
    .catch(next);
});

portalRouter.get('/statement', validate({ query: rangeQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: RangeQuery }>(req);
  customerStatement(new Types.ObjectId(getPortalAuth(req).sub), query.from, query.to)
    .then((statement) => res.json(statement))
    .catch(next);
});

// ---------------------------------------------------------------- pay in

portalRouter.post('/payments/charges', validate({ body: portalChargeBody }), (req, res, next) => {
  const { body } = getValidated<{ body: PortalChargeBody }>(req);
  initiatePortalCharge(getPortalAuth(req).sub, body, req.id as string)
    .then((charge) => res.status(201).json({ charge }))
    .catch(next);
});

portalRouter.get('/payments/charges/:reference', (req, res, next) => {
  getPortalCharge(getPortalAuth(req).sub, req.params.reference)
    .then((charge) => res.json({ charge }))
    .catch(next);
});

// ---------------------------------------------------------------- withdrawal requests

portalRouter.post('/requests', validate({ body: createRequestBody }), (req, res, next) => {
  const { body } = getValidated<{ body: CreateRequestBody }>(req);
  requests
    .submitRequest(getPortalAuth(req).sub, body)
    .then((request) => res.status(201).json({ request }))
    .catch(next);
});

portalRouter.get('/requests', validate({ query: listRequestsQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListRequestsQuery }>(req);
  requests
    .listMyRequests(getPortalAuth(req).sub, query)
    .then((list) => res.json(list))
    .catch(next);
});

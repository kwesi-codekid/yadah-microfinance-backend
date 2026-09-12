import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { formatGhs } from '../../lib/money.js';
import { notifyOffice } from '../../lib/notifications.js';
import {
  createTransferRecipient,
  fetchTransfer,
  initiateTransfer,
  assertPaymentsConfigured,
} from '../../lib/paystack.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { enqueueSms } from '../../lib/sms.js';
import {
  CustomerModel,
  PayoutRequestModel,
  type PayoutRequest,
  type PayoutRequestKind,
} from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import { maxPartialWithdrawal, susuBalance } from '../../domain/susu.js';
import { availableToWithdraw, MIN_BALANCE, WITHDRAWAL_FEE } from '../../domain/savings.js';
import * as savings from '../savings/savings.service.js';
import * as susu from '../susu/susu.service.js';
import { assertOwnedSavings, assertOwnedSusu } from './portal.service.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type { CreateRequestBody, ListRequestsQuery } from './portal.schemas.js';

/**
 * Customer-initiated withdrawal requests, and the office decision that carries
 * them out.
 *
 * The ledger rule that shapes this file: **approval executes the real
 * withdrawal first, then pushes the money**. The account is debited through
 * the same service a counter transaction uses, inside its own transaction, so
 * the ledger is never left half-written. Only once that has committed does the
 * Paystack transfer go out.
 *
 * The consequence, deliberately chosen: if the transfer later fails, the
 * customer's account is already debited and the request lands in `failed` as
 * an operational alert. It is NOT auto-reversed — re-crediting an account from
 * a webhook would write money on the word of an external service. The office
 * retries the payout or hands over cash.
 */

export interface PublicPayoutRequest {
  id: string;
  customerId: string;
  customerName?: string;
  kind: PayoutRequestKind;
  targetId: string;
  amount: number | null;
  status: string;
  payoutPhone: string;
  payoutProvider: string;
  netAmount: number | null;
  rejectionReason?: string;
  paystackStatus?: string;
  failureReason?: string;
  reviewedAt?: Date;
  paidAt?: Date;
  createdAt: Date;
}

export function toPublicRequest(r: PayoutRequest, customerName?: string): PublicPayoutRequest {
  return {
    id: r._id.toHexString(),
    customerId: r.customerId.toHexString(),
    ...(customerName !== undefined ? { customerName } : {}),
    kind: r.kind,
    targetId: r.targetId.toHexString(),
    amount: r.amount ?? null,
    status: r.status,
    payoutPhone: r.payoutPhone,
    payoutProvider: r.payoutProvider,
    netAmount: r.netAmount ?? null,
    ...(r.rejectionReason !== undefined ? { rejectionReason: r.rejectionReason } : {}),
    ...(r.paystackStatus !== undefined ? { paystackStatus: r.paystackStatus } : {}),
    ...(r.failureReason !== undefined ? { failureReason: r.failureReason } : {}),
    ...(r.reviewedAt !== undefined ? { reviewedAt: r.reviewedAt } : {}),
    ...(r.paidAt !== undefined ? { paidAt: r.paidAt } : {}),
    createdAt: r.createdAt,
  };
}

// ------------------------------------------------------------------ customer side

/**
 * Submit a request. Validates against the SAME rules the office withdrawal
 * would apply, so a customer gets told "you can't take that much" now rather
 * than after a day of waiting for a rejection.
 */
export async function submitRequest(
  customerIdHex: string,
  body: CreateRequestBody,
): Promise<PublicPayoutRequest> {
  const customer = await CustomerModel.findOne({
    _id: customerIdHex,
    status: 'active',
    ...NOT_TRASHED,
  });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);

  if (body.kind === 'savings-withdrawal') {
    const account = await assertOwnedSavings(customerIdHex, body.targetId);
    if (account?.status !== 'active') {
      throw new AppError('ACCOUNT_NOT_ACTIVE', 'Account is not active', 422);
    }
    const available = availableToWithdraw(account.balance);
    if (body.amount === undefined) {
      throw new AppError('AMOUNT_REQUIRED', 'Specify how much to withdraw', 422);
    }
    if (body.amount > available) {
      throw new AppError(
        'INSUFFICIENT_AVAILABLE',
        `Only ${formatGhs(available)} is available after the ${formatGhs(WITHDRAWAL_FEE)} fee and the ${formatGhs(MIN_BALANCE)} minimum balance`,
        422,
        { available },
      );
    }
  } else {
    const account = await assertOwnedSusu(customerIdHex, body.targetId);
    if (!account) throw new AppError('NOT_FOUND', 'Susu account not found', 404);
    if (account.status === 'closed' || account.status === 'terminated') {
      throw new AppError('ALREADY_CLOSED', 'Account is already closed', 409);
    }
    const balance = susuBalance(account.totalDeposited, account.withdrawnAmount);

    if (body.kind === 'susu-partial-withdrawal') {
      if (body.amount === undefined) {
        throw new AppError('AMOUNT_REQUIRED', 'Specify how much to withdraw', 422);
      }
      const max = maxPartialWithdrawal(balance, account.dailyAmount);
      if (body.amount > max) {
        throw new AppError(
          'EXCEEDS_MAX_PARTIAL',
          `At most ${formatGhs(max)} can be taken while the account stays open`,
          422,
          { max },
        );
      }
    } else if (balance < account.dailyAmount) {
      // Closing below one day's deposit cannot pay the commission — the office
      // handles that case with `terminate`, which is not a customer action.
      throw new AppError(
        'BELOW_COMMISSION',
        'This account holds less than one day’s deposit — visit the office to close it',
        422,
      );
    }
  }

  // The unique partial index on (targetId, status:'pending') is the real guard
  // against two open requests; this only turns it into a clean error.
  const open = await PayoutRequestModel.findOne({ targetId: body.targetId, status: 'pending' });
  if (open) {
    throw new AppError('REQUEST_ALREADY_OPEN', 'A request on this account is already pending', 409);
  }

  const created = await PayoutRequestModel.create({
    customerId: customer._id,
    kind: body.kind,
    targetId: body.targetId,
    ...(body.amount !== undefined ? { amount: body.amount } : {}),
    payoutPhone: body.payoutPhone ?? customer.phone,
    payoutProvider: body.payoutProvider,
    idempotencyKey: randomUUID(),
  });

  notifyOffice({
    type: 'susu.withdrawal',
    title: 'Withdrawal request from a customer',
    body: `${customer.fullName} requested a ${body.kind.replace(/-/g, ' ')}${
      body.amount !== undefined ? ` of ${formatGhs(body.amount)}` : ''
    }.`,
    data: { entity: 'payout-request', id: created._id.toHexString() },
  });
  emitAdminEvent('payout-request.submitted', {
    id: created._id.toHexString(),
    customerId: customer._id.toHexString(),
    customerName: customer.fullName,
    kind: body.kind,
    amount: body.amount ?? null,
  });

  return toPublicRequest(created);
}

export async function listMyRequests(
  customerIdHex: string,
  query: ListRequestsQuery,
): Promise<{ items: PublicPayoutRequest[]; page: number; limit: number; total: number }> {
  const filter: Record<string, unknown> = { customerId: new Types.ObjectId(customerIdHex) };
  if (query.status) filter.status = query.status;

  const [items, total] = await Promise.all([
    PayoutRequestModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    PayoutRequestModel.countDocuments(filter),
  ]);
  return {
    items: items.map((r) => toPublicRequest(r)),
    page: query.page,
    limit: query.limit,
    total,
  };
}

// ------------------------------------------------------------------ office side

export async function listRequests(
  query: ListRequestsQuery,
): Promise<{ items: PublicPayoutRequest[]; page: number; limit: number; total: number }> {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;

  const [rows, total] = await Promise.all([
    PayoutRequestModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    PayoutRequestModel.countDocuments(filter),
  ]);
  const customers = await CustomerModel.find(
    { _id: { $in: rows.map((r) => r.customerId) } },
    { fullName: 1 },
  );
  const nameById = new Map(customers.map((c) => [c._id.toHexString(), c.fullName]));
  return {
    items: rows.map((r) => toPublicRequest(r, nameById.get(r.customerId.toHexString()))),
    page: query.page,
    limit: query.limit,
    total,
  };
}

export async function getRequest(id: Types.ObjectId): Promise<PublicPayoutRequest> {
  const request = await PayoutRequestModel.findById(id);
  if (!request) throw new AppError('NOT_FOUND', 'Request not found', 404);
  const customer = await CustomerModel.findById(request.customerId, { fullName: 1 });
  return toPublicRequest(request, customer?.fullName);
}

export async function rejectRequest(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  reason: string,
  requestId?: string,
): Promise<PublicPayoutRequest> {
  const request = await PayoutRequestModel.findById(id);
  if (!request) throw new AppError('NOT_FOUND', 'Request not found', 404);
  if (request.status !== 'pending') {
    throw new AppError('NOT_PENDING', `Request is already ${request.status}`, 409);
  }

  request.status = 'rejected';
  request.rejectionReason = reason;
  request.reviewedById = new Types.ObjectId(actor.sub);
  request.reviewedAt = new Date();
  await request.save();

  await audit({
    actorId: actor.sub,
    action: 'payout-request.reject',
    entityType: 'payout-request',
    entityId: request._id,
    after: { reason },
    ...(requestId !== undefined ? { requestId } : {}),
  });

  const customer = await CustomerModel.findById(request.customerId);
  if (customer) {
    await enqueueSms({
      to: customer.phone,
      template: 'payout-request-rejected',
      message: `Yadah: your withdrawal request was not approved. ${reason} Please contact the office.`,
      relatedEntityType: 'payout-request',
      relatedEntityId: request._id,
    });
  }
  return toPublicRequest(request, customer?.fullName);
}

/**
 * Approve: execute the real withdrawal, then push the money.
 *
 * The withdrawal runs first and on its own — it is the authoritative ledger
 * write, and it must be committed before any external call. If Paystack then
 * refuses the transfer outright, the request is marked `failed` with the
 * account already debited, which is the honest state: the money left the
 * account and the office now owes the customer a payout.
 */
export async function approveRequest(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  requestId?: string,
): Promise<PublicPayoutRequest> {
  assertPaymentsConfigured();

  const request = await PayoutRequestModel.findById(id);
  if (!request) throw new AppError('NOT_FOUND', 'Request not found', 404);
  if (request.status !== 'pending') {
    throw new AppError('NOT_PENDING', `Request is already ${request.status}`, 409);
  }
  const customer = await CustomerModel.findById(request.customerId);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);

  // ---- 1. the ledger write, through the ordinary office service
  let netAmount: number;
  // Only the savings path exposes the created record's id; the susu results
  // return figures rather than the payout document.
  let resultRecordId: Types.ObjectId | undefined;

  if (request.kind === 'savings-withdrawal') {
    const result = await savings.withdraw(
      actor,
      request.targetId,
      request.amount ?? 0,
      request.idempotencyKey,
      requestId,
    );
    // The customer receives the amount asked for; the GHS 10 fee is on top,
    // already taken from the balance by the service above.
    netAmount = request.amount ?? 0;
    resultRecordId = new Types.ObjectId(result.txn.id);
  } else if (request.kind === 'susu-partial-withdrawal') {
    const result = await susu.withdrawPartial(
      actor,
      request.targetId,
      request.amount ?? 0,
      request.idempotencyKey,
      requestId,
    );
    netAmount = result.amount;
  } else {
    // Closure computes its own payout: balance less exactly one day's commission.
    const closure = await susu.closeAccount(actor, request.targetId, requestId);
    netAmount = closure.payout;
  }

  request.status = 'approved';
  request.netAmount = netAmount;
  request.reviewedById = new Types.ObjectId(actor.sub);
  request.reviewedAt = new Date();
  if (resultRecordId) request.resultRecordId = resultRecordId;
  await request.save();

  await audit({
    actorId: actor.sub,
    action: 'payout-request.approve',
    entityType: 'payout-request',
    entityId: request._id,
    amountAfter: netAmount,
    after: { kind: request.kind, netAmount },
    ...(requestId !== undefined ? { requestId } : {}),
  });

  // ---- 2. push the money. The debit above is already committed.
  const reference = `yadah-payout-${request._id.toHexString()}`;
  try {
    const recipientCode = await createTransferRecipient({
      name: customer.fullName,
      phone: request.payoutPhone,
      provider: request.payoutProvider,
    });
    const transfer = await initiateTransfer({
      recipientCode,
      amount: netAmount,
      reference,
      reason: `Yadah ${request.kind.replace(/-/g, ' ')}`,
    });
    request.recipientCode = recipientCode;
    request.transferCode = transfer.transferCode;
    request.transferReference = transfer.reference;
    request.paystackStatus = transfer.paystackStatus;
    await request.save();
  } catch (err) {
    // The account is debited and the transfer never started. Surface it loudly
    // rather than throwing: the approval itself succeeded and must not appear
    // to have been rolled back.
    request.status = 'failed';
    request.failureReason =
      err instanceof AppError ? err.message : 'Could not start the Paystack transfer';
    await request.save();
    logger.error(
      { requestId: request._id.toHexString(), err },
      'payout approved and account debited, but the transfer could not be started',
    );
    notifyOffice({
      type: 'susu.payout',
      title: 'Payout needs manual completion',
      body: `${customer.fullName} was debited ${formatGhs(netAmount)} but the mobile money transfer could not be started. Pay them at the office or retry.`,
      data: { entity: 'payout-request', id: request._id.toHexString() },
    });
    return toPublicRequest(request, customer.fullName);
  }

  await enqueueSms({
    to: request.payoutPhone,
    template: 'payout-sent',
    message: `Yadah: ${formatGhs(netAmount)} is on its way to ${request.payoutPhone}. It may take a few minutes to arrive.`,
    relatedEntityType: 'payout-request',
    relatedEntityId: request._id,
  });
  emitAdminEvent('payout-request.approved', {
    id: request._id.toHexString(),
    customerId: customer._id.toHexString(),
    customerName: customer.fullName,
    amount: netAmount,
  });

  return toPublicRequest(request, customer.fullName);
}

// ------------------------------------------------------------------ settlement

/**
 * Apply a transfer outcome from the Paystack webhook.
 *
 * Terminal states are never rewritten, so a duplicate webhook — Paystack
 * retries — is a no-op rather than a second SMS.
 */
export async function applyTransferOutcome(
  reference: string,
  outcome: 'success' | 'failed' | 'reversed',
  paystackStatus: string,
): Promise<{ handled: boolean }> {
  const request = await PayoutRequestModel.findOne({ transferReference: reference });
  if (!request) return { handled: false };
  if (request.status === 'paid' || request.status === 'failed') return { handled: true };

  const customer = await CustomerModel.findById(request.customerId);

  if (outcome === 'success') {
    request.status = 'paid';
    request.paidAt = new Date();
    request.paystackStatus = paystackStatus;
    await request.save();

    await enqueueSms({
      to: request.payoutPhone,
      template: 'payout-paid',
      message: `Yadah: ${formatGhs(request.netAmount ?? 0)} has been sent to ${request.payoutPhone}. Thank you.`,
      relatedEntityType: 'payout-request',
      relatedEntityId: request._id,
    });
    emitAdminEvent('payout-request.paid', {
      id: request._id.toHexString(),
      amount: request.netAmount ?? 0,
    });
    return { handled: true };
  }

  // Failed or reversed: the account stays debited on purpose. Re-crediting a
  // ledger from an external callback is not something this system does.
  request.status = 'failed';
  request.paystackStatus = paystackStatus;
  request.failureReason =
    outcome === 'reversed' ? 'Paystack reversed the transfer' : 'Paystack could not deliver';
  await request.save();

  logger.error(
    { requestId: request._id.toHexString(), reference, outcome },
    'payout transfer did not settle — customer is debited and unpaid',
  );
  notifyOffice({
    type: 'susu.payout',
    title: 'Payout failed — customer is owed',
    body: `${customer?.fullName ?? 'A customer'} was debited ${formatGhs(request.netAmount ?? 0)} but the transfer ${outcome === 'reversed' ? 'was reversed' : 'failed'}. Pay them at the office or retry.`,
    data: { entity: 'payout-request', id: request._id.toHexString() },
  });
  return { handled: true };
}

/** Fallback for a missed transfer webhook — ask Paystack directly. */
export async function verifyTransferNow(id: Types.ObjectId): Promise<PublicPayoutRequest> {
  assertPaymentsConfigured();
  const request = await PayoutRequestModel.findById(id);
  if (!request) throw new AppError('NOT_FOUND', 'Request not found', 404);
  if (!request.transferReference) {
    throw new AppError('NO_TRANSFER', 'This request has no transfer to verify', 422);
  }

  const { paystackStatus } = await fetchTransfer(request.transferReference);
  if (paystackStatus === 'success') {
    await applyTransferOutcome(request.transferReference, 'success', paystackStatus);
  } else if (paystackStatus === 'failed' || paystackStatus === 'reversed') {
    await applyTransferOutcome(
      request.transferReference,
      paystackStatus === 'reversed' ? 'reversed' : 'failed',
      paystackStatus,
    );
  }
  return getRequest(id);
}

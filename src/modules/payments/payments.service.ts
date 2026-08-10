import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { formatGhs } from '../../lib/money.js';
import {
  assertPaymentsConfigured,
  initiateCharge as paystackInitiate,
  verifyTransaction,
} from '../../lib/paystack.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import {
  CustomerModel,
  HpAgreementModel,
  LoanModel,
  PaystackChargeModel,
  SavingsAccountModel,
  SusuAccountModel,
  type PaystackCharge,
} from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import { MIN_DEPOSIT } from '../../domain/savings.js';
import { remainingDeposits } from '../../domain/susu.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import * as hp from '../hire-purchase/hp.service.js';
import { remainingOn } from '../hire-purchase/hp.service.js';
import * as loans from '../loans/loans.service.js';
import * as savings from '../savings/savings.service.js';
import * as susu from '../susu/susu.service.js';
import type { ChargeBody } from './payments.schemas.js';

/**
 * Paystack money-in. Initiation validates the target and asks Paystack to
 * charge the customer's mobile-money wallet; the actual ledger write happens
 * when Paystack confirms payment (webhook or manual verify), through the SAME
 * service functions cash goes through — with channel 'paystack' and an
 * idempotency key derived from the Paystack reference, so webhook retries can
 * never double-record.
 */

const OFFICE_ONLY_KINDS = new Set([
  'loan-repayment',
  'hp-deposit',
  'hp-installment',
  'hp-redemption',
]);

export interface PublicCharge {
  reference: string;
  status: PaystackCharge['status'];
  executionStatus: PaystackCharge['executionStatus'];
  kind: PaystackCharge['kind'];
  targetId: string;
  customerId: string;
  amount: number;
  phone: string;
  provider: PaystackCharge['provider'];
  displayText?: string;
  failureReason?: string;
  resultRecordId?: string;
  createdAt: Date;
  executedAt?: Date;
}

function toPublicCharge(c: PaystackCharge): PublicCharge {
  return {
    reference: c.reference,
    status: c.status,
    executionStatus: c.executionStatus,
    kind: c.kind,
    targetId: c.targetId.toHexString(),
    customerId: c.customerId.toHexString(),
    amount: c.amount,
    phone: c.phone,
    provider: c.provider,
    ...(c.displayText !== undefined ? { displayText: c.displayText } : {}),
    ...(c.failureReason !== undefined ? { failureReason: c.failureReason } : {}),
    ...(c.resultRecordId ? { resultRecordId: c.resultRecordId.toHexString() } : {}),
    createdAt: c.createdAt,
    ...(c.executedAt !== undefined ? { executedAt: c.executedAt } : {}),
  };
}

/** Validates the target up front and returns { customerId, amount }. */
async function resolveTarget(
  actor: AccessTokenPayload,
  body: ChargeBody,
): Promise<{ customerId: Types.ObjectId; amount: number }> {
  if (OFFICE_ONLY_KINDS.has(body.kind) && actor.role === 'collector') {
    throw new AppError('FORBIDDEN', 'Loan and hire purchase charges are office only', 403);
  }

  switch (body.kind) {
    case 'susu-deposit': {
      const account = await SusuAccountModel.findOne({ _id: body.targetId, ...NOT_TRASHED });
      if (!account) throw new AppError('NOT_FOUND', 'Susu account not found', 404);
      if (account.status !== 'active') {
        throw new AppError(
          'ACCOUNT_NOT_ACTIVE',
          'Deposits are only allowed on active accounts',
          422,
        );
      }
      const amount = body.amount ?? 0;
      if (amount % account.dailyAmount !== 0) {
        throw new AppError(
          'AMOUNT_MISMATCH',
          `Susu deposits must be a multiple of the daily amount (${formatGhs(account.dailyAmount)})`,
          422,
          { dailyAmount: account.dailyAmount },
        );
      }
      const remaining = remainingDeposits(account.depositsCount);
      if (amount / account.dailyAmount > remaining) {
        throw new AppError(
          'EXCEEDS_REMAINING',
          `Only ${String(remaining)} deposit day(s) remain in this cycle`,
          422,
          { remaining },
        );
      }
      return { customerId: account.customerId, amount };
    }
    case 'savings-deposit': {
      const account = await SavingsAccountModel.findOne({ _id: body.targetId, ...NOT_TRASHED });
      if (!account) throw new AppError('NOT_FOUND', 'Savings account not found', 404);
      if (account.status !== 'active') {
        throw new AppError('ACCOUNT_NOT_ACTIVE', 'Account is not active', 422);
      }
      const amount = body.amount ?? 0;
      if (amount < MIN_DEPOSIT) {
        throw new AppError('AMOUNT_TOO_SMALL', 'Minimum deposit is GHS 10', 422);
      }
      return { customerId: account.customerId, amount };
    }
    case 'loan-repayment': {
      const loan = await LoanModel.findOne({ _id: body.targetId, ...NOT_TRASHED });
      if (!loan) throw new AppError('NOT_FOUND', 'Loan not found', 404);
      if (loan.status !== 'active' && loan.status !== 'arrears') {
        throw new AppError('LOAN_NOT_OPEN', 'Loan is not open for repayment', 422);
      }
      const amount = body.amount ?? 0;
      const remaining = loan.totalDue - loan.totalRepaid;
      if (amount > remaining) {
        throw new AppError(
          'EXCEEDS_BALANCE',
          `Amount exceeds the remaining balance (${formatGhs(remaining)})`,
          422,
          { remaining, amount },
        );
      }
      return { customerId: loan.customerId, amount };
    }
    case 'hp-deposit': {
      const agreement = await HpAgreementModel.findOne({ _id: body.targetId, ...NOT_TRASHED });
      if (!agreement) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
      if (agreement.status !== 'pending') {
        throw new AppError('AGREEMENT_NOT_PENDING', 'The deposit stage is already past', 422);
      }
      if (body.amount !== agreement.depositRequired) {
        throw new AppError(
          'DEPOSIT_MISMATCH',
          `The deposit must be exactly ${formatGhs(agreement.depositRequired)}`,
          422,
          { depositRequired: agreement.depositRequired },
        );
      }
      return { customerId: agreement.customerId, amount: agreement.depositRequired };
    }
    case 'hp-installment': {
      const agreement = await HpAgreementModel.findOne({ _id: body.targetId, ...NOT_TRASHED });
      if (!agreement) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
      if (agreement.status !== 'active' && agreement.status !== 'in-arrears') {
        throw new AppError('AGREEMENT_NOT_OPEN', 'Agreement is not open for payments', 422);
      }
      return { customerId: agreement.customerId, amount: body.amount ?? 0 };
    }
    case 'hp-redemption': {
      const agreement = await HpAgreementModel.findOne({ _id: body.targetId, ...NOT_TRASHED });
      if (!agreement) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
      if (agreement.status !== 'repossessed') {
        throw new AppError('NOT_REDEEMABLE', 'Only repossessed agreements can be redeemed', 422);
      }
      const amount = remainingOn(agreement);
      if (amount < 1) throw new AppError('NOTHING_TO_REDEEM', 'Nothing left to redeem', 422);
      return { customerId: agreement.customerId, amount };
    }
  }
}

export async function initiateCharge(
  actor: AccessTokenPayload,
  body: ChargeBody,
  requestId?: string,
): Promise<PublicCharge> {
  assertPaymentsConfigured();
  const { customerId, amount } = await resolveTarget(actor, body);
  const customer = await CustomerModel.findOne({ _id: customerId, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);

  const reference = `yadah-${randomUUID()}`;
  const charge = await PaystackChargeModel.create({
    reference,
    kind: body.kind,
    targetId: body.targetId,
    customerId,
    amount,
    phone: body.phone,
    provider: body.provider,
    // Paystack requires an email; not every customer has one.
    email: customer.email ?? `${body.phone}@yadah.local`,
    initiatedById: new Types.ObjectId(actor.sub),
    initiatedByRole: actor.role,
  });

  let initiation;
  try {
    initiation = await paystackInitiate({
      email: charge.email,
      amount,
      reference,
      phone: body.phone,
      provider: body.provider,
    });
  } catch (err) {
    await PaystackChargeModel.updateOne(
      { _id: charge._id },
      { $set: { status: 'failed', failureReason: 'Paystack initiation failed' } },
    );
    throw err;
  }

  await PaystackChargeModel.updateOne(
    { _id: charge._id },
    {
      $set: {
        paystackStatus: initiation.paystackStatus,
        ...(initiation.displayText !== null ? { displayText: initiation.displayText } : {}),
      },
    },
  );
  await audit({
    actorId: actor.sub,
    action: 'payment.charge.initiate',
    entityType: 'paystack-charge',
    entityId: charge._id,
    amountAfter: amount,
    after: { kind: body.kind, reference, phone: body.phone, provider: body.provider },
    ...(requestId !== undefined ? { requestId } : {}),
  });

  const fresh = await PaystackChargeModel.findById(charge._id);
  if (!fresh) throw new AppError('NOT_FOUND', 'Charge not found', 404);
  return toPublicCharge(fresh);
}

export async function getCharge(reference: string): Promise<PublicCharge> {
  const charge = await PaystackChargeModel.findOne({ reference });
  if (!charge) throw new AppError('NOT_FOUND', 'Charge not found', 404);
  return toPublicCharge(charge);
}

/**
 * Applies a paid charge to its target through the normal service functions.
 * Never throws for business-rule failures — those become executionStatus
 * 'failed' for the office to resolve (the money is already received).
 */
async function executeCharge(charge: PaystackCharge): Promise<void> {
  const actor: AccessTokenPayload = {
    sub: charge.initiatedById.toHexString(),
    role: charge.initiatedByRole,
  };
  const key = `paystack:${charge.reference}`;

  try {
    let resultRecordId: Types.ObjectId | undefined;
    switch (charge.kind) {
      case 'susu-deposit': {
        const result = await susu.recordDeposit(
          actor,
          charge.targetId,
          charge.amount,
          key,
          'paystack',
        );
        resultRecordId = new Types.ObjectId(result.deposit.id);
        break;
      }
      case 'savings-deposit': {
        const result = await savings.deposit(
          actor,
          charge.targetId,
          charge.amount,
          key,
          'paystack',
        );
        resultRecordId = new Types.ObjectId(result.txn.id);
        break;
      }
      case 'loan-repayment': {
        const result = await loans.repayCash(
          actor,
          charge.targetId,
          charge.amount,
          key,
          'paystack',
        );
        resultRecordId = new Types.ObjectId(result.repayment.id);
        break;
      }
      case 'hp-deposit': {
        await hp.recordDeposit(actor, charge.targetId, charge.amount, key, 'paystack');
        break;
      }
      case 'hp-installment': {
        await hp.payInstallment(actor, charge.targetId, charge.amount, key, 'paystack');
        break;
      }
      case 'hp-redemption': {
        // redeem() always charges the FULL remaining balance — if the balance
        // moved since initiation the paid amount no longer matches; hold for
        // the office instead of silently applying a different amount.
        const agreement = await HpAgreementModel.findById(charge.targetId);
        if (!agreement || remainingOn(agreement) !== charge.amount) {
          throw new AppError(
            'AMOUNT_MISMATCH',
            'The redemption balance changed since the charge was initiated',
            422,
          );
        }
        await hp.redeem(actor, charge.targetId, key, 'paystack');
        break;
      }
    }
    await PaystackChargeModel.updateOne(
      { _id: charge._id },
      {
        $set: {
          executionStatus: 'applied',
          executedAt: new Date(),
          ...(resultRecordId ? { resultRecordId } : {}),
        },
        $unset: { failureReason: '' },
      },
    );
    emitAdminEvent('payment.applied', {
      reference: charge.reference,
      kind: charge.kind,
      amount: charge.amount,
      customerId: charge.customerId.toHexString(),
    });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    await PaystackChargeModel.updateOne(
      { _id: charge._id },
      { $set: { executionStatus: 'failed', failureReason: `${err.code}: ${err.message}` } },
    );
    emitAdminEvent('payment.failed', {
      reference: charge.reference,
      kind: charge.kind,
      amount: charge.amount,
      customerId: charge.customerId.toHexString(),
      reason: `${err.code}: ${err.message}`,
    });
  }
}

interface WebhookEvent {
  event?: string;
  data?: { reference?: string; amount?: number; currency?: string; status?: string };
}

/** Always resolves — webhook responses must be 200 whenever the payload is valid. */
export async function handleWebhookEvent(event: WebhookEvent): Promise<{ handled: boolean }> {
  if (event.event !== 'charge.success' || !event.data?.reference) return { handled: false };

  const charge = await PaystackChargeModel.findOne({ reference: event.data.reference });
  if (!charge) return { handled: false }; // not ours — acknowledge and ignore
  if (charge.executionStatus === 'applied') return { handled: true }; // duplicate delivery

  if (event.data.amount !== charge.amount || event.data.currency !== 'GHS') {
    await PaystackChargeModel.updateOne(
      { _id: charge._id },
      {
        $set: {
          status: 'success',
          executionStatus: 'failed',
          failureReason: `Paid ${String(event.data.amount)} ${event.data.currency ?? '?'} but expected ${String(charge.amount)} GHS`,
        },
      },
    );
    emitAdminEvent('payment.failed', {
      reference: charge.reference,
      kind: charge.kind,
      amount: charge.amount,
      reason: 'amount mismatch',
    });
    return { handled: true };
  }

  await PaystackChargeModel.updateOne(
    { _id: charge._id },
    { $set: { status: 'success', paystackStatus: event.data.status ?? 'success' } },
  );
  const fresh = await PaystackChargeModel.findById(charge._id);
  if (fresh) await executeCharge(fresh);
  return { handled: true };
}

/** Fallback for missed webhooks: ask Paystack directly, then apply. */
export async function verifyAndApply(reference: string): Promise<PublicCharge> {
  assertPaymentsConfigured();
  const charge = await PaystackChargeModel.findOne({ reference });
  if (!charge) throw new AppError('NOT_FOUND', 'Charge not found', 404);

  if (charge.executionStatus !== 'applied') {
    const verification = await verifyTransaction(reference);
    if (verification.paystackStatus === 'success') {
      await handleWebhookEvent({
        event: 'charge.success',
        data: {
          reference,
          amount: verification.amount ?? -1,
          currency: verification.currency ?? '?',
          status: verification.paystackStatus,
        },
      });
    } else {
      await PaystackChargeModel.updateOne(
        { reference },
        { $set: { paystackStatus: verification.paystackStatus } },
      );
    }
  }
  return getCharge(reference);
}

import mongoose, { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { formatGhs } from '../../lib/money.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { enqueueSms } from '../../lib/sms.js';
import { accraDay } from '../../lib/time.js';
import { depositWithin, roundsSplit, withdrawWithin } from '../susu/susu.service.js';
import { availableToWithdraw, computeWithdrawal } from '../../domain/savings.js';
import {
  CustomerModel,
  HpAgreementModel,
  LoanModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SusuAccountModel,
  TransferModel,
  UserModel,
  type Customer,
  type Transfer,
} from '../../models/index.js';
import { buildReceiptPdf, receiptNumber, type ReceiptLine } from '../../lib/receipt-pdf.js';
import { NOT_TRASHED } from '../../models/shared.js';
import { applyRepaymentInTxn } from '../loans/loans.service.js';
import { applyHpPaymentInTxn, remainingOn } from '../hire-purchase/hp.service.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type { TransferBody } from './transfers.schemas.js';

export interface TransferResult {
  transfer: {
    id: string;
    fromType: string;
    toType: string;
    amountMoved: number;
    fee: number;
    amountCredited: number;
    excessPending: number;
  };
  replayed: boolean;
}

function toResult(t: Transfer, replayed: boolean): TransferResult {
  return {
    transfer: {
      id: t._id.toHexString(),
      fromType: t.fromType,
      toType: t.toType,
      amountMoved: t.amountMoved,
      fee: t.fee,
      amountCredited: t.amountCredited,
      excessPending: t.excessPending,
    },
    replayed,
  };
}

const destinationLabel: Record<string, string> = {
  savings: 'your savings account',
  susu: 'your susu account',
  loan: 'your loan',
  'hire-purchase': 'your hire purchase',
};

/**
 * One atomic internal transfer. Each side keeps its own rules: a savings
 * source is a real withdrawal (fee, 1/day, available limits); a susu source
 * is a real withdrawal too (no commission, cycles untouched, never below the
 * lock); a susu destination is a deposit credited in whole rounds; loan/HP
 * destinations are real repayments/payments. No rule exemptions except the
 * savings minimum-deposit on internal credits.
 */
export async function transfer(
  actor: AccessTokenPayload,
  body: TransferBody,
  requestId?: string,
): Promise<TransferResult> {
  const existing = await TransferModel.findOne({ idempotencyKey: body.idempotencyKey });
  if (existing) return toResult(existing, true);

  // ---- resolve both sides and the owning customer
  const fromDoc =
    body.from.type === 'susu'
      ? await SusuAccountModel.findOne({ _id: body.from.accountId, ...NOT_TRASHED })
      : await SavingsAccountModel.findOne({ _id: body.from.accountId, ...NOT_TRASHED });
  if (!fromDoc) throw new AppError('NOT_FOUND', 'Source account not found', 404);
  const customerId = fromDoc.customerId;

  const toId =
    body.to.type === 'loan'
      ? body.to.loanId
      : body.to.type === 'hire-purchase'
        ? body.to.agreementId
        : body.to.accountId;
  const toDoc =
    body.to.type === 'savings'
      ? await SavingsAccountModel.findOne({ _id: toId, ...NOT_TRASHED })
      : body.to.type === 'susu'
        ? await SusuAccountModel.findOne({ _id: toId, ...NOT_TRASHED })
        : body.to.type === 'loan'
          ? await LoanModel.findOne({ _id: toId, ...NOT_TRASHED })
          : await HpAgreementModel.findOne({ _id: toId, ...NOT_TRASHED });
  if (!toDoc) throw new AppError('NOT_FOUND', 'Destination not found', 404);
  if (!toDoc.customerId.equals(customerId)) {
    throw new AppError('CUSTOMER_MISMATCH', 'Both sides must belong to the same customer', 422);
  }
  const customer = await CustomerModel.findOne({ _id: customerId, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);

  // A susu destination is credited in whole rounds — one payment on every
  // active plan — with the rest left in the balance. Resolved up front so a
  // short amount is refused before anything moves.
  const susuSplit =
    body.to.type === 'susu' ? (await roundsSplit(toId, body.amount)).split : undefined;

  const session = await mongoose.startSession();
  let record!: Transfer;
  try {
    await session.withTransaction(async () => {
      const actorId = new Types.ObjectId(actor.sub);
      let pool: number; // what leaves the source
      let fee = 0;

      // ---------------- source side
      if (body.from.type === 'savings') {
        const account = await SavingsAccountModel.findOne({
          _id: body.from.accountId,
          status: 'active',
          ...NOT_TRASHED,
        }).session(session);
        if (!account)
          throw new AppError('ACCOUNT_NOT_ACTIVE', 'Savings account is not active', 422);
        const amount = body.amount;

        // Same rules as a cash withdrawal: 1 per Accra day, fee, available.
        const today = accraDay();
        const todayCashOut = await SavingsTxnModel.findOne({
          accountId: account._id,
          accraDay: today,
          countsTowardDailyLimit: true,
        }).session(session);
        if (todayCashOut) {
          throw new AppError(
            'WITHDRAWAL_LIMIT',
            'Only one withdrawal is allowed per day on an account',
            409,
          );
        }
        let computation;
        try {
          computation = computeWithdrawal(account.balance, amount);
        } catch (err) {
          if (err instanceof RangeError) {
            throw new AppError('EXCEEDS_AVAILABLE', 'Amount exceeds the available balance', 422, {
              available: availableToWithdraw(account.balance),
            });
          }
          throw err;
        }
        const upd = await SavingsAccountModel.updateOne(
          { _id: account._id, status: 'active', balance: account.balance },
          { $inc: { balance: -computation.totalDebit } },
          { session },
        );
        if (upd.modifiedCount !== 1)
          throw new AppError('CONFLICT', 'Savings changed concurrently — retry', 409);
        await SavingsTxnModel.create(
          [
            {
              accountId: account._id,
              customerId,
              type: 'withdrawal',
              amount,
              fee: computation.fee,
              balanceAfter: computation.balanceAfter,
              channel: 'transfer',
              accraDay: today,
              countsTowardDailyLimit: true,
              recordedById: actorId,
            },
          ],
          { session },
        );
        await audit(
          {
            actorId: actor.sub,
            action: 'savings.withdrawal.record',
            entityType: 'savings-account',
            entityId: account._id,
            amountBefore: account.balance,
            amountAfter: computation.balanceAfter,
            after: { amount, fee: computation.fee, via: 'transfer' },
            ...(requestId !== undefined ? { requestId } : {}),
          },
          session,
        );
        pool = amount;
        fee = computation.fee;
      } else {
        // Settled after the destination is known, so only what it absorbs
        // leaves the account. Just confirm it is open here.
        const account = await SusuAccountModel.findOne({
          _id: body.from.accountId,
          status: 'active',
          ...NOT_TRASHED,
        }).session(session);
        if (!account) throw new AppError('ACCOUNT_NOT_ACTIVE', 'Susu account is not open', 422);
        pool = body.amount;
      }

      // ---------------- destination side
      let credited: number;
      if (body.to.type === 'savings') {
        const target = await SavingsAccountModel.findOne({
          _id: toId,
          status: 'active',
          ...NOT_TRASHED,
        }).session(session);
        if (!target)
          throw new AppError(
            'ACCOUNT_NOT_ACTIVE',
            'Destination savings account is not active',
            422,
          );
        credited = pool;
        const upd = await SavingsAccountModel.updateOne(
          { _id: target._id, status: 'active', balance: target.balance },
          { $inc: { balance: credited } },
          { session },
        );
        if (upd.modifiedCount !== 1)
          throw new AppError('CONFLICT', 'Savings changed concurrently — retry', 409);
        // Internal credits skip the GHS 10 minimum-deposit rule by design.
        await SavingsTxnModel.create(
          [
            {
              accountId: target._id,
              customerId,
              type: 'deposit',
              amount: credited,
              balanceAfter: target.balance + credited,
              channel: 'transfer',
              accraDay: accraDay(),
              recordedById: actorId,
            },
          ],
          { session },
        );
        await audit(
          {
            actorId: actor.sub,
            action: 'savings.deposit.record',
            entityType: 'savings-account',
            entityId: target._id,
            amountBefore: target.balance,
            amountAfter: target.balance + credited,
            after: { via: 'transfer' },
            ...(requestId !== undefined ? { requestId } : {}),
          },
          session,
        );
      } else if (body.to.type === 'susu') {
        credited = pool;
        await depositWithin(session, actor, toId, credited, susuSplit, {
          channel: 'transfer',
          idempotencyKey: `transfer:${body.idempotencyKey}`,
          ...(requestId !== undefined ? { requestId } : {}),
        });
      } else if (body.to.type === 'loan') {
        const loan = await LoanModel.findOne({ _id: toId, ...NOT_TRASHED }).session(session);
        if (!loan || (loan.status !== 'active' && loan.status !== 'arrears')) {
          throw new AppError('LOAN_NOT_OPEN', 'Loan is not open for repayment', 422);
        }
        const loanRemaining = loan.totalDue - loan.totalRepaid;
        credited = Math.min(pool, loanRemaining);
        await applyRepaymentInTxn(
          actor,
          loan,
          credited,
          body.from.type === 'susu' ? 'susu' : 'transfer',
          'transfer',
          body.idempotencyKey,
          session,
          body.from.type === 'susu' ? body.from.accountId : undefined,
          requestId,
        );
      } else {
        const agreement = await HpAgreementModel.findOne({ _id: toId, ...NOT_TRASHED }).session(
          session,
        );
        if (!agreement || (agreement.status !== 'active' && agreement.status !== 'in-arrears')) {
          throw new AppError(
            'AGREEMENT_NOT_OPEN',
            'Hire purchase agreement is not open for payments',
            422,
          );
        }
        credited = Math.min(pool, remainingOn(agreement));
        await applyHpPaymentInTxn(
          actor,
          agreement,
          credited,
          'installment',
          'transfer',
          body.idempotencyKey,
          session,
          requestId,
        );
      }

      // ---------------- settle the susu source: a withdrawal of what was credited
      if (body.from.type === 'susu') {
        await withdrawWithin(session, actor, body.from.accountId, credited, {
          destination: body.to.type === 'susu' ? 'savings' : body.to.type, // susu→susu impossible
          destinationId: toId,
          idempotencyKey: `transfer:${body.idempotencyKey}`,
          ...(requestId !== undefined ? { requestId } : {}),
        });
        // Nothing beyond what the destination took ever leaves the account.
        pool = credited;
      }

      // ---------------- the transfer record itself
      const [created] = await TransferModel.create(
        [
          {
            customerId,
            fromType: body.from.type,
            fromId: body.from.accountId,
            toType: body.to.type,
            toId,
            amountMoved: pool,
            fee,
            amountCredited: credited,
            excessPending: 0,
            recordedById: actorId,
            idempotencyKey: body.idempotencyKey,
          },
        ],
        { session },
      );
      record = created as Transfer;
      await audit(
        {
          actorId: actor.sub,
          action: 'transfer',
          entityType: 'transfer',
          entityId: record._id,
          amountBefore: pool,
          amountAfter: credited,
          after: { from: body.from.type, to: body.to.type, fee, excess: record.excessPending },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  await notifyTransfer(customer, record);
  emitAdminEvent('transfer', {
    id: record._id.toHexString(),
    customerId: customerId.toHexString(),
    customerName: customer.fullName,
    from: record.fromType,
    to: record.toType,
    amountCredited: record.amountCredited,
  });
  return toResult(record, false);
}

async function notifyTransfer(customer: Customer, t: Transfer): Promise<void> {
  const parts = [
    `Yadah: ${formatGhs(t.amountCredited)} moved from your ${t.fromType} to ${destinationLabel[t.toType] ?? t.toType}.`,
  ];
  if (t.fee > 0) parts.push(`Fee: ${formatGhs(t.fee)}.`);
  if (t.excessPending > 0)
    parts.push(`${formatGhs(t.excessPending)} is waiting for you at the office.`);
  await enqueueSms({
    to: customer.phone,
    template: 'transfer-receipt',
    message: parts.join(' '),
    relatedEntityType: 'transfer',
    relatedEntityId: t._id,
  });
}

// ---------------------------------------------------------------- receipt

export interface ReceiptFile {
  buffer: Buffer;
  filename: string;
}

const PRODUCT_LABELS: Record<string, string> = {
  susu: 'Susu account',
  savings: 'Savings account',
  loan: 'Loan',
  'hire-purchase': 'Hire purchase agreement',
};

/** The account or agreement number behind one leg of a transfer. */
async function legReference(type: string, id: Types.ObjectId): Promise<string> {
  const short = (): string => id.toHexString().slice(-8).toUpperCase();
  if (type === 'susu') return (await SusuAccountModel.findById(id))?.accountNumber ?? short();
  if (type === 'savings') return (await SavingsAccountModel.findById(id))?.accountNumber ?? short();
  if (type === 'loan') return (await LoanModel.findById(id))?.accountNumber ?? short();
  return (await HpAgreementModel.findById(id))?.accountNumber ?? short();
}

/**
 * Proof of an internal move between a customer's own products.
 *
 * No cash crosses the counter, so the headline reads AMOUNT MOVED rather than
 * received or paid out. Both legs are named explicitly: the whole point of the
 * document is showing where the money went.
 */
export async function transferReceipt(transferId: Types.ObjectId): Promise<ReceiptFile> {
  const transfer = await TransferModel.findById(transferId);
  if (!transfer) throw new AppError('NOT_FOUND', 'Transfer not found', 404);

  const [customer, staff, fromRef, toRef] = await Promise.all([
    CustomerModel.findById(transfer.customerId),
    UserModel.findById(transfer.recordedById).select('name'),
    legReference(transfer.fromType, transfer.fromId),
    legReference(transfer.toType, transfer.toId),
  ]);

  const lines: ReceiptLine[] = [
    {
      label: 'From',
      value: `${PRODUCT_LABELS[transfer.fromType] ?? transfer.fromType} ${fromRef}`,
    },
    { label: 'To', value: `${PRODUCT_LABELS[transfer.toType] ?? transfer.toType} ${toRef}` },
  ];
  // Only a savings leg carries a fee; showing a zero would invite the question.
  if (transfer.fee > 0) {
    lines.push({ label: 'Transfer fee', value: formatGhs(transfer.fee) });
  }
  lines.push({
    label: 'Credited to destination',
    value: formatGhs(transfer.amountCredited),
    emphasis: true,
  });
  // Money the destination could not absorb — a loan already settled, say — is
  // still the customer's, so it must appear rather than quietly vanish.
  if (transfer.excessPending > 0) {
    lines.push({ label: 'Excess held pending', value: formatGhs(transfer.excessPending) });
  }

  const buffer = await buildReceiptPdf({
    receiptNo: receiptNumber('TR', transfer._id),
    kind: 'transfer',
    title: 'Internal Transfer',
    customerName: customer?.fullName ?? 'Customer',
    ...(customer?.phone !== undefined ? { customerPhone: customer.phone } : {}),
    accountNumber: fromRef,
    amount: transfer.amountMoved,
    lines,
    recordedByName: staff?.name ?? 'Yadah staff',
    at: transfer.createdAt,
    reference: transfer._id.toHexString(),
  });
  return { buffer, filename: `transfer-${receiptNumber('TR', transfer._id)}.pdf` };
}

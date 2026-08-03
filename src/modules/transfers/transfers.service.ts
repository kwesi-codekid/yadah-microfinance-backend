import mongoose, { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { formatGhs } from '../../lib/money.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { enqueueSms } from '../../lib/sms.js';
import { accraDay } from '../../lib/time.js';
import {
  computeClosure,
  computeDepositAmount,
  remainingDeposits,
  SUSU_CYCLE_DEPOSITS,
} from '../../domain/susu.js';
import { availableToWithdraw, computeWithdrawal } from '../../domain/savings.js';
import {
  CustomerModel,
  HpAgreementModel,
  LoanModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SusuAccountModel,
  SusuDepositModel,
  SusuPayoutModel,
  TransferModel,
  type Customer,
  type Transfer,
} from '../../models/index.js';
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
 * stops the account with normal commission (or draws a pending-payout
 * balance); loan/HP destinations are real repayments/payments. No rule
 * exemptions except the savings minimum-deposit on internal credits.
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
      ? await SusuAccountModel.findById(body.from.accountId)
      : await SavingsAccountModel.findById(body.from.accountId);
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
      ? await SavingsAccountModel.findById(toId)
      : body.to.type === 'susu'
        ? await SusuAccountModel.findById(toId)
        : body.to.type === 'loan'
          ? await LoanModel.findById(toId)
          : await HpAgreementModel.findById(toId);
  if (!toDoc) throw new AppError('NOT_FOUND', 'Destination not found', 404);
  if (!toDoc.customerId.equals(customerId)) {
    throw new AppError('CUSTOMER_MISMATCH', 'Both sides must belong to the same customer', 422);
  }
  const customer = await CustomerModel.findById(customerId);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);

  const session = await mongoose.startSession();
  let record!: Transfer;
  try {
    await session.withTransaction(async () => {
      const actorId = new Types.ObjectId(actor.sub);
      let pool: number; // what leaves the source
      let fee = 0;
      let susuSourceStopping: { commission: number; payout: number } | null = null;

      // ---------------- source side
      if (body.from.type === 'savings') {
        const account = await SavingsAccountModel.findOne({
          _id: body.from.accountId,
          status: 'active',
        }).session(session);
        if (!account)
          throw new AppError('ACCOUNT_NOT_ACTIVE', 'Savings account is not active', 422);
        const amount = body.amount ?? 0;

        // Same rules as a cash withdrawal: 1 per Accra day, fee, available.
        const today = accraDay();
        const todayCashOut = await SavingsTxnModel.findOne({
          accountId: account._id,
          accraDay: today,
          type: { $in: ['withdrawal', 'closure'] },
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
        const account = await SusuAccountModel.findOne({ _id: body.from.accountId }).session(
          session,
        );
        if (!account) throw new AppError('NOT_FOUND', 'Source account not found', 404);
        if (account.status === 'pending-payout') {
          const draw = body.amount ?? account.payoutRemaining;
          if (draw > account.payoutRemaining) {
            throw new AppError(
              'EXCEEDS_PAYOUT',
              `Only ${formatGhs(account.payoutRemaining)} is awaiting payout`,
              422,
              {
                payoutRemaining: account.payoutRemaining,
              },
            );
          }
          pool = draw;
        } else if (account.status === 'active' || account.status === 'completed') {
          if (body.amount !== undefined) {
            throw new AppError(
              'AMOUNT_NOT_ALLOWED',
              'Omit amount: transferring from a running susu account moves its full closure payout',
              422,
            );
          }
          const { commission, payout } = computeClosure(
            account.totalDeposited,
            account.dailyAmount,
          );
          if (payout < 1)
            throw new AppError('NO_PAYOUT', 'Susu closure yields no payout to transfer', 422);
          susuSourceStopping = { commission, payout };
          pool = payout;
        } else {
          throw new AppError('ALREADY_CLOSED', 'Susu account is already closed', 409);
        }
      }

      // ---------------- destination side
      let credited: number;
      if (body.to.type === 'savings') {
        const target = await SavingsAccountModel.findOne({ _id: toId, status: 'active' }).session(
          session,
        );
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
        const target = await SusuAccountModel.findOne({ _id: toId, status: 'active' }).session(
          session,
        );
        if (!target)
          throw new AppError('ACCOUNT_NOT_ACTIVE', 'Destination susu account is not active', 422);
        if (pool % target.dailyAmount !== 0) {
          throw new AppError(
            'AMOUNT_MISMATCH',
            `Susu deposits must be a multiple of the daily amount (${formatGhs(target.dailyAmount)})`,
            422,
            { dailyAmount: target.dailyAmount },
          );
        }
        const days = pool / target.dailyAmount;
        const remaining = remainingDeposits(target.depositsCount);
        if (days > remaining) {
          throw new AppError(
            'EXCEEDS_REMAINING',
            `Only ${String(remaining)} deposit day(s) remain in this cycle`,
            422,
            {
              remaining,
            },
          );
        }
        credited = computeDepositAmount(target.dailyAmount, days);
        const completed = target.depositsCount + days === SUSU_CYCLE_DEPOSITS;
        const upd = await SusuAccountModel.updateOne(
          { _id: target._id, status: 'active', depositsCount: target.depositsCount },
          {
            $inc: { depositsCount: days, totalDeposited: credited },
            ...(completed ? { $set: { status: 'completed' } } : {}),
          },
          { session },
        );
        if (upd.modifiedCount !== 1)
          throw new AppError('CONFLICT', 'Susu changed concurrently — retry', 409);
        await SusuDepositModel.create(
          [
            {
              accountId: target._id,
              customerId,
              collectorId: actorId,
              amount: credited,
              daysCovered: days,
              seqStart: target.depositsCount + 1,
              seqEnd: target.depositsCount + days,
              channel: 'transfer',
              idempotencyKey: `transfer:${body.idempotencyKey}`,
            },
          ],
          { session },
        );
        await audit(
          {
            actorId: actor.sub,
            action: 'susu.deposit.record',
            entityType: 'susu-account',
            entityId: target._id,
            amountBefore: target.totalDeposited,
            amountAfter: target.totalDeposited + credited,
            after: { daysCovered: days, via: 'transfer' },
            ...(requestId !== undefined ? { requestId } : {}),
          },
          session,
        );
      } else if (body.to.type === 'loan') {
        const loan = await LoanModel.findById(toId).session(session);
        if (!loan || (loan.status !== 'active' && loan.status !== 'arrears')) {
          throw new AppError('LOAN_NOT_OPEN', 'Loan is not open for repayment', 422);
        }
        const loanRemaining = loan.totalDue - loan.totalRepaid;
        credited = Math.min(pool, loanRemaining);
        await applyRepaymentInTxn(
          actor,
          loan,
          credited,
          body.from.type === 'susu' && susuSourceStopping ? 'susu-closure' : 'transfer',
          'transfer',
          body.idempotencyKey,
          session,
          body.from.type === 'susu' ? body.from.accountId : undefined,
          requestId,
        );
      } else {
        const agreement = await HpAgreementModel.findById(toId).session(session);
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

      // ---------------- settle the susu source (stop / draw down)
      const excess = pool - credited;
      if (body.from.type === 'susu') {
        const account = await SusuAccountModel.findOne({ _id: body.from.accountId }).session(
          session,
        );
        if (!account) throw new AppError('NOT_FOUND', 'Source account not found', 404);
        if (susuSourceStopping) {
          const keepsPending = excess > 0;
          const upd = await SusuAccountModel.updateOne(
            { _id: account._id, status: { $in: ['active', 'completed'] } },
            {
              $set: {
                status: keepsPending ? 'pending-payout' : 'closed',
                commissionAmount: susuSourceStopping.commission,
                payoutAmount: susuSourceStopping.payout,
                payoutRemaining: keepsPending ? excess : 0,
                ...(keepsPending ? {} : { closedAt: new Date(), closedById: actorId }),
              },
            },
            { session },
          );
          if (upd.modifiedCount !== 1)
            throw new AppError('CONFLICT', 'Susu changed concurrently — retry', 409);
          await audit(
            {
              actorId: actor.sub,
              action: 'susu.account.close',
              entityType: 'susu-account',
              entityId: account._id,
              amountBefore: account.totalDeposited,
              amountAfter: susuSourceStopping.payout,
              after: { via: 'transfer', to: body.to.type, credited, excess },
              ...(requestId !== undefined ? { requestId } : {}),
            },
            session,
          );
        } else {
          const upd = await SusuAccountModel.updateOne(
            {
              _id: account._id,
              status: 'pending-payout',
              payoutRemaining: account.payoutRemaining,
            },
            {
              $inc: { payoutRemaining: -credited },
              ...(account.payoutRemaining - credited === 0
                ? { $set: { status: 'closed', closedAt: new Date(), closedById: actorId } }
                : {}),
            },
            { session },
          );
          if (upd.modifiedCount !== 1)
            throw new AppError('CONFLICT', 'Susu changed concurrently — retry', 409);
        }
        await SusuPayoutModel.create(
          [
            {
              accountId: account._id,
              customerId,
              amount: credited,
              destination: body.to.type === 'susu' ? 'savings' : body.to.type, // susu→susu impossible
              destinationId: toId,
              recordedById: actorId,
            },
          ],
          { session },
        );
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
            excessPending: body.from.type === 'susu' && susuSourceStopping ? excess : 0,
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

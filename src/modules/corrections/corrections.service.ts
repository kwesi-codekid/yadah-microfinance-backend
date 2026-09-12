import { MongoServerError } from 'mongodb';
import mongoose, { Types } from 'mongoose';
import { accountRef } from '../../lib/account-number.js';
import { audit } from '../../lib/audit.js';
import type { CorrectionPreparer, PreparedCorrection } from '../../lib/corrections.js';
import { AppError } from '../../lib/errors.js';
import { formatGhs } from '../../lib/money.js';
import { notifyInBackground, notifyOffice } from '../../lib/notifications.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import {
  CustomerModel,
  HpAgreementModel,
  LoanModel,
  SavingsAccountModel,
  SusuAccountModel,
  TxnCorrectionModel,
  UserModel,
  type CorrectionKind,
  type CorrectionStatus,
  type TxnCorrection,
} from '../../models/index.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import { preparePaymentCorrection } from '../hire-purchase/hp.service.js';
import { prepareRepaymentCorrection } from '../loans/loans.service.js';
import { prepareTxnCorrection } from '../savings/savings.service.js';
import { prepareDepositCorrection } from '../susu/susu.service.js';
import type { ListCorrectionsQuery, ProposeCorrectionBody } from './corrections.schemas.js';

/**
 * Correcting a figure already on the ledger.
 *
 * The office corrects outright. A teller may not — that is a decision — but
 * may ask, and the office decides. Approval runs the very same correction the
 * office would make by hand, so nothing a direct correction refuses can get in
 * this way either. What the correction does to the record behind the figure
 * is each module's own business, reached through its preparer below; what is
 * the same for every kind — the asking, the queue, the deciding — lives here.
 */

const PREPARERS: Record<CorrectionKind, CorrectionPreparer> = {
  'susu-deposit': prepareDepositCorrection,
  'savings-txn': prepareTxnCorrection,
  'loan-repayment': prepareRepaymentCorrection,
  'hp-payment': preparePaymentCorrection,
};

/** What the branch calls each kind, for a notification's one line. */
const KIND_LABELS: Record<CorrectionKind, string> = {
  'susu-deposit': 'susu deposit',
  'savings-txn': 'savings transaction',
  'loan-repayment': 'loan repayment',
  'hp-payment': 'hire-purchase payment',
};

// ---------------------------------------------------------------- shapes

export interface PublicCorrection {
  id: string;
  kind: CorrectionKind;
  targetId: string;
  txnId: string;
  customerId: string;
  /** Joined for display; the record itself holds only ids. */
  customerName?: string;
  /** The number the branch calls the record by: the account, loan or agreement number. */
  targetNumber?: string;
  /**
   * A second line where the number alone would not do: a susu account's own
   * ref (the number is the customer's), or the item on a hire-purchase agreement.
   */
  targetLabel?: string;
  /** The transaction as it stood when the teller asked, and what they asked for. */
  amountBefore: number;
  amount: number;
  /** Susu only: the days covered before and after. */
  unitsBefore?: number;
  units?: number;
  reason: string;
  status: CorrectionStatus;
  requestedById: string;
  requestedByName?: string;
  /** Whoever decided — or, for a cancellation, whoever withdrew it. */
  reviewedById?: string;
  reviewedByName?: string;
  reviewedAt?: Date;
  rejectionReason?: string;
  createdAt: Date;
}

interface TargetName {
  number?: string;
  label?: string;
}

interface CorrectionNames {
  customers: Map<string, string>;
  users: Map<string, string>;
  targets: Map<string, TargetName>;
}

function toPublicCorrection(c: TxnCorrection, names: CorrectionNames): PublicCorrection {
  const customerName = names.customers.get(c.customerId.toHexString());
  const target = names.targets.get(c.targetId.toHexString());
  const requestedByName = names.users.get(c.requestedById.toHexString());
  const reviewedByName = c.reviewedById ? names.users.get(c.reviewedById.toHexString()) : undefined;
  return {
    id: c._id.toHexString(),
    kind: c.kind,
    targetId: c.targetId.toHexString(),
    txnId: c.txnId.toHexString(),
    customerId: c.customerId.toHexString(),
    ...(customerName !== undefined ? { customerName } : {}),
    ...(target?.number !== undefined ? { targetNumber: target.number } : {}),
    ...(target?.label !== undefined ? { targetLabel: target.label } : {}),
    amountBefore: c.amountBefore,
    amount: c.amount,
    ...(c.unitsBefore !== undefined ? { unitsBefore: c.unitsBefore } : {}),
    ...(c.units !== undefined ? { units: c.units } : {}),
    reason: c.reason,
    status: c.status,
    requestedById: c.requestedById.toHexString(),
    ...(requestedByName !== undefined ? { requestedByName } : {}),
    ...(c.reviewedById ? { reviewedById: c.reviewedById.toHexString() } : {}),
    ...(reviewedByName !== undefined ? { reviewedByName } : {}),
    ...(c.reviewedAt !== undefined ? { reviewedAt: c.reviewedAt } : {}),
    ...(c.rejectionReason !== undefined ? { rejectionReason: c.rejectionReason } : {}),
    createdAt: c.createdAt,
  };
}

/** The records behind a page of corrections, named the way the branch names them. */
async function targetNames(rows: TxnCorrection[]): Promise<Map<string, TargetName>> {
  const byKind = new Map<CorrectionKind, Types.ObjectId[]>();
  for (const r of rows) {
    const ids = byKind.get(r.kind);
    if (ids) ids.push(r.targetId);
    else byKind.set(r.kind, [r.targetId]);
  }
  const out = new Map<string, TargetName>();
  const [susu, savings, loans, agreements] = await Promise.all([
    SusuAccountModel.find(
      { _id: { $in: byKind.get('susu-deposit') ?? [] } },
      { accountNumber: 1, createdAt: 1 },
    ),
    SavingsAccountModel.find(
      { _id: { $in: byKind.get('savings-txn') ?? [] } },
      { accountNumber: 1 },
    ),
    LoanModel.find({ _id: { $in: byKind.get('loan-repayment') ?? [] } }, { accountNumber: 1 }),
    HpAgreementModel.find(
      { _id: { $in: byKind.get('hp-payment') ?? [] } },
      { accountNumber: 1, itemSnapshot: 1 },
    ),
  ]);
  // A susu number is the customer's, shared by every book they hold, so the
  // account's own ref goes beside it — the same pairing the account page shows.
  for (const a of susu) {
    out.set(a._id.toHexString(), {
      number: a.accountNumber,
      label: accountRef(a._id.toHexString(), a.createdAt),
    });
  }
  for (const a of savings) out.set(a._id.toHexString(), { number: a.accountNumber });
  for (const l of loans) {
    out.set(l._id.toHexString(), {
      ...(l.accountNumber !== undefined ? { number: l.accountNumber } : {}),
    });
  }
  for (const a of agreements) {
    out.set(a._id.toHexString(), {
      ...(a.accountNumber !== undefined ? { number: a.accountNumber } : {}),
      label: a.itemSnapshot.name,
    });
  }
  return out;
}

/** Batch-resolve the names a page of corrections is read by. */
async function correctionNames(rows: TxnCorrection[]): Promise<CorrectionNames> {
  const customerIds = [...new Set(rows.map((r) => r.customerId.toHexString()))];
  const userIds = [
    ...new Set(
      rows.flatMap((r) => [
        r.requestedById.toHexString(),
        ...(r.reviewedById ? [r.reviewedById.toHexString()] : []),
      ]),
    ),
  ];
  const [customers, users, targets] = await Promise.all([
    CustomerModel.find({ _id: { $in: customerIds } }, { fullName: 1 }),
    UserModel.find({ _id: { $in: userIds } }, { name: 1 }),
    targetNames(rows),
  ]);
  return {
    customers: new Map(customers.map((c) => [c._id.toHexString(), c.fullName])),
    users: new Map(users.map((u) => [u._id.toHexString(), u.name])),
    targets,
  };
}

async function publicCorrection(c: TxnCorrection): Promise<PublicCorrection> {
  return toPublicCorrection(c, await correctionNames([c]));
}

/** Everything a notification about a correction needs to link to. */
function correctionData(c: TxnCorrection): Record<string, unknown> {
  return {
    correctionId: c._id.toHexString(),
    kind: c.kind,
    targetId: c.targetId.toHexString(),
    txnId: c.txnId.toHexString(),
    customerId: c.customerId.toHexString(),
  };
}

/** `#SV26090002`, or the kind when the record carries no number. */
function nameOfTarget(kind: CorrectionKind, target: TargetName | undefined): string {
  return target?.number !== undefined ? `#${target.number}` : `the ${KIND_LABELS[kind]}`;
}

// ---------------------------------------------------------------- the office, outright

/**
 * The office corrects a transaction. Every rule the module has runs, and the
 * change commits on its own; a request waiting on the same transaction, if
 * there is one, is left for the office to decide separately — approving it
 * afterwards is then only the bookkeeping.
 */
export async function correct(
  actor: AccessTokenPayload,
  kind: CorrectionKind,
  targetId: Types.ObjectId,
  txnId: Types.ObjectId,
  amount: number,
  requestId?: string,
): Promise<{ target: unknown; txn: unknown }> {
  const prepared = await PREPARERS[kind](targetId, txnId);
  prepared.plan(amount);
  if (amount === prepared.amount) return prepared.result();

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await prepared.apply(session, actor, amount, requestId, undefined);
    });
  } finally {
    await session.endSession();
  }
  emitAdminEvent('txn.corrected', {
    kind,
    targetId: targetId.toHexString(),
    txnId: txnId.toHexString(),
    amountBefore: prepared.amount,
    amount,
  });
  return prepared.result();
}

// ---------------------------------------------------------------- asking

/**
 * A teller asks the office to correct a transaction.
 *
 * Nothing on the ledger moves. The request is refused on the spot for anything
 * the correction itself would refuse, so what reaches the office is something
 * it CAN approve, as the record stands now.
 */
export async function propose(
  actor: AccessTokenPayload,
  kind: CorrectionKind,
  targetId: Types.ObjectId,
  txnId: Types.ObjectId,
  body: ProposeCorrectionBody,
  requestId?: string,
): Promise<PublicCorrection> {
  const prepared = await PREPARERS[kind](targetId, txnId);
  const plan = prepared.plan(body.amount);
  if (body.amount === prepared.amount) {
    throw new AppError('NO_CHANGE', 'That is already the amount on this transaction', 422);
  }

  let correction: TxnCorrection;
  try {
    correction = await TxnCorrectionModel.create({
      kind,
      targetId,
      txnId,
      customerId: prepared.customerId,
      amountBefore: prepared.amount,
      amount: body.amount,
      ...(prepared.units !== undefined ? { unitsBefore: prepared.units } : {}),
      ...(plan.units !== undefined ? { units: plan.units } : {}),
      reason: body.reason,
      status: 'pending',
      requestedById: new Types.ObjectId(actor.sub),
    });
  } catch (err) {
    // The one-open-request-per-transaction index. Two figures queued against
    // one entry would let the office approve both, and the second would apply
    // to a transaction that no longer says what the teller saw.
    if (err instanceof MongoServerError && err.code === 11000) {
      throw new AppError(
        'CORRECTION_PENDING',
        'A correction is already waiting on this transaction',
        409,
      );
    }
    throw err;
  }

  await audit({
    actorId: actor.sub,
    action: 'txn.correction.propose',
    entityType: 'txn-correction',
    entityId: correction._id,
    amountBefore: prepared.amount,
    amountAfter: body.amount,
    after: { kind, txnId: txnId.toHexString(), amount: body.amount, reason: body.reason },
    ...(requestId !== undefined ? { requestId } : {}),
  });

  const names = await correctionNames([correction]);
  const teller = names.users.get(actor.sub) ?? 'A teller';
  const customer = names.customers.get(prepared.customerId.toHexString()) ?? 'a customer';
  const target = nameOfTarget(kind, names.targets.get(targetId.toHexString()));
  notifyOffice({
    type: 'txn.correction',
    title: 'Correction to approve',
    body:
      `${teller} asks to change a ${KIND_LABELS[kind]} on ${customer}'s ${target} ` +
      `from ${formatGhs(prepared.amount)} to ${formatGhs(body.amount)}: ${body.reason}`,
    data: correctionData(correction),
  });
  emitAdminEvent('txn.correction.proposed', {
    ...correctionData(correction),
    amountBefore: prepared.amount,
    amount: body.amount,
  });
  return toPublicCorrection(correction, names);
}

/**
 * The queue. Every counter role reads the whole of it: a teller has to see
 * that somebody else's request is already waiting on a transaction before
 * trying to raise their own. Cancelling stays with whoever asked.
 */
export async function list(
  _actor: AccessTokenPayload,
  query: ListCorrectionsQuery,
): Promise<{ items: PublicCorrection[]; page: number; limit: number; total: number }> {
  const filter: Record<string, unknown> = {
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.kind !== undefined ? { kind: query.kind } : {}),
    ...(query.targetId !== undefined ? { targetId: query.targetId } : {}),
  };
  const [rows, total] = await Promise.all([
    TxnCorrectionModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    TxnCorrectionModel.countDocuments(filter),
  ]);
  const names = await correctionNames(rows);
  return {
    items: rows.map((r) => toPublicCorrection(r, names)),
    page: query.page,
    limit: query.limit,
    total,
  };
}

// ---------------------------------------------------------------- deciding

/**
 * The office applies a teller's correction.
 *
 * The correction is the same one the office would make by hand, checked
 * against the record as it stands NOW — not as it stood when the teller asked.
 * A rule that refuses it here (a newer transaction has landed, the account has
 * been closed) leaves the request open with the refusal as the answer: the
 * office reads why and declines it with that reason, or puts the record right
 * and tries again. Nothing is applied by halves — the transaction changes and
 * the request becomes approved in one transaction, or neither happens.
 */
export async function approve(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  requestId?: string,
): Promise<{ correction: PublicCorrection; target: unknown; txn: unknown }> {
  const correction = await TxnCorrectionModel.findById(id);
  if (!correction) throw new AppError('NOT_FOUND', 'Correction not found', 404);
  if (correction.status !== 'pending') {
    throw new AppError('NOT_PENDING', `Correction is already ${correction.status}`, 409);
  }
  const prepared: PreparedCorrection = await PREPARERS[correction.kind](
    correction.targetId,
    correction.txnId,
  );
  prepared.plan(correction.amount);
  // Already at the asked figure — the office corrected it by hand in the
  // meantime. Approving is then only the bookkeeping.
  const unchanged = correction.amount === prepared.amount;

  const now = new Date();
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (!unchanged) {
        await prepared.apply(session, actor, correction.amount, requestId, {
          correctionId: correction._id,
          requestedById: correction.requestedById,
        });
      }
      const decided = await TxnCorrectionModel.updateOne(
        { _id: correction._id, status: 'pending' },
        {
          $set: {
            status: 'approved',
            reviewedById: new Types.ObjectId(actor.sub),
            reviewedAt: now,
          },
        },
        { session },
      );
      if (decided.modifiedCount !== 1) {
        throw new AppError('NOT_PENDING', 'Correction was decided concurrently', 409);
      }
      await audit(
        {
          actorId: actor.sub,
          action: 'txn.correction.approve',
          entityType: 'txn-correction',
          entityId: correction._id,
          amountBefore: correction.amountBefore,
          amountAfter: correction.amount,
          after: {
            kind: correction.kind,
            txnId: correction.txnId.toHexString(),
            amount: correction.amount,
            requestedById: correction.requestedById.toHexString(),
          },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const afterCorrection = await TxnCorrectionModel.findById(id);
  if (!afterCorrection) throw new AppError('NOT_FOUND', 'Correction not found', 404);
  const names = await correctionNames([afterCorrection]);
  const target = nameOfTarget(
    correction.kind,
    names.targets.get(correction.targetId.toHexString()),
  );
  emitAdminEvent('txn.corrected', {
    kind: correction.kind,
    targetId: correction.targetId.toHexString(),
    txnId: correction.txnId.toHexString(),
    amountBefore: prepared.amount,
    amount: correction.amount,
  });
  emitAdminEvent('txn.correction.approved', correctionData(correction));
  notifyInBackground({
    userIds: [correction.requestedById],
    type: 'txn.correction',
    title: 'Correction approved',
    body:
      `Your correction on ${target} was applied: the ${KIND_LABELS[correction.kind]} is now ` +
      `${formatGhs(correction.amount)}, was ${formatGhs(correction.amountBefore)}.`,
    data: correctionData(correction),
  });
  return {
    correction: toPublicCorrection(afterCorrection, names),
    ...(await prepared.result()),
  };
}

/** The office declines. The transaction is untouched; the teller reads why. */
export async function reject(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  reason: string,
  requestId?: string,
): Promise<PublicCorrection> {
  const now = new Date();
  const correction = await TxnCorrectionModel.findOneAndUpdate(
    { _id: id, status: 'pending' },
    {
      $set: {
        status: 'rejected',
        reviewedById: new Types.ObjectId(actor.sub),
        reviewedAt: now,
        rejectionReason: reason,
      },
    },
    { returnDocument: 'after' },
  );
  if (!correction) {
    const existing = await TxnCorrectionModel.findById(id);
    if (!existing) throw new AppError('NOT_FOUND', 'Correction not found', 404);
    throw new AppError('NOT_PENDING', `Correction is already ${existing.status}`, 409);
  }

  await audit({
    actorId: actor.sub,
    action: 'txn.correction.reject',
    entityType: 'txn-correction',
    entityId: correction._id,
    after: { reason },
    ...(requestId !== undefined ? { requestId } : {}),
  });

  const names = await correctionNames([correction]);
  const target = nameOfTarget(
    correction.kind,
    names.targets.get(correction.targetId.toHexString()),
  );
  emitAdminEvent('txn.correction.rejected', correctionData(correction));
  notifyInBackground({
    userIds: [correction.requestedById],
    type: 'txn.correction',
    title: 'Correction declined',
    body:
      `The office did not apply your correction on ${target} ` +
      `(${formatGhs(correction.amountBefore)} to ${formatGhs(correction.amount)}): ${reason}`,
    data: correctionData(correction),
  });
  return toPublicCorrection(correction, names);
}

/**
 * Whoever asked takes it back before a decision. The office may tidy one away
 * too; another teller may not — a request is its author's until it is decided.
 */
export async function cancel(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  requestId?: string,
): Promise<PublicCorrection> {
  const existing = await TxnCorrectionModel.findById(id);
  if (!existing) throw new AppError('NOT_FOUND', 'Correction not found', 404);
  const office = actor.role === 'admin' || actor.role === 'manager';
  if (!office && existing.requestedById.toHexString() !== actor.sub) {
    throw new AppError('FORBIDDEN', 'Only whoever asked for this correction can cancel it', 403);
  }

  const correction = await TxnCorrectionModel.findOneAndUpdate(
    { _id: id, status: 'pending' },
    {
      $set: {
        status: 'cancelled',
        reviewedById: new Types.ObjectId(actor.sub),
        reviewedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  if (!correction) {
    throw new AppError('NOT_PENDING', `Correction is already ${existing.status}`, 409);
  }

  await audit({
    actorId: actor.sub,
    action: 'txn.correction.cancel',
    entityType: 'txn-correction',
    entityId: correction._id,
    ...(requestId !== undefined ? { requestId } : {}),
  });
  emitAdminEvent('txn.correction.cancelled', correctionData(correction));
  return publicCorrection(correction);
}

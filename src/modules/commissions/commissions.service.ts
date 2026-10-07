import mongoose, { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { fuzzyCustomerIds } from '../../lib/fuzzy.js';
import { formatGhs } from '../../lib/money.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { accraDay, createdAtFilter } from '../../lib/time.js';
import {
  CashAccountModel,
  CommissionModel,
  CommissionMoveModel,
  CustomerModel,
  LoanModel,
  SavingsAccountModel,
  SusuAccountModel,
  UserModel,
  COMMISSION_SOURCES,
  type Commission,
  type CommissionChannel,
  type CommissionMove,
  type CommissionReason,
  type CommissionSource,
} from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type {
  CreateMoveBody,
  ListCommissionsQuery,
  ListMovesQuery,
} from './commissions.schemas.js';

/**
 * Yadah's commission account (client decisions, 7 Oct 2026): what the company
 * keeps from susu, savings and loans — and the moves that send it on to the
 * company's cash accounts.
 *
 *   balance = Σ entries − Σ moves (not trashed)
 *
 * Entries are written where the money is earned (commissions.ledger.ts);
 * moves are recorded here by office staff.
 */

// ---------------------------------------------------------------- shapes

export interface PublicCommission {
  id: string;
  source: CommissionSource;
  reason: CommissionReason;
  amount: number;
  customerId: string;
  customerName?: string;
  /** The susu account, savings account or loan it was earned on. */
  accountId: string;
  accountNumber?: string;
  channel: CommissionChannel;
  takenAt: Date;
  recordedById?: string;
  cycleNumber?: number;
  dailyAmount?: number;
  depositId?: string;
  payoutId?: string;
  savingsTxnId?: string;
}

function toPublicCommission(c: Commission): PublicCommission {
  return {
    id: c._id.toHexString(),
    source: c.source,
    reason: c.reason,
    amount: c.amount,
    customerId: c.customerId.toHexString(),
    accountId: c.accountId.toHexString(),
    channel: c.channel,
    takenAt: c.takenAt,
    ...(c.recordedById ? { recordedById: c.recordedById.toHexString() } : {}),
    ...(c.cycleNumber !== undefined ? { cycleNumber: c.cycleNumber } : {}),
    ...(c.dailyAmount !== undefined ? { dailyAmount: c.dailyAmount } : {}),
    ...(c.depositId ? { depositId: c.depositId.toHexString() } : {}),
    ...(c.payoutId ? { payoutId: c.payoutId.toHexString() } : {}),
    ...(c.savingsTxnId ? { savingsTxnId: c.savingsTxnId.toHexString() } : {}),
  };
}

export interface PublicCommissionMove {
  id: string;
  amount: number;
  cashAccountId: string;
  cashAccountName?: string;
  occurredOn: string;
  note?: string;
  recordedById: string;
  recordedByName?: string;
  createdAt: Date;
  deletedAt?: Date;
  deleteReason?: string;
}

function toPublicMove(m: CommissionMove): PublicCommissionMove {
  return {
    id: m._id.toHexString(),
    amount: m.amount,
    cashAccountId: m.cashAccountId.toHexString(),
    occurredOn: m.occurredOn,
    ...(m.note !== undefined ? { note: m.note } : {}),
    recordedById: m.recordedById.toHexString(),
    createdAt: m.createdAt,
    ...(m.deletedAt ? { deletedAt: m.deletedAt } : {}),
    ...(m.deleteReason !== undefined ? { deleteReason: m.deleteReason } : {}),
  };
}

// ---------------------------------------------------------------- balance

/**
 * Σ entries − Σ moves, pesewas. `asOf` (an inclusive Accra day) gives the
 * balance at the close of that day — what the balance sheet asks for.
 */
export async function commissionBalance(asOf?: string): Promise<{
  earned: number;
  moved: number;
  balance: number;
}> {
  const takenAt = createdAtFilter(undefined, asOf);
  const [earned, moved] = await Promise.all([
    CommissionModel.aggregate<{ amount: number }>([
      { $match: takenAt ? { takenAt } : {} },
      { $group: { _id: null, amount: { $sum: '$amount' } } },
    ]),
    CommissionMoveModel.aggregate<{ amount: number }>([
      { $match: { ...NOT_TRASHED, ...(asOf ? { occurredOn: { $lte: asOf } } : {}) } },
      { $group: { _id: null, amount: { $sum: '$amount' } } },
    ]),
  ]);
  const e = earned[0]?.amount ?? 0;
  const m = moved[0]?.amount ?? 0;
  return { earned: e, moved: m, balance: e - m };
}

export interface CommissionSummary {
  /** What the commission account holds now. */
  balance: number;
  /** Ever earned, by source. */
  earned: { total: number; bySource: Record<CommissionSource, number> };
  /** Ever moved out to the cash accounts. */
  moved: number;
}

export async function summary(): Promise<CommissionSummary> {
  const [totals, bySource] = await Promise.all([
    commissionBalance(),
    CommissionModel.aggregate<{ _id: CommissionSource; amount: number }>([
      { $group: { _id: '$source', amount: { $sum: '$amount' } } },
    ]),
  ]);
  const sources = Object.fromEntries(
    COMMISSION_SOURCES.map((s) => [s, bySource.find((r) => r._id === s)?.amount ?? 0]),
  ) as Record<CommissionSource, number>;
  return {
    balance: totals.balance,
    earned: { total: totals.earned, bySource: sources },
    moved: totals.moved,
  };
}

// ---------------------------------------------------------------- entries

/** Account ids whose number is exactly this — susu, savings or loan. */
async function accountIdsByNumber(term: string): Promise<Types.ObjectId[]> {
  const accountNumber = term.trim().toUpperCase();
  const [susu, savings, loans] = await Promise.all([
    SusuAccountModel.find({ accountNumber }, { _id: 1 }),
    SavingsAccountModel.find({ accountNumber }, { _id: 1 }),
    LoanModel.find({ accountNumber }, { _id: 1 }),
  ]);
  return [...susu, ...savings, ...loans].map((d) => d._id);
}

/** Account numbers for display, keyed by id, whichever product they belong to. */
async function accountNumbers(ids: Types.ObjectId[]): Promise<Map<string, string>> {
  const [susu, savings, loans] = await Promise.all([
    SusuAccountModel.find({ _id: { $in: ids } }, { accountNumber: 1 }),
    SavingsAccountModel.find({ _id: { $in: ids } }, { accountNumber: 1 }),
    LoanModel.find({ _id: { $in: ids } }, { accountNumber: 1 }),
  ]);
  return new Map(
    [...susu, ...savings, ...loans].flatMap((d) =>
      d.accountNumber ? [[d._id.toHexString(), d.accountNumber] as const] : [],
    ),
  );
}

export async function listCommissions(query: ListCommissionsQuery): Promise<{
  items: PublicCommission[];
  page: number;
  limit: number;
  total: number;
  /** Over the whole filter, not the page. */
  totals: { amount: number; bySource: Record<CommissionSource, number> };
}> {
  const filter: Record<string, unknown> = {};
  const takenAt = createdAtFilter(query.from, query.to);
  if (takenAt) filter.takenAt = takenAt;
  if (query.source) filter.source = query.source;
  if (query.q) {
    const [customerIds, accountIds] = await Promise.all([
      fuzzyCustomerIds(query.q),
      accountIdsByNumber(query.q),
    ]);
    filter.$or = [{ customerId: { $in: customerIds } }, { accountId: { $in: accountIds } }];
  }

  // The per-source totals ignore the source filter so the rail can show
  // every count while one source is picked.
  const { source: _picked, ...unsourced } = filter;
  void _picked;
  const [rows, total, bySource] = await Promise.all([
    CommissionModel.find(filter)
      .sort({ takenAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    CommissionModel.countDocuments(filter),
    CommissionModel.aggregate<{ _id: CommissionSource; amount: number }>([
      { $match: unsourced },
      { $group: { _id: '$source', amount: { $sum: '$amount' } } },
    ]),
  ]);

  const [customers, numbers] = await Promise.all([
    CustomerModel.find({ _id: { $in: rows.map((r) => r.customerId) } }, { fullName: 1 }),
    accountNumbers(rows.map((r) => r.accountId)),
  ]);
  const names = new Map(customers.map((c) => [c._id.toHexString(), c.fullName]));
  const sources = Object.fromEntries(
    COMMISSION_SOURCES.map((s) => [s, bySource.find((r) => r._id === s)?.amount ?? 0]),
  ) as Record<CommissionSource, number>;

  return {
    items: rows.map((r) => {
      const name = names.get(r.customerId.toHexString());
      const number = numbers.get(r.accountId.toHexString());
      return {
        ...toPublicCommission(r),
        ...(name !== undefined ? { customerName: name } : {}),
        ...(number !== undefined ? { accountNumber: number } : {}),
      };
    }),
    page: query.page,
    limit: query.limit,
    total,
    totals: {
      amount: query.source
        ? sources[query.source]
        : Object.values(sources).reduce((a, b) => a + b, 0),
      bySource: sources,
    },
  };
}

// ---------------------------------------------------------------- moves

export async function listMoves(query: ListMovesQuery): Promise<{
  items: PublicCommissionMove[];
  page: number;
  limit: number;
  total: number;
  totalAmount: number;
}> {
  const filter: Record<string, unknown> = { ...NOT_TRASHED };
  if (query.from || query.to) {
    filter.occurredOn = {
      ...(query.from ? { $gte: query.from } : {}),
      ...(query.to ? { $lte: query.to } : {}),
    };
  }
  if (query.cashAccountId) filter.cashAccountId = query.cashAccountId;
  const [rows, total, sum] = await Promise.all([
    CommissionMoveModel.find(filter)
      .sort({ occurredOn: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    CommissionMoveModel.countDocuments(filter),
    CommissionMoveModel.aggregate<{ amount: number }>([
      { $match: filter },
      { $group: { _id: null, amount: { $sum: '$amount' } } },
    ]),
  ]);
  return {
    items: await withNames(rows),
    page: query.page,
    limit: query.limit,
    total,
    totalAmount: sum[0]?.amount ?? 0,
  };
}

async function withNames(rows: CommissionMove[]): Promise<PublicCommissionMove[]> {
  const [accounts, users] = await Promise.all([
    CashAccountModel.find({ _id: { $in: rows.map((r) => r.cashAccountId) } }, { name: 1 }),
    UserModel.find({ _id: { $in: rows.map((r) => r.recordedById) } }, { name: 1 }),
  ]);
  const accountName = new Map(accounts.map((a) => [a._id.toHexString(), a.name]));
  const userName = new Map(users.map((u) => [u._id.toHexString(), u.name]));
  return rows.map((r) => {
    const a = accountName.get(r.cashAccountId.toHexString());
    const u = userName.get(r.recordedById.toHexString());
    return {
      ...toPublicMove(r),
      ...(a !== undefined ? { cashAccountName: a } : {}),
      ...(u !== undefined ? { recordedByName: u } : {}),
    };
  });
}

async function publicMove(m: CommissionMove): Promise<PublicCommissionMove> {
  const [one] = await withNames([m]);
  if (!one) throw new AppError('NOT_FOUND', 'Move not found', 404);
  return one;
}

/**
 * Every move takes this one document's lock inside its transaction, so two
 * moves at once cannot both pass the balance check and overdraw the account.
 */
async function lockCommissionAccount(session: mongoose.ClientSession): Promise<void> {
  await mongoose.connection
    .collection<{ _id: string; version: number }>('locks')
    .updateOne({ _id: 'commission-account' }, { $inc: { version: 1 } }, { upsert: true, session });
}

/**
 * Move commission into one of the company's cash accounts. Never more than the
 * commission account holds; idempotent on the key.
 */
export async function createMove(
  actor: AccessTokenPayload,
  body: CreateMoveBody,
  requestId?: string,
): Promise<{ move: PublicCommissionMove; balance: number; replayed: boolean }> {
  const existing = await CommissionMoveModel.findOne({ idempotencyKey: body.idempotencyKey });
  if (existing) {
    return {
      move: await publicMove(existing),
      balance: (await commissionBalance()).balance,
      replayed: true,
    };
  }

  const cash = await CashAccountModel.findOne({ _id: body.cashAccountId, ...NOT_TRASHED });
  if (!cash) throw new AppError('NOT_FOUND', 'Cash account not found', 404);
  if (cash.status !== 'active') {
    throw new AppError('ACCOUNT_CLOSED', 'That cash account is closed', 422);
  }
  const occurredOn = body.occurredOn ?? accraDay();
  if (occurredOn > accraDay()) {
    throw new AppError('FUTURE_DATE', 'A move cannot be dated in the future', 422);
  }

  let moveId!: Types.ObjectId;
  let before = 0;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await lockCommissionAccount(session);
      const [earned, moved] = await Promise.all([
        CommissionModel.aggregate<{ amount: number }>([
          { $group: { _id: null, amount: { $sum: '$amount' } } },
        ]).session(session),
        CommissionMoveModel.aggregate<{ amount: number }>([
          { $match: { ...NOT_TRASHED } },
          { $group: { _id: null, amount: { $sum: '$amount' } } },
        ]).session(session),
      ]);
      before = (earned[0]?.amount ?? 0) - (moved[0]?.amount ?? 0);
      if (body.amount > before) {
        throw new AppError(
          'EXCEEDS_BALANCE',
          `The commission account holds ${formatGhs(before)} — that is the most that can be moved`,
          422,
          { balance: before },
        );
      }
      const [created] = await CommissionMoveModel.create(
        [
          {
            amount: body.amount,
            cashAccountId: cash._id,
            occurredOn,
            ...(body.note ? { note: body.note } : {}),
            recordedById: new Types.ObjectId(actor.sub),
            idempotencyKey: body.idempotencyKey,
          },
        ],
        { session },
      );
      if (!created) throw new AppError('INTERNAL_ERROR', 'Move was not recorded', 500);
      moveId = created._id;
      await audit(
        {
          actorId: actor.sub,
          action: 'commission.move',
          entityType: 'commission-move',
          entityId: moveId,
          amountBefore: before,
          amountAfter: before - body.amount,
          after: {
            amount: body.amount,
            cashAccountId: cash._id.toHexString(),
            cashAccount: cash.name,
            occurredOn,
          },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const saved = await CommissionMoveModel.findById(moveId);
  if (!saved) throw new AppError('NOT_FOUND', 'Move not found', 404);
  const move = await publicMove(saved);
  emitAdminEvent('commission.moved', {
    id: moveId.toHexString(),
    amount: body.amount,
    cashAccountId: cash._id.toHexString(),
    balance: before - body.amount,
  });
  return { move, balance: before - body.amount, replayed: false };
}

/**
 * A move made in error goes to the trash: the money is back in the commission
 * account and out of the cash account, ready to be moved again correctly.
 */
export async function trashMove(
  actor: AccessTokenPayload,
  moveId: Types.ObjectId,
  reason: string | undefined,
  requestId?: string,
): Promise<{ move: PublicCommissionMove; balance: number }> {
  const now = new Date();
  const move = await CommissionMoveModel.findOneAndUpdate(
    { _id: moveId, ...NOT_TRASHED },
    {
      $set: {
        deletedAt: now,
        deletedById: new Types.ObjectId(actor.sub),
        ...(reason !== undefined ? { deleteReason: reason } : {}),
      },
    },
    { returnDocument: 'after' },
  );
  if (!move) throw new AppError('NOT_FOUND', 'Move not found, or already in the trash', 404);
  await audit({
    actorId: actor.sub,
    action: 'commission.move.trash',
    entityType: 'commission-move',
    entityId: moveId,
    before: { amount: move.amount, deletedAt: null },
    after: { deletedAt: now.toISOString(), ...(reason !== undefined ? { reason } : {}) },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return {
    move: await publicMove(move),
    balance: (await commissionBalance()).balance,
  };
}

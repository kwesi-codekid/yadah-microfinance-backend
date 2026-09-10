import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { notifyOffice } from '../../lib/notifications.js';
import { formatGhs } from '../../lib/money.js';
import { accraDay as todayInAccra, dayWindow } from '../../lib/time.js';
import {
  ReconciliationModel,
  SavingsTxnModel,
  SusuDepositModel,
  UserModel,
  type Reconciliation,
} from '../../models/index.js';
import { NOT_TRASHED, type Role } from '../../models/shared.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type {
  ConfirmDayBody,
  DeclareDayBody,
  ListReconciliationsQuery,
  VarianceReportQuery,
} from './reconciliation.schemas.js';

// ---------------------------------------------------------------- shapes

export interface ExpectedCash {
  collectorId: string;
  accraDay: string;
  /** Cash-channel susu deposits recorded by this collector that day. */
  susu: number;
  /** Cash-channel savings deposits recorded by this collector that day. */
  savings: number;
  total: number;
  /** How many deposits make up the total — a sanity check for the collector. */
  entries: number;
}

export interface PublicReconciliation {
  id: string;
  collectorId: string;
  collectorName?: string;
  /**
   * What the person who declared this day does here.
   *
   * The handover chain runs one rank at a time — a teller counts in a
   * collector's day, the office counts in a teller's — so whoever is looking at
   * a row needs to know whose day it is before they can be offered the count.
   * Hydrated alongside the name, from the same read.
   */
  collectorRole?: Role;
  accraDay: string;
  expectedAmount: number;
  expectedBreakdown: { susu: number; savings: number };
  declaredAmount: number;
  declaredAt: Date;
  declaredNote?: string;
  receivedAmount?: number;
  receivedById?: string;
  receivedAt?: Date;
  variance?: number;
  declaredVsReceived?: number;
  varianceReason?: string;
  status: 'declared' | 'reconciled';
}

export function toPublicReconciliation(r: Reconciliation): PublicReconciliation {
  return {
    id: r._id.toHexString(),
    collectorId: r.collectorId.toHexString(),
    accraDay: r.accraDay,
    expectedAmount: r.expectedAmount,
    expectedBreakdown: {
      susu: r.expectedBreakdown.susu,
      savings: r.expectedBreakdown.savings,
    },
    declaredAmount: r.declaredAmount,
    declaredAt: r.declaredAt,
    ...(r.declaredNote !== undefined ? { declaredNote: r.declaredNote } : {}),
    ...(r.receivedAmount !== undefined ? { receivedAmount: r.receivedAmount } : {}),
    ...(r.receivedById ? { receivedById: r.receivedById.toHexString() } : {}),
    ...(r.receivedAt !== undefined ? { receivedAt: r.receivedAt } : {}),
    ...(r.variance !== undefined ? { variance: r.variance } : {}),
    ...(r.declaredVsReceived !== undefined ? { declaredVsReceived: r.declaredVsReceived } : {}),
    ...(r.varianceReason !== undefined ? { varianceReason: r.varianceReason } : {}),
    status: r.status,
  };
}

export function toReconciliationExportRow(item: PublicReconciliation): Record<string, unknown> {
  return {
    accraDay: item.accraDay,
    collectorId: item.collectorId,
    collectorName: item.collectorName ?? '',
    expectedAmount: item.expectedAmount,
    expectedSusu: item.expectedBreakdown.susu,
    expectedSavings: item.expectedBreakdown.savings,
    declaredAmount: item.declaredAmount,
    receivedAmount: item.receivedAmount ?? null,
    variance: item.variance ?? null,
    declaredVsReceived: item.declaredVsReceived ?? null,
    varianceReason: item.varianceReason ?? '',
    status: item.status,
    declaredAt: item.declaredAt,
    receivedAt: item.receivedAt ?? null,
  };
}

// ---------------------------------------------------------------- expected cash

/**
 * What the system says a collector took in cash on a given Accra day.
 *
 * Cash channel only: a Paystack or momo deposit never passed through the
 * collector's hands, and a transfer leg is not cash at all. Loans and hire
 * purchase are excluded entirely — those are collected at the office.
 */
export async function expectedForDay(
  collectorId: Types.ObjectId,
  accraDay: string,
): Promise<ExpectedCash> {
  const { start, end } = dayWindow(accraDay, accraDay);
  const createdAt = { $gte: start, $lt: end };

  const [susuRows, savingsRows] = await Promise.all([
    SusuDepositModel.aggregate<{ _id: null; total: number; count: number }>([
      { $match: { collectorId, channel: 'cash', createdAt, ...NOT_TRASHED } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    SavingsTxnModel.aggregate<{ _id: null; total: number; count: number }>([
      {
        $match: {
          recordedById: collectorId,
          type: 'deposit',
          channel: 'cash',
          accraDay,
          ...NOT_TRASHED,
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
  ]);

  const susu = susuRows[0]?.total ?? 0;
  const savings = savingsRows[0]?.total ?? 0;
  return {
    collectorId: collectorId.toHexString(),
    accraDay,
    susu,
    savings,
    total: susu + savings,
    entries: (susuRows[0]?.count ?? 0) + (savingsRows[0]?.count ?? 0),
  };
}

/** Office roles may inspect any collector; a collector is pinned to themselves. */
function resolveCollectorId(
  actor: AccessTokenPayload,
  requested: Types.ObjectId | undefined,
): Types.ObjectId {
  if (actor.role === 'collector') return new Types.ObjectId(actor.sub);
  if (!requested) {
    throw new AppError('COLLECTOR_REQUIRED', 'Office roles must name a collectorId', 422);
  }
  return requested;
}

export async function previewExpected(
  actor: AccessTokenPayload,
  accraDay: string | undefined,
  collectorId: Types.ObjectId | undefined,
): Promise<ExpectedCash> {
  return expectedForDay(resolveCollectorId(actor, collectorId), accraDay ?? todayInAccra());
}

// ---------------------------------------------------------------- declare

/**
 * Step 1: the collector counts the cash in hand and closes their day. The
 * declared figure is recorded as given — a mismatch with the system total is
 * information for the receiver, not an error to correct here.
 */
export async function declareDay(
  actor: AccessTokenPayload,
  body: DeclareDayBody,
  requestId?: string,
): Promise<PublicReconciliation> {
  // Both ends of the chain close a day of their own: the collector's round,
  // and the teller's till. The office receives, and has no day to declare.
  if (actor.role !== 'collector' && actor.role !== 'teller') {
    throw new AppError(
      'FORBIDDEN',
      'Only somebody who handled cash closes a day — a collector or a teller',
      403,
    );
  }
  const collectorId = new Types.ObjectId(actor.sub);
  const day = body.accraDay ?? todayInAccra();
  if (day > todayInAccra()) {
    throw new AppError('FUTURE_DAY', 'A day cannot be closed before it happens', 422);
  }

  const existing = await ReconciliationModel.findOne({ collectorId, accraDay: day });
  if (existing) {
    throw new AppError(
      'ALREADY_DECLARED',
      existing.status === 'reconciled'
        ? `${day} has already been reconciled`
        : `${day} has already been declared and is awaiting the office`,
      409,
      { reconciliationId: existing._id.toHexString(), status: existing.status },
    );
  }

  const expected = await expectedForDay(collectorId, day);
  const created = await ReconciliationModel.create({
    collectorId,
    accraDay: day,
    expectedAmount: expected.total,
    expectedBreakdown: { susu: expected.susu, savings: expected.savings },
    declaredAmount: body.declaredAmount,
    declaredAt: new Date(),
    ...(body.declaredNote !== undefined ? { declaredNote: body.declaredNote } : {}),
    status: 'declared',
  });

  await audit({
    actorId: actor.sub,
    action: 'reconciliation.declare',
    entityType: 'reconciliation',
    entityId: created._id,
    amountBefore: expected.total,
    amountAfter: body.declaredAmount,
    after: {
      accraDay: day,
      expected: expected.total,
      declared: body.declaredAmount,
      breakdown: { susu: expected.susu, savings: expected.savings },
    },
    ...(requestId !== undefined ? { requestId } : {}),
  });

  const result = toPublicReconciliation(created);
  emitAdminEvent('reconciliation.declared', {
    id: result.id,
    collectorId: result.collectorId,
    accraDay: day,
    expected: expected.total,
    declared: body.declaredAmount,
  });
  // The office is the one that has to act on this — cash is waiting to be counted.
  notifyOffice({
    type: 'reconciliation.declared',
    title: 'Cash waiting to be received',
    body:
      `A collector closed ${day} with ${formatGhs(body.declaredAmount)} in hand ` +
      `(system expects ${formatGhs(expected.total)}).`,
    data: { entity: 'reconciliation', reconciliationId: result.id, accraDay: day },
  });
  return result;
}

// ---------------------------------------------------------------- confirm

/**
 * Step 2: the office receiver counts what was handed over and closes the day.
 * A shortage is recorded, never blocked — the collector keeps working and the
 * variance surfaces in the variance report.
 */
export async function confirmDay(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  body: ConfirmDayBody,
  requestId?: string,
): Promise<PublicReconciliation> {
  const record = await ReconciliationModel.findById(id);
  if (!record) throw new AppError('NOT_FOUND', 'Reconciliation not found', 404);
  if (record.status === 'reconciled') {
    throw new AppError('ALREADY_RECONCILED', 'This day has already been reconciled', 409);
  }
  if (record.collectorId.equals(actor.sub)) {
    throw new AppError('SELF_RECEIPT', 'Nobody confirms receipt of their own cash', 403);
  }

  /**
   * The chain the cash actually walks (client decision, 10 Sep 2026): a
   * collector hands to a teller, and a teller hands to the office. So a teller
   * may count in a collector's day but not another teller's — their own day is
   * counted by a manager, the same way the collector's is counted by them.
   */
  if (actor.role === 'teller') {
    const declarer = await UserModel.findById(record.collectorId).select('role');
    if (declarer?.role !== 'collector') {
      throw new AppError(
        'NOT_YOUR_HANDOVER',
        'A teller counts in a collector’s day. This one is counted in by a manager.',
        403,
      );
    }
  }

  // Recomputed here, not reused from declaration: a deposit may have been
  // corrected or trashed in between, and the variance must reflect the truth
  // at the moment the money changed hands.
  const expected = await expectedForDay(record.collectorId, record.accraDay);
  const variance = body.receivedAmount - expected.total;

  record.expectedAmount = expected.total;
  record.expectedBreakdown = { susu: expected.susu, savings: expected.savings };
  record.receivedAmount = body.receivedAmount;
  record.receivedById = new Types.ObjectId(actor.sub);
  record.receivedAt = new Date();
  record.variance = variance;
  record.declaredVsReceived = body.receivedAmount - record.declaredAmount;
  if (body.varianceReason !== undefined) record.varianceReason = body.varianceReason;
  record.status = 'reconciled';
  await record.save();

  await audit({
    actorId: actor.sub,
    action: 'reconciliation.confirm',
    entityType: 'reconciliation',
    entityId: record._id,
    amountBefore: expected.total,
    amountAfter: body.receivedAmount,
    after: {
      accraDay: record.accraDay,
      collectorId: record.collectorId.toHexString(),
      expected: expected.total,
      declared: record.declaredAmount,
      received: body.receivedAmount,
      variance,
      ...(body.varianceReason !== undefined ? { varianceReason: body.varianceReason } : {}),
    },
    ...(requestId !== undefined ? { requestId } : {}),
  });

  const result = toPublicReconciliation(record);
  emitAdminEvent('reconciliation.reconciled', {
    id: result.id,
    collectorId: result.collectorId,
    accraDay: record.accraDay,
    expected: expected.total,
    received: body.receivedAmount,
    variance,
  });
  // A clean day needs no alert; a gap goes to the office AND the collector,
  // so nobody first hears about a shortage weeks later in a report.
  if (variance !== 0) {
    notifyOffice({
      type: 'reconciliation.variance',
      title: variance < 0 ? 'Cash shortage recorded' : 'Cash overage recorded',
      body:
        `${record.accraDay}: ${formatGhs(Math.abs(variance))} ${variance < 0 ? 'short' : 'over'} ` +
        `against an expected ${formatGhs(expected.total)}.`,
      data: {
        entity: 'reconciliation',
        reconciliationId: result.id,
        accraDay: record.accraDay,
        variance,
      },
      alsoNotify: [record.collectorId],
    });
  }
  return result;
}

// ---------------------------------------------------------------- reads

export interface ReconciliationList {
  items: PublicReconciliation[];
  page: number;
  limit: number;
  total: number;
}

async function withCollectorNames(rows: Reconciliation[]): Promise<PublicReconciliation[]> {
  const ids = [...new Set(rows.map((r) => r.collectorId.toHexString()))];
  const users = await UserModel.find({ _id: { $in: ids } }, { name: 1, role: 1 });
  const who = new Map(users.map((u) => [u._id.toHexString(), u]));
  return rows.map((r) => {
    const item = toPublicReconciliation(r);
    const user = who.get(item.collectorId);
    if (!user) return item;
    return { ...item, collectorName: user.name, collectorRole: user.role };
  });
}

export async function listReconciliations(
  actor: AccessTokenPayload,
  query: ListReconciliationsQuery,
): Promise<ReconciliationList> {
  const filter: Record<string, unknown> = {};
  if (actor.role === 'collector') {
    filter.collectorId = new Types.ObjectId(actor.sub);
  } else if (query.collectorId) {
    filter.collectorId = query.collectorId;
  }
  if (query.status) filter.status = query.status;
  if (query.from || query.to) {
    filter.accraDay = {
      ...(query.from ? { $gte: query.from } : {}),
      ...(query.to ? { $lte: query.to } : {}),
    };
  }
  if (query.varianceOnly === true) filter.variance = { $ne: 0, $exists: true };

  const [rows, total] = await Promise.all([
    ReconciliationModel.find(filter)
      .sort({ accraDay: -1, createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    ReconciliationModel.countDocuments(filter),
  ]);
  return {
    items: await withCollectorNames(rows),
    page: query.page,
    limit: query.limit,
    total,
  };
}

export async function getReconciliation(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
): Promise<PublicReconciliation> {
  const record = await ReconciliationModel.findById(id);
  if (!record) throw new AppError('NOT_FOUND', 'Reconciliation not found', 404);
  if (actor.role === 'collector' && !record.collectorId.equals(actor.sub)) {
    throw new AppError('FORBIDDEN', 'That is not your reconciliation', 403);
  }
  const [item] = await withCollectorNames([record]);
  if (!item) throw new AppError('NOT_FOUND', 'Reconciliation not found', 404);
  return item;
}

// ---------------------------------------------------------------- variance report

export interface VarianceRow {
  collectorId: string;
  collectorName: string;
  days: number;
  daysWithVariance: number;
  totalExpected: number;
  totalReceived: number;
  /** Net across the period: negative = short overall. */
  netVariance: number;
  /** Sum of the shortfalls alone, ignoring days that came in over. */
  totalShort: number;
  totalOver: number;
}

export interface VarianceReport {
  period: { from: string | null; to: string | null };
  rows: VarianceRow[];
  totals: { netVariance: number; totalShort: number; totalOver: number; daysWithVariance: number };
}

/**
 * Who is short, how often, and by how much. Shortfalls and overages are kept
 * apart as well as netted: a collector who is short GHS 50 one day and over
 * GHS 50 the next is not the same as one who always balances.
 */
export async function varianceReport(query: VarianceReportQuery): Promise<VarianceReport> {
  const filter: Record<string, unknown> = { status: 'reconciled' };
  if (query.collectorId) filter.collectorId = query.collectorId;
  if (query.from || query.to) {
    filter.accraDay = {
      ...(query.from ? { $gte: query.from } : {}),
      ...(query.to ? { $lte: query.to } : {}),
    };
  }

  const rows = await ReconciliationModel.find(filter);
  const byCollector = new Map<string, VarianceRow>();
  for (const r of rows) {
    const key = r.collectorId.toHexString();
    const row = byCollector.get(key) ?? {
      collectorId: key,
      collectorName: '',
      days: 0,
      daysWithVariance: 0,
      totalExpected: 0,
      totalReceived: 0,
      netVariance: 0,
      totalShort: 0,
      totalOver: 0,
    };
    const variance = r.variance ?? 0;
    row.days += 1;
    if (variance !== 0) row.daysWithVariance += 1;
    row.totalExpected += r.expectedAmount;
    row.totalReceived += r.receivedAmount ?? 0;
    row.netVariance += variance;
    if (variance < 0) row.totalShort += -variance;
    if (variance > 0) row.totalOver += variance;
    byCollector.set(key, row);
  }

  const users = await UserModel.find({ _id: { $in: [...byCollector.keys()] } }, { name: 1 });
  for (const u of users) {
    const row = byCollector.get(u._id.toHexString());
    if (row) row.collectorName = u.name;
  }

  const result = [...byCollector.values()].sort((a, b) => a.netVariance - b.netVariance);
  return {
    period: { from: query.from ?? null, to: query.to ?? null },
    rows: result,
    totals: {
      netVariance: result.reduce((sum, r) => sum + r.netVariance, 0),
      totalShort: result.reduce((sum, r) => sum + r.totalShort, 0),
      totalOver: result.reduce((sum, r) => sum + r.totalOver, 0),
      daysWithVariance: result.reduce((sum, r) => sum + r.daysWithVariance, 0),
    },
  };
}

export function toVarianceExportRow(row: VarianceRow): Record<string, unknown> {
  return {
    collectorId: row.collectorId,
    collectorName: row.collectorName,
    days: row.days,
    daysWithVariance: row.daysWithVariance,
    totalExpected: row.totalExpected,
    totalReceived: row.totalReceived,
    netVariance: row.netVariance,
    totalShort: row.totalShort,
    totalOver: row.totalOver,
  };
}

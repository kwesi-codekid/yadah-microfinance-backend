import type { PipelineStage } from 'mongoose';
import { directionOf, type TxnDirection, type TxnType } from '../../domain/transactions.js';
import { ReconciliationModel, SusuDepositModel } from '../../models/index.js';
import { buildFeedUnion } from '../reports/transactions.service.js';
import type { SeriesQuery } from './dashboard.schemas.js';

/**
 * Time-bucketed cash movement — the shape the dashboard charts read.
 *
 * Ghana is UTC+0 year-round, so an Accra day and a UTC day are the same and
 * bucket keys come straight off `createdAt` with no timezone argument (see
 * lib/time.ts).
 *
 * Empty buckets are returned as zeroes rather than omitted: a line chart that
 * skips an empty month draws a slope between the months either side of it,
 * which reads as activity that never happened.
 */

export type Bucket = 'day' | 'week' | 'month';

interface CountAmount {
  count: number;
  amount: number;
}

export interface SeriesPoint {
  /** '2026-08-27' (day), '2026-W35' (ISO week), or '2026-08' (month). */
  key: string;
  /** Cash received from customers in the bucket. Internal transfers excluded. */
  cashIn: CountAmount;
  /** Cash handed to customers in the bucket. */
  cashOut: CountAmount;
  /** Transfer legs — money moved between a customer's own products. */
  internalMoves: CountAmount;
  /**
   * Field cash for the bucket, from reconciled collector days only. `expected`
   * is what the system recorded collectors taking in; `received` is what the
   * office confirmed was turned in. Both stay 0 until a day is reconciled, so
   * the most recent buckets legitimately read as zero.
   */
  expected: number;
  received: number;
}

export interface CashSeries {
  from: string;
  to: string;
  bucket: Bucket;
  points: SeriesPoint[];
  totals: {
    cashIn: CountAmount;
    cashOut: CountAmount;
    internalMoves: CountAmount;
    expected: number;
    received: number;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO-8601 week key, e.g. '2026-W35'. Weeks start Monday. */
export function isoWeekKey(date: Date): string {
  // Shift to the Thursday of the same ISO week: the year that Thursday falls in
  // is the ISO week-numbering year, which is not always the calendar year.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${String(isoYear)}-W${String(week).padStart(2, '0')}`;
}

/** Bucket key for a date. */
export function bucketKeyOf(date: Date, bucket: Bucket): string {
  if (bucket === 'day') return date.toISOString().slice(0, 10);
  if (bucket === 'month') return date.toISOString().slice(0, 7);
  return isoWeekKey(date);
}

/** Bucket key for an Accra day string, e.g. '2026-08-27'. */
export function bucketKeyOfDay(accraDay: string, bucket: Bucket): string {
  if (bucket === 'day') return accraDay;
  if (bucket === 'month') return accraDay.slice(0, 7);
  return isoWeekKey(new Date(`${accraDay}T00:00:00.000Z`));
}

/** Every bucket key between two Accra days, inclusive, in order. */
export function bucketKeysBetween(from: string, to: string, bucket: Bucket): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  for (let t = new Date(`${from}T00:00:00.000Z`).getTime(); t <= end; t += DAY_MS) {
    const key = bucketKeyOf(new Date(t), bucket);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/** Mongo expression producing the bucket key from the row's createdAt. */
function keyExpression(bucket: Bucket): Record<string, unknown> {
  const format = bucket === 'day' ? '%Y-%m-%d' : bucket === 'month' ? '%Y-%m' : '%G-W%V';
  // %G/%V are the ISO week-numbering year and week, matching isoWeekKey above.
  return { $dateToString: { format, date: '$createdAt' } };
}

interface SeriesGroup {
  _id: { key: string; type: TxnType; channel: string | null; detail: string | null };
  count: number;
  amount: number;
}

interface ReconGroup {
  _id: string;
  expected: number;
  received: number;
}

const zero = (): CountAmount => ({ count: 0, amount: 0 });

const DIRECTION_FIELD: Record<TxnDirection, 'cashIn' | 'cashOut' | 'internalMoves'> = {
  in: 'cashIn',
  out: 'cashOut',
  internal: 'internalMoves',
};

export async function cashSeries(query: SeriesQuery): Promise<CashSeries> {
  const { from, to, bucket } = query;
  const window = {
    start: new Date(`${from}T00:00:00.000Z`),
    end: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY_MS),
  };

  const groupStage: PipelineStage.Group = {
    $group: {
      _id: {
        key: keyExpression(bucket),
        type: '$type',
        channel: '$channel',
        detail: '$detail',
      },
      count: { $sum: 1 },
      amount: { $sum: '$amount' },
    },
  };

  const [txnGroups, reconRows] = await Promise.all([
    SusuDepositModel.aggregate<SeriesGroup>([...buildFeedUnion(window), groupStage]),
    // One row per collector per day — small enough to bucket in JS, which
    // avoids parsing the stored accraDay string back into a date in Mongo.
    // Only reconciled days count: a declared-but-unconfirmed day has no
    // received figure yet and would read as a total shortfall.
    ReconciliationModel.aggregate<ReconGroup>([
      { $match: { status: 'reconciled', accraDay: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: '$accraDay',
          expected: { $sum: '$expectedAmount' },
          received: { $sum: { $ifNull: ['$receivedAmount', 0] } },
        },
      },
    ]),
  ]);

  const points = new Map<string, SeriesPoint>();
  for (const key of bucketKeysBetween(from, to, bucket)) {
    points.set(key, {
      key,
      cashIn: zero(),
      cashOut: zero(),
      internalMoves: zero(),
      expected: 0,
      received: 0,
    });
  }

  for (const g of txnGroups) {
    const point = points.get(g._id.key);
    if (!point) continue; // a bucket edge outside the requested range
    const field = DIRECTION_FIELD[directionOf(g._id.type, g._id.channel, g._id.detail)];
    point[field].count += g.count;
    point[field].amount += g.amount;
  }
  for (const row of reconRows) {
    const point = points.get(bucketKeyOfDay(row._id, bucket));
    if (!point) continue;
    point.expected += row.expected;
    point.received += row.received;
  }

  const ordered = [...points.values()];
  const totals = {
    cashIn: zero(),
    cashOut: zero(),
    internalMoves: zero(),
    expected: 0,
    received: 0,
  };
  for (const p of ordered) {
    for (const field of ['cashIn', 'cashOut', 'internalMoves'] as const) {
      totals[field].count += p[field].count;
      totals[field].amount += p[field].amount;
    }
    totals.expected += p.expected;
    totals.received += p.received;
  }

  return { from, to, bucket, points: ordered, totals };
}

/**
 * Cash-handover accuracy over a range: of the field cash the system recorded
 * collectors taking in, how much the office confirmed receiving.
 *
 * This measures whether money reached the office — NOT whether customers paid
 * what they owed. Loans and hire purchase are collected at the office and
 * never appear here (see the reconciliation module).
 */
export interface CollectionEfficiency {
  from: string;
  to: string;
  expected: number;
  received: number;
  /** received/expected as a percentage, one decimal. Null when nothing was due. */
  percent: number | null;
  /** Negative means collectors were short overall. */
  netVariance: number;
  daysReconciled: number;
  daysWithVariance: number;
}

export async function collectionEfficiency(
  from: string,
  to: string,
): Promise<CollectionEfficiency> {
  const [row] = await ReconciliationModel.aggregate<{
    expected: number;
    received: number;
    days: number;
    daysWithVariance: number;
  }>([
    { $match: { status: 'reconciled', accraDay: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: null,
        expected: { $sum: '$expectedAmount' },
        received: { $sum: { $ifNull: ['$receivedAmount', 0] } },
        days: { $sum: 1 },
        daysWithVariance: {
          $sum: { $cond: [{ $ne: [{ $ifNull: ['$variance', 0] }, 0] }, 1, 0] },
        },
      },
    },
  ]);

  const expected = row?.expected ?? 0;
  const received = row?.received ?? 0;
  return {
    from,
    to,
    expected,
    received,
    percent: expected === 0 ? null : Math.round((received / expected) * 1000) / 10,
    netVariance: received - expected,
    daysReconciled: row?.days ?? 0,
    daysWithVariance: row?.daysWithVariance ?? 0,
  };
}

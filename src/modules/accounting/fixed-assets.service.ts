import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { accraDay } from '../../lib/time.js';
import { CapitalEntryModel, FixedAssetModel, type FixedAsset } from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import { depreciationAt, depreciationForPeriod } from '../../domain/depreciation.js';
import { getAccountOrThrow } from './cash.service.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type {
  CreateCapitalEntryBody,
  CreateFixedAssetBody,
  DisposeFixedAssetBody,
  ListCapitalQuery,
  ListFixedAssetsQuery,
} from './accounting.schemas.js';

/**
 * The fixed-asset register, and the depreciation computed from it.
 *
 * Nothing here posts a monthly journal — depreciation is a function of cost,
 * salvage value, useful life and elapsed months (see domain/depreciation.ts),
 * so the figure for any date is derivable and there is no scheduled run to
 * miss or backfill.
 */

export interface PublicFixedAsset {
  id: string;
  name: string;
  category: string;
  cost: number;
  acquiredOn: string;
  usefulLifeMonths: number;
  salvageValue: number;
  status: string;
  cashAccountId?: string;
  serialNumber?: string;
  assignedToId?: string;
  disposedOn?: string;
  disposalProceeds?: number;
  /** Position on the requested date — the numbers the balance sheet uses. */
  depreciation: {
    monthlyCharge: number;
    monthsDepreciated: number;
    accumulated: number;
    netBookValue: number;
    fullyDepreciated: boolean;
  };
}

export function toPublicAsset(a: FixedAsset, asOf: Date): PublicFixedAsset {
  const state = depreciationAt(a, asOf);
  return {
    id: a._id.toHexString(),
    name: a.name,
    category: a.category,
    cost: a.cost,
    acquiredOn: a.acquiredOn,
    usefulLifeMonths: a.usefulLifeMonths,
    salvageValue: a.salvageValue,
    status: a.status,
    ...(a.cashAccountId !== undefined ? { cashAccountId: a.cashAccountId.toHexString() } : {}),
    ...(a.serialNumber !== undefined ? { serialNumber: a.serialNumber } : {}),
    ...(a.assignedToId !== undefined ? { assignedToId: a.assignedToId.toHexString() } : {}),
    ...(a.disposedOn !== undefined ? { disposedOn: a.disposedOn } : {}),
    ...(a.disposalProceeds !== undefined ? { disposalProceeds: a.disposalProceeds } : {}),
    depreciation: {
      monthlyCharge: state.monthlyCharge,
      monthsDepreciated: state.monthsDepreciated,
      accumulated: state.accumulated,
      netBookValue: state.netBookValue,
      fullyDepreciated: state.fullyDepreciated,
    },
  };
}

export async function registerAsset(
  actor: AccessTokenPayload,
  body: CreateFixedAssetBody,
  requestId?: string,
): Promise<PublicFixedAsset> {
  if (body.salvageValue >= body.cost) {
    throw new AppError(
      'SALVAGE_TOO_HIGH',
      'Salvage value must be less than cost, or there is nothing to depreciate',
      422,
    );
  }
  if (body.cashAccountId) await getAccountOrThrow(body.cashAccountId);

  const asset = await FixedAssetModel.create({
    name: body.name,
    category: body.category,
    cost: body.cost,
    acquiredOn: body.acquiredOn,
    usefulLifeMonths: body.usefulLifeMonths,
    salvageValue: body.salvageValue,
    ...(body.cashAccountId !== undefined ? { cashAccountId: body.cashAccountId } : {}),
    ...(body.serialNumber !== undefined ? { serialNumber: body.serialNumber } : {}),
    ...(body.assignedToId !== undefined ? { assignedToId: body.assignedToId } : {}),
    createdById: new Types.ObjectId(actor.sub),
  });

  await audit({
    actorId: actor.sub,
    action: 'fixed-asset.register',
    entityType: 'fixed-asset',
    entityId: asset._id,
    amountAfter: body.cost,
    after: { name: body.name, cost: body.cost, usefulLifeMonths: body.usefulLifeMonths },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicAsset(asset, new Date());
}

export async function disposeAsset(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  body: DisposeFixedAssetBody,
  requestId?: string,
): Promise<PublicFixedAsset> {
  const asset = await FixedAssetModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!asset) throw new AppError('NOT_FOUND', 'Asset not found', 404);
  if (asset.status === 'disposed') {
    throw new AppError('ALREADY_DISPOSED', 'This asset has already been disposed of', 409);
  }
  if (body.cashAccountId) await getAccountOrThrow(body.cashAccountId);

  const disposedOn = body.disposedOn ?? accraDay();
  if (disposedOn < asset.acquiredOn) {
    throw new AppError(
      'BEFORE_ACQUISITION',
      'An asset cannot be disposed of before it was bought',
      422,
    );
  }

  asset.status = 'disposed';
  asset.disposedOn = disposedOn;
  asset.disposalProceeds = body.disposalProceeds;
  if (body.cashAccountId) asset.cashAccountId = body.cashAccountId;
  if (body.note !== undefined) asset.disposalNote = body.note;
  await asset.save();

  await audit({
    actorId: actor.sub,
    action: 'fixed-asset.dispose',
    entityType: 'fixed-asset',
    entityId: asset._id,
    amountAfter: body.disposalProceeds,
    after: { disposedOn, disposalProceeds: body.disposalProceeds },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicAsset(asset, new Date(`${disposedOn}T00:00:00.000Z`));
}

export async function listAssets(query: ListFixedAssetsQuery): Promise<{
  items: PublicFixedAsset[];
  page: number;
  limit: number;
  total: number;
  totals: { cost: number; accumulatedDepreciation: number; netBookValue: number };
}> {
  const asOfDate = new Date(`${query.asOf ?? accraDay()}T00:00:00.000Z`);
  const filter: Record<string, unknown> = { ...NOT_TRASHED };
  if (query.category) filter.category = query.category;
  if (query.status) filter.status = query.status;

  const [rows, total] = await Promise.all([
    FixedAssetModel.find(filter)
      .sort({ acquiredOn: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    FixedAssetModel.countDocuments(filter),
  ]);

  const items = rows.map((a) => toPublicAsset(a, asOfDate));
  return {
    items,
    page: query.page,
    limit: query.limit,
    total,
    totals: {
      cost: items.reduce((sum, a) => sum + a.cost, 0),
      accumulatedDepreciation: items.reduce((sum, a) => sum + a.depreciation.accumulated, 0),
      netBookValue: items.reduce((sum, a) => sum + a.depreciation.netBookValue, 0),
    },
  };
}

export interface AssetPosition {
  cost: number;
  accumulatedDepreciation: number;
  netBookValue: number;
  count: number;
}

/**
 * The fixed-asset line on the balance sheet.
 *
 * Assets disposed of on or before the date drop out entirely — they are no
 * longer owned, so neither their cost nor their accumulated depreciation
 * belongs on the sheet. Assets bought after the date have not happened yet.
 */
export async function assetPositionAt(asOf: string): Promise<AssetPosition> {
  const asOfDate = new Date(`${asOf}T00:00:00.000Z`);
  const assets = await FixedAssetModel.find({
    acquiredOn: { $lte: asOf },
    $or: [{ status: 'active' }, { disposedOn: { $gt: asOf } }],
    ...NOT_TRASHED,
  });

  let cost = 0;
  let accumulated = 0;
  for (const a of assets) {
    cost += a.cost;
    accumulated += depreciationAt(a, asOfDate).accumulated;
  }
  return {
    cost,
    accumulatedDepreciation: accumulated,
    netBookValue: cost - accumulated,
    count: assets.length,
  };
}

/** Depreciation charged in a period — the expense line for profit and loss. */
export async function depreciationExpense(from: string, to: string): Promise<number> {
  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T00:00:00.000Z`);
  // Anything acquired before the period end can have charged into it, including
  // assets disposed of during the period — they depreciated while still owned.
  const assets = await FixedAssetModel.find({ acquiredOn: { $lte: to }, ...NOT_TRASHED });
  return assets.reduce((sum, a) => sum + depreciationForPeriod(a, fromDate, toDate), 0);
}

// ---------------------------------------------------------------- capital

export interface PublicCapitalEntry {
  id: string;
  kind: string;
  amount: number;
  occurredOn: string;
  cashAccountId?: string;
  note?: string;
  createdAt: Date;
}

function toPublicCapital(c: {
  _id: Types.ObjectId;
  kind: string;
  amount: number;
  occurredOn: string;
  cashAccountId?: Types.ObjectId;
  note?: string;
  createdAt: Date;
}): PublicCapitalEntry {
  return {
    id: c._id.toHexString(),
    kind: c.kind,
    amount: c.amount,
    occurredOn: c.occurredOn,
    ...(c.cashAccountId !== undefined ? { cashAccountId: c.cashAccountId.toHexString() } : {}),
    ...(c.note !== undefined ? { note: c.note } : {}),
    createdAt: c.createdAt,
  };
}

export async function recordCapital(
  actor: AccessTokenPayload,
  body: CreateCapitalEntryBody,
  requestId?: string,
): Promise<PublicCapitalEntry> {
  if (body.cashAccountId) await getAccountOrThrow(body.cashAccountId);

  const entry = await CapitalEntryModel.create({
    kind: body.kind,
    amount: body.amount,
    occurredOn: body.occurredOn,
    ...(body.cashAccountId !== undefined ? { cashAccountId: body.cashAccountId } : {}),
    ...(body.note !== undefined ? { note: body.note } : {}),
    recordedById: new Types.ObjectId(actor.sub),
  });

  await audit({
    actorId: actor.sub,
    action: `capital.${body.kind}`,
    entityType: 'capital-entry',
    entityId: entry._id,
    amountAfter: body.amount,
    after: { kind: body.kind, amount: body.amount, occurredOn: body.occurredOn },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicCapital(entry);
}

export async function listCapital(query: ListCapitalQuery): Promise<{
  items: PublicCapitalEntry[];
  page: number;
  limit: number;
  total: number;
}> {
  const filter: Record<string, unknown> = { ...NOT_TRASHED };
  if (query.kind) filter.kind = query.kind;
  if (query.from || query.to) {
    filter.occurredOn = {
      ...(query.from ? { $gte: query.from } : {}),
      ...(query.to ? { $lte: query.to } : {}),
    };
  }

  const [rows, total] = await Promise.all([
    CapitalEntryModel.find(filter)
      .sort({ occurredOn: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    CapitalEntryModel.countDocuments(filter),
  ]);
  return { items: rows.map(toPublicCapital), page: query.page, limit: query.limit, total };
}

/** Net owner's capital as at a date: contributions less drawings. */
export async function capitalAt(asOf: string): Promise<{
  contributions: number;
  drawings: number;
  net: number;
}> {
  const rows = await CapitalEntryModel.aggregate<{ _id: string; amount: number }>([
    { $match: { occurredOn: { $lte: asOf }, ...NOT_TRASHED } },
    { $group: { _id: '$kind', amount: { $sum: '$amount' } } },
  ]);
  const byKind = new Map(rows.map((r) => [r._id, r.amount]));
  const contributions = byKind.get('contribution') ?? 0;
  const drawings = byKind.get('drawing') ?? 0;
  return { contributions, drawings, net: contributions - drawings };
}

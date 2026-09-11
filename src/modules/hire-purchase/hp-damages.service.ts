import mongoose, { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { escapeRegex } from '../../lib/fuzzy.js';
import { formatGhs } from '../../lib/money.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { accraDay, createdAtFilter } from '../../lib/time.js';
import {
  HpDamageModel,
  HpItemModel,
  UserModel,
  type DamageCause,
  type DamageStatus,
  type HpDamage,
} from '../../models/index.js';
import { NOT_TRASHED, requireDeletedAt } from '../../models/shared.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type {
  ListDamagesQuery,
  RejectDamageBody,
  ReportDamageBody,
  UpdateDamageBody,
} from './hp.schemas.js';

/**
 * Stock written off because it can no longer be sold.
 *
 * Two rules shape everything here. The first is that the counter reports and
 * the office decides: a teller who breaks something can say so immediately,
 * but nothing leaves the shelf until someone with authority approves it, and
 * the person who reported a loss may never be the person who books it. "Mark
 * it damaged" is the easiest way to walk goods out of a shop, and a single
 * pair of eyes on that is not enough.
 *
 * The second is that the cost is struck at approval and never recomputed.
 * Prices are editable; a loss that re-priced itself whenever somebody edited
 * the shelf would silently restate months that were already closed.
 */

export interface PublicDamage {
  id: string;
  itemId: string;
  itemName: string;
  quantity: number;
  cause: DamageCause;
  description: string;
  occurredOn: string;
  status: DamageStatus;
  /** Pesewas, set at approval. Absent while pending, and on a rejection. */
  costValue?: number;
  unitCost?: number;
  photoUrls: string[];
  reportedById: string;
  reportedByName?: string;
  reviewedById?: string;
  reviewedByName?: string;
  reviewedAt?: Date;
  rejectionReason?: string;
  createdAt: Date;
}

export function toPublicDamage(d: HpDamage, names?: Map<string, string>): PublicDamage {
  const reportedById = d.reportedById.toHexString();
  const reviewedById = d.reviewedById?.toHexString();
  const reportedByName = names?.get(reportedById);
  const reviewedByName = reviewedById === undefined ? undefined : names?.get(reviewedById);
  return {
    id: d._id.toHexString(),
    itemId: d.itemId.toHexString(),
    itemName: d.itemName,
    quantity: d.quantity,
    cause: d.cause,
    description: d.description,
    occurredOn: d.occurredOn,
    status: d.status,
    ...(d.costValue !== undefined ? { costValue: d.costValue } : {}),
    ...(d.unitCost !== undefined ? { unitCost: d.unitCost } : {}),
    photoUrls: d.photoUrls,
    reportedById,
    ...(reportedByName !== undefined ? { reportedByName } : {}),
    ...(reviewedById !== undefined ? { reviewedById } : {}),
    ...(reviewedByName !== undefined ? { reviewedByName } : {}),
    ...(d.reviewedAt !== undefined ? { reviewedAt: d.reviewedAt } : {}),
    ...(d.rejectionReason !== undefined ? { rejectionReason: d.rejectionReason } : {}),
    createdAt: d.createdAt,
  };
}

export function toDamageExportRow(item: PublicDamage): Record<string, unknown> {
  return {
    id: item.id,
    occurredOn: item.occurredOn,
    itemName: item.itemName,
    quantity: item.quantity,
    cause: item.cause,
    description: item.description,
    status: item.status,
    unitCost: item.unitCost ?? '',
    costValue: item.costValue ?? '',
    reportedBy: item.reportedByName ?? '',
    reviewedBy: item.reviewedByName ?? '',
    rejectionReason: item.rejectionReason ?? '',
    reportedAt: item.createdAt,
  };
}

async function staffNames(rows: HpDamage[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      rows.flatMap((r) => [
        r.reportedById.toHexString(),
        ...(r.reviewedById ? [r.reviewedById.toHexString()] : []),
      ]),
    ),
  ];
  if (ids.length === 0) return new Map();
  const users = await UserModel.find({ _id: { $in: ids } }, { name: 1 });
  return new Map(users.map((u) => [u._id.toHexString(), u.name]));
}

// ---------------------------------------------------------------- reporting

/**
 * Report damaged stock. Writes nothing off — the shelf is untouched until the
 * office approves, so a mistaken report costs nothing but a rejection.
 */
export async function reportDamage(
  actor: AccessTokenPayload,
  body: ReportDamageBody,
  requestId?: string,
): Promise<PublicDamage> {
  const item = await HpItemModel.findOne({ _id: body.itemId, ...NOT_TRASHED });
  if (!item) throw new AppError('NOT_FOUND', 'Item not found', 404);

  const occurredOn = body.occurredOn ?? accraDay();
  if (occurredOn > accraDay()) {
    throw new AppError('FUTURE_DATE', 'A damage cannot have happened tomorrow', 422);
  }
  // Checked again at approval against the live count; this is only so an
  // obviously impossible report is refused while the reporter is still there.
  if (body.quantity > item.quantityInStock) {
    throw new AppError(
      'OUT_OF_STOCK',
      `Only ${String(item.quantityInStock)} of ${item.name} are on the shelf`,
      422,
      { quantityInStock: item.quantityInStock },
    );
  }

  const damage = await HpDamageModel.create({
    itemId: item._id,
    itemName: item.name,
    quantity: body.quantity,
    cause: body.cause,
    description: body.description,
    occurredOn,
    photoUrls: body.photoUrls ?? [],
    reportedById: new Types.ObjectId(actor.sub),
  });

  await audit({
    actorId: actor.sub,
    action: 'hp.damage.report',
    entityType: 'hp-damage',
    entityId: damage._id,
    after: {
      itemId: item._id.toHexString(),
      itemName: item.name,
      quantity: body.quantity,
      cause: body.cause,
      occurredOn,
    },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  emitAdminEvent('hp.damage.reported', {
    id: damage._id.toHexString(),
    itemName: item.name,
    quantity: body.quantity,
    cause: body.cause,
  });

  return toPublicDamage(damage);
}

/** Correct a report that has not been decided yet. */
export async function updateDamage(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  patch: UpdateDamageBody,
  requestId?: string,
): Promise<PublicDamage> {
  const damage = await HpDamageModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!damage) throw new AppError('NOT_FOUND', 'Damage report not found', 404);
  if (damage.status !== 'pending') {
    throw new AppError(
      'ALREADY_REVIEWED',
      `This report was already ${damage.status} — it can no longer be changed`,
      409,
    );
  }

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of ['quantity', 'cause', 'description', 'occurredOn'] as const) {
    const next = patch[key];
    if (next !== undefined && next !== damage[key]) {
      before[key] = damage[key];
      after[key] = next;
      (damage as Record<typeof key, unknown>)[key] = next;
    }
  }
  if (patch.photoUrls !== undefined) {
    before.photoUrls = damage.photoUrls;
    after.photoUrls = patch.photoUrls;
    damage.photoUrls = patch.photoUrls;
  }
  await damage.save();

  if (Object.keys(after).length > 0) {
    await audit({
      actorId: actor.sub,
      action: 'hp.damage.update',
      entityType: 'hp-damage',
      entityId: damage._id,
      before,
      after,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }
  return toPublicDamage(damage);
}

// ---------------------------------------------------------------- deciding

/**
 * Approve a report: take the quantity off the shelf and strike the loss.
 *
 * The stock move and the valuation happen together, in one transaction, at
 * one moment — the cost is read from the item inside the transaction so the
 * figure on the record is the one the shelf actually carried when the goods
 * left it.
 */
export async function approveDamage(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  requestId?: string,
): Promise<PublicDamage> {
  const pre = await HpDamageModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!pre) throw new AppError('NOT_FOUND', 'Damage report not found', 404);
  if (pre.status !== 'pending') {
    throw new AppError('ALREADY_REVIEWED', `This report was already ${pre.status}`, 409);
  }
  // Separation of duties: reporting a loss and booking it are two jobs, and
  // one person doing both is the whole shape of stock walking out of a shop.
  if (pre.reportedById.toHexString() === actor.sub) {
    throw new AppError(
      'SELF_APPROVAL',
      'You reported this damage — someone else in the office has to approve it',
      403,
    );
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const item = await HpItemModel.findOne({ _id: pre.itemId, ...NOT_TRASHED }).session(session);
      if (!item) throw new AppError('NOT_FOUND', 'Item not found', 404);
      if (item.quantityInStock < pre.quantity) {
        throw new AppError(
          'OUT_OF_STOCK',
          `Only ${String(item.quantityInStock)} of ${item.name} are on the shelf — ` +
            'reject this report and record the real quantity',
          422,
          { quantityInStock: item.quantityInStock, quantity: pre.quantity },
        );
      }

      const unitCost = item.costPrice;
      const costValue = unitCost * pre.quantity;

      const stockUpd = await HpItemModel.updateOne(
        { _id: item._id, quantityInStock: { $gte: pre.quantity }, ...NOT_TRASHED },
        { $inc: { quantityInStock: -pre.quantity } },
        { session },
      );
      if (stockUpd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Stock changed concurrently — retry', 409);
      }

      const upd = await HpDamageModel.updateOne(
        { _id: id, status: 'pending' },
        {
          $set: {
            status: 'approved',
            costValue,
            unitCost,
            reviewedById: new Types.ObjectId(actor.sub),
            reviewedAt: new Date(),
          },
        },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Report changed concurrently — retry', 409);
      }

      await audit(
        {
          actorId: actor.sub,
          action: 'hp.damage.approve',
          entityType: 'hp-damage',
          entityId: id,
          amountBefore: 0,
          amountAfter: costValue,
          before: { status: 'pending', quantityInStock: item.quantityInStock },
          after: {
            status: 'approved',
            quantityInStock: item.quantityInStock - pre.quantity,
            unitCost,
            costValue,
          },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const after = await HpDamageModel.findById(id);
  if (!after) throw new AppError('NOT_FOUND', 'Damage report not found', 404);
  emitAdminEvent('hp.damage.approved', {
    id: id.toHexString(),
    itemName: after.itemName,
    quantity: after.quantity,
    costValue: after.costValue ?? 0,
  });
  return toPublicDamage(after);
}

/** Refuse a report. The shelf is untouched — it never moved in the first place. */
export async function rejectDamage(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  body: RejectDamageBody,
  requestId?: string,
): Promise<PublicDamage> {
  const damage = await HpDamageModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!damage) throw new AppError('NOT_FOUND', 'Damage report not found', 404);
  if (damage.status !== 'pending') {
    throw new AppError('ALREADY_REVIEWED', `This report was already ${damage.status}`, 409);
  }

  damage.status = 'rejected';
  damage.rejectionReason = body.reason;
  damage.reviewedById = new Types.ObjectId(actor.sub);
  damage.reviewedAt = new Date();
  await damage.save();

  await audit({
    actorId: actor.sub,
    action: 'hp.damage.reject',
    entityType: 'hp-damage',
    entityId: id,
    before: { status: 'pending' },
    after: { status: 'rejected', reason: body.reason },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicDamage(damage);
}

// ---------------------------------------------------------------- reading

export interface DamageList {
  items: PublicDamage[];
  page: number;
  limit: number;
  total: number;
  /** Cost of the APPROVED reports matching the filters. Pending ones are not losses yet. */
  totalCostValue: number;
  pendingCount: number;
}

export async function listDamages(query: ListDamagesQuery): Promise<DamageList> {
  const filter: Record<string, unknown> = { ...NOT_TRASHED };
  if (query.status) filter.status = query.status;
  if (query.cause) filter.cause = query.cause;
  if (query.itemId) filter.itemId = query.itemId;
  if (query.from !== undefined || query.to !== undefined) {
    filter.occurredOn = {
      ...(query.from !== undefined ? { $gte: query.from } : {}),
      ...(query.to !== undefined ? { $lte: query.to } : {}),
    };
  }
  if (query.search !== undefined) {
    const rx = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [{ itemName: rx }, { description: rx }];
  }

  const [rows, total, totals, pendingCount] = await Promise.all([
    HpDamageModel.find(filter)
      .sort({ occurredOn: -1, createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    HpDamageModel.countDocuments(filter),
    HpDamageModel.aggregate<{ _id: null; value: number }>([
      { $match: { ...filter, status: 'approved' } },
      { $group: { _id: null, value: { $sum: '$costValue' } } },
    ]),
    HpDamageModel.countDocuments({ ...filter, status: 'pending' }),
  ]);

  const names = await staffNames(rows);
  return {
    items: rows.map((r) => toPublicDamage(r, names)),
    page: query.page,
    limit: query.limit,
    total,
    totalCostValue: totals[0]?.value ?? 0,
    pendingCount,
  };
}

export async function getDamage(id: Types.ObjectId): Promise<PublicDamage> {
  const damage = await HpDamageModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!damage) throw new AppError('NOT_FOUND', 'Damage report not found', 404);
  const names = await staffNames([damage]);
  return toPublicDamage(damage, names);
}

/** What the shop lost to damage in a period, by cause. Approved reports only. */
export interface DamageSummary {
  from: string | null;
  to: string | null;
  totalCostValue: number;
  totalQuantity: number;
  byCause: { cause: DamageCause; count: number; quantity: number; costValue: number }[];
}

export async function damageSummary(from?: string, to?: string): Promise<DamageSummary> {
  const occurredOn =
    from !== undefined || to !== undefined
      ? {
          ...(from !== undefined ? { $gte: from } : {}),
          ...(to !== undefined ? { $lte: to } : {}),
        }
      : undefined;
  const rows = await HpDamageModel.aggregate<{
    _id: DamageCause;
    count: number;
    quantity: number;
    costValue: number;
  }>([
    {
      $match: {
        status: 'approved',
        ...(occurredOn ? { occurredOn } : {}),
        ...NOT_TRASHED,
      },
    },
    {
      $group: {
        _id: '$cause',
        count: { $sum: 1 },
        quantity: { $sum: '$quantity' },
        costValue: { $sum: '$costValue' },
      },
    },
    { $sort: { costValue: -1 } },
  ]);

  return {
    from: from ?? null,
    to: to ?? null,
    totalCostValue: rows.reduce((sum, r) => sum + r.costValue, 0),
    totalQuantity: rows.reduce((sum, r) => sum + r.quantity, 0),
    byCause: rows.map((r) => ({
      cause: r._id,
      count: r.count,
      quantity: r.quantity,
      costValue: r.costValue,
    })),
  };
}

// ---------------------------------------------------------------- trash

export interface TrashedDamage extends PublicDamage {
  deletedAt: Date;
  deletedById?: string;
  deleteReason?: string;
}

function toTrashedDamage(d: HpDamage, names?: Map<string, string>): TrashedDamage {
  return {
    ...toPublicDamage(d, names),
    deletedAt: requireDeletedAt(d.deletedAt),
    ...(d.deletedById !== undefined ? { deletedById: d.deletedById.toHexString() } : {}),
    ...(d.deleteReason !== undefined ? { deleteReason: d.deleteReason } : {}),
  };
}

/**
 * Bin a report. Only a pending or rejected one: an approved damage has already
 * moved the shelf and struck a loss, and hiding that row would leave the stock
 * short with nothing to explain it.
 */
export async function trashDamage(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  reason: string | undefined,
  requestId?: string,
): Promise<TrashedDamage> {
  const damage = await HpDamageModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!damage) throw new AppError('NOT_FOUND', 'Damage report not found', 404);
  if (damage.status === 'approved') {
    throw new AppError(
      'CANNOT_TRASH',
      'An approved damage has already been written off — it stays on the record',
      422,
    );
  }

  damage.deletedAt = new Date();
  damage.deletedById = new Types.ObjectId(actor.sub);
  if (reason !== undefined) damage.deleteReason = reason;
  await damage.save();

  await audit({
    actorId: actor.sub,
    action: 'hp.damage.trash',
    entityType: 'hp-damage',
    entityId: id,
    before: { deletedAt: null },
    after: { deletedAt: damage.deletedAt, ...(reason !== undefined ? { reason } : {}) },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toTrashedDamage(damage);
}

export async function restoreDamage(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  requestId?: string,
): Promise<PublicDamage> {
  const damage = await HpDamageModel.findById(id);
  if (!damage) throw new AppError('NOT_FOUND', 'Damage report not found', 404);
  if (!damage.deletedAt) throw new AppError('NOT_TRASHED', 'Report is not in the trash', 409);

  damage.deletedAt = null;
  damage.set('deletedById', undefined);
  damage.set('deleteReason', undefined);
  await damage.save();

  await audit({
    actorId: actor.sub,
    action: 'hp.damage.restore',
    entityType: 'hp-damage',
    entityId: id,
    after: { deletedAt: null },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicDamage(damage);
}

export async function listDamageTrash(query: {
  page: number;
  limit: number;
}): Promise<{ items: TrashedDamage[]; page: number; limit: number; total: number }> {
  const filter = { deletedAt: { $ne: null } };
  const [rows, total] = await Promise.all([
    HpDamageModel.find(filter)
      .sort({ deletedAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    HpDamageModel.countDocuments(filter),
  ]);
  const names = await staffNames(rows);
  return {
    items: rows.map((r) => toTrashedDamage(r, names)),
    page: query.page,
    limit: query.limit,
    total,
  };
}

/** Damage the shop took in a window, for the reports area. */
export async function damagesCharged(from?: string, to?: string): Promise<number> {
  const createdAt = createdAtFilter(from, to);
  const rows = await HpDamageModel.aggregate<{ _id: null; value: number }>([
    {
      $match: {
        status: 'approved',
        ...(createdAt ? { reviewedAt: createdAt } : {}),
        ...NOT_TRASHED,
      },
    },
    { $group: { _id: null, value: { $sum: '$costValue' } } },
  ]);
  return rows[0]?.value ?? 0;
}

/** Human phrasing for an approved write-off, used in notifications. */
export function damageHeadline(d: PublicDamage): string {
  return `${String(d.quantity)} × ${d.itemName} written off (${formatGhs(d.costValue ?? 0)})`;
}

import mongoose, { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { accraDay } from '../../lib/time.js';
import { formatGhs } from '../../lib/money.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import {
  HpItemModel,
  HpPriceChangeModel,
  UserModel,
  type HpItem,
  type HpPriceChange,
  type PriceKind,
} from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import { validatePricing } from '../../domain/hire-purchase.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type { ListPriceChangesQuery, ReceiveStockBody } from './hp.schemas.js';

/**
 * What an item costs and what it sells for, and the record of every time
 * either moved.
 *
 * The shop runs on a single current price per item: that is what the till
 * charges and what stock is valued at. Keeping only the latest number is
 * cheap and everyone understands it, but on its own it hides the thing the
 * office actually needs to see — a delivery invoiced at a new cost quietly
 * revalues every unit already on the shelf, with nothing to point at
 * afterwards. So each move is written down here, with the previous figure
 * beside the new one and, when it arrived with goods, the supplier and invoice
 * that brought it.
 *
 * Receiving stock and repricing are therefore the same act seen twice: the
 * delivery adds quantity, and if the invoice disagrees with the shelf, it
 * moves the price and says so.
 */

export interface PublicPriceChange {
  id: string;
  itemId: string;
  kind: PriceKind;
  previous: number;
  current: number;
  /** current − previous. Negative when the price came down. */
  delta: number;
  reason?: string;
  quantityReceived?: number;
  supplier?: string;
  invoiceRef?: string;
  receivedOn?: string;
  changedById: string;
  changedByName?: string;
  createdAt: Date;
}

export function toPublicPriceChange(
  c: HpPriceChange,
  names?: Map<string, string>,
): PublicPriceChange {
  const changedById = c.changedById.toHexString();
  const changedByName = names?.get(changedById);
  return {
    id: c._id.toHexString(),
    itemId: c.itemId.toHexString(),
    kind: c.kind,
    previous: c.previous,
    current: c.current,
    delta: c.current - c.previous,
    ...(c.reason !== undefined ? { reason: c.reason } : {}),
    ...(c.quantityReceived !== undefined ? { quantityReceived: c.quantityReceived } : {}),
    ...(c.supplier !== undefined ? { supplier: c.supplier } : {}),
    ...(c.invoiceRef !== undefined ? { invoiceRef: c.invoiceRef } : {}),
    ...(c.receivedOn !== undefined ? { receivedOn: c.receivedOn } : {}),
    changedById,
    ...(changedByName !== undefined ? { changedByName } : {}),
    createdAt: c.createdAt,
  };
}

export function toPriceChangeExportRow(item: PublicPriceChange): Record<string, unknown> {
  return {
    date: item.createdAt,
    kind: item.kind,
    previous: item.previous,
    current: item.current,
    delta: item.delta,
    quantityReceived: item.quantityReceived ?? '',
    supplier: item.supplier ?? '',
    invoiceRef: item.invoiceRef ?? '',
    receivedOn: item.receivedOn ?? '',
    reason: item.reason ?? '',
    changedBy: item.changedByName ?? '',
  };
}

/** Context a price move arrived with, when it came in on a delivery. */
export interface PriceChangeContext {
  reason?: string;
  quantityReceived?: number;
  supplier?: string;
  invoiceRef?: string;
  receivedOn?: string;
}

/**
 * Write a row for each price that actually moved.
 *
 * Called from every path that can change a price — the edit drawer, a
 * delivery, the bulk importer — so that no route into the shelf can move a
 * number without leaving a trace. A no-op change writes nothing: a history
 * full of "GHS 500 → GHS 500" is a history nobody reads.
 */
export async function recordPriceChanges(
  actor: AccessTokenPayload,
  itemId: Types.ObjectId,
  moves: { kind: PriceKind; previous: number; current: number }[],
  context: PriceChangeContext = {},
  session?: mongoose.ClientSession,
): Promise<void> {
  const real = moves.filter((m) => m.previous !== m.current);
  if (real.length === 0) return;
  const docs = real.map((m) => ({
    itemId,
    kind: m.kind,
    previous: m.previous,
    current: m.current,
    ...(context.reason !== undefined ? { reason: context.reason } : {}),
    ...(context.quantityReceived !== undefined
      ? { quantityReceived: context.quantityReceived }
      : {}),
    ...(context.supplier !== undefined ? { supplier: context.supplier } : {}),
    ...(context.invoiceRef !== undefined ? { invoiceRef: context.invoiceRef } : {}),
    ...(context.receivedOn !== undefined ? { receivedOn: context.receivedOn } : {}),
    changedById: new Types.ObjectId(actor.sub),
  }));
  // `ordered` is required by Mongoose to create several documents inside a
  // session, and is right anyway: cost before selling, as they were passed.
  await HpPriceChangeModel.create(docs, session ? { session, ordered: true } : { ordered: true });
}

export interface PriceChangeList {
  items: PublicPriceChange[];
  page: number;
  limit: number;
  total: number;
}

export async function listPriceChanges(
  itemId: Types.ObjectId,
  query: ListPriceChangesQuery,
): Promise<PriceChangeList> {
  const filter: Record<string, unknown> = { itemId };
  if (query.kind) filter.kind = query.kind;

  const [rows, total] = await Promise.all([
    HpPriceChangeModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    HpPriceChangeModel.countDocuments(filter),
  ]);
  const names = await changedByNames(rows);
  return {
    items: rows.map((r) => toPublicPriceChange(r, names)),
    page: query.page,
    limit: query.limit,
    total,
  };
}

async function changedByNames(rows: HpPriceChange[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.changedById.toHexString()))];
  if (ids.length === 0) return new Map();
  const users = await UserModel.find({ _id: { $in: ids } }, { name: 1 });
  return new Map(users.map((u) => [u._id.toHexString(), u.name]));
}

export interface ReceiveStockResult {
  item: HpItem;
  /** The moves this delivery caused. Empty when the invoice matched the shelf. */
  changes: PublicPriceChange[];
}

/**
 * Book a delivery: add the quantity, and reconcile the shelf with the invoice.
 *
 * The unit cost is asked for every time rather than assumed, because the
 * invoice is the only place the real figure exists and a delivery is exactly
 * the moment somebody is holding it. When it disagrees with the shelf, the
 * shelf moves and the move is recorded — the alternative, silently keeping the
 * old cost, makes every margin after that delivery a guess.
 */
export async function receiveStock(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  body: ReceiveStockBody,
  requestId?: string,
): Promise<ReceiveStockResult> {
  const item = await HpItemModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!item) throw new AppError('NOT_FOUND', 'Item not found', 404);

  const nextCost = body.unitCost;
  const nextSelling = body.sellingPrice ?? item.sellingPrice;
  // Refuse the delivery rather than accept stock the shop would lose money on.
  // This is the common case for a price rise nobody passed on: the invoice
  // went up, the shelf did not, and the margin is now negative.
  if (nextSelling < nextCost) {
    throw new AppError(
      'INVALID_PRICING',
      `${item.name} sells for ${formatGhs(nextSelling)} but this delivery cost ` +
        `${formatGhs(nextCost)} each — raise the selling price with the delivery`,
      422,
      { costPrice: nextCost, sellingPrice: nextSelling },
    );
  }
  validatePricing(nextCost, nextSelling);

  const receivedOn = body.receivedOn ?? accraDay();
  const previousCost = item.costPrice;
  const previousSelling = item.sellingPrice;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const upd = await HpItemModel.updateOne(
        { _id: id, quantityInStock: item.quantityInStock, ...NOT_TRASHED },
        {
          $inc: { quantityInStock: body.quantity },
          $set: { costPrice: nextCost, sellingPrice: nextSelling },
        },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Stock changed concurrently — retry', 409);
      }
      await recordPriceChanges(
        actor,
        id,
        [
          { kind: 'cost', previous: previousCost, current: nextCost },
          { kind: 'selling', previous: previousSelling, current: nextSelling },
        ],
        {
          quantityReceived: body.quantity,
          receivedOn,
          ...(body.supplier !== undefined ? { supplier: body.supplier } : {}),
          ...(body.invoiceRef !== undefined ? { invoiceRef: body.invoiceRef } : {}),
          ...(body.note !== undefined ? { reason: body.note } : {}),
        },
        session,
      );
      await audit(
        {
          actorId: actor.sub,
          action: 'hp.item.receive-stock',
          entityType: 'hp-item',
          entityId: id,
          before: {
            quantityInStock: item.quantityInStock,
            costPrice: previousCost,
            sellingPrice: previousSelling,
          },
          after: {
            quantityInStock: item.quantityInStock + body.quantity,
            costPrice: nextCost,
            sellingPrice: nextSelling,
            quantityReceived: body.quantity,
            receivedOn,
            ...(body.supplier !== undefined ? { supplier: body.supplier } : {}),
            ...(body.invoiceRef !== undefined ? { invoiceRef: body.invoiceRef } : {}),
          },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const fresh = await HpItemModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!fresh) throw new AppError('NOT_FOUND', 'Item not found', 404);

  const changes = await HpPriceChangeModel.find({
    itemId: id,
    quantityReceived: body.quantity,
    receivedOn,
  }).sort({ createdAt: -1, _id: -1 });
  const names = await changedByNames(changes);

  if (previousCost !== nextCost) {
    emitAdminEvent('hp.item.cost-changed', {
      id: id.toHexString(),
      name: fresh.name,
      previous: previousCost,
      current: nextCost,
      quantityReceived: body.quantity,
    });
  }

  return {
    item: fresh,
    // Only the two this delivery could have written, newest first.
    changes: changes.slice(0, 2).map((c) => toPublicPriceChange(c, names)),
  };
}

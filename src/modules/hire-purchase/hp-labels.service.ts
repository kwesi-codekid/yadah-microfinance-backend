import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { HpItemModel, HpLabelModel, type HpLabel, type HpLabelKind } from '../../models/index.js';
import { labelKey } from '../../models/hp-label.model.js';
import { NOT_TRASHED } from '../../models/shared.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type { LabelBody, ListLabelsQuery, UpdateLabelBody } from './hp.schemas.js';

/**
 * Brands and categories: the two managed lists an item is filed under.
 *
 * Same shape for both, so one service handles them by `kind`. A label is
 * never deleted while an item still points at it — the item would be left
 * filed under nothing — and two labels of one kind never share a name,
 * whatever the capitals.
 */

export interface PublicHpLabel {
  id: string;
  kind: HpLabelKind;
  name: string;
  description?: string;
  /** Items on the shelf filed under it, trashed ones excluded. */
  itemCount: number;
  createdAt: Date;
}

/** Which item field points at a label of this kind. */
export function itemFieldFor(kind: HpLabelKind): 'brandId' | 'categoryId' {
  return kind === 'brand' ? 'brandId' : 'categoryId';
}

const NOUN: Record<HpLabelKind, string> = { brand: 'brand', category: 'category' };

function toPublic(label: HpLabel, itemCount: number): PublicHpLabel {
  return {
    id: label._id.toHexString(),
    kind: label.kind,
    name: label.name,
    ...(label.description !== undefined ? { description: label.description } : {}),
    itemCount,
    createdAt: label.createdAt,
  };
}

/** Items per label, for the ids given, in one query. */
async function countItems(kind: HpLabelKind, ids: Types.ObjectId[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const field = itemFieldFor(kind);
  const rows = await HpItemModel.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { [field]: { $in: ids }, ...NOT_TRASHED } },
    { $group: { _id: `$${field}`, n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id.toHexString(), r.n]));
}

export async function listLabels(
  kind: HpLabelKind,
  query: ListLabelsQuery,
): Promise<{ items: PublicHpLabel[]; page: number; limit: number; total: number }> {
  const filter: Record<string, unknown> = { kind };
  if (query.search !== undefined) {
    const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.name = { $regex: escaped, $options: 'i' };
  }
  const [labels, total] = await Promise.all([
    HpLabelModel.find(filter)
      .collation({ locale: 'en', strength: 2 })
      .sort({ name: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    HpLabelModel.countDocuments(filter),
  ]);
  const counts = await countItems(
    kind,
    labels.map((l) => l._id),
  );
  return {
    items: labels.map((l) => toPublic(l, counts.get(l._id.toHexString()) ?? 0)),
    page: query.page,
    limit: query.limit,
    total,
  };
}

/** Every label of a kind, for a picker — the whole list is short. */
export async function allLabels(kind: HpLabelKind): Promise<{ id: string; name: string }[]> {
  const labels = await HpLabelModel.find({ kind }, { name: 1 })
    .collation({ locale: 'en', strength: 2 })
    .sort({ name: 1 });
  return labels.map((l) => ({ id: l._id.toHexString(), name: l.name }));
}

export async function getLabel(kind: HpLabelKind, id: Types.ObjectId): Promise<PublicHpLabel> {
  const label = await HpLabelModel.findOne({ _id: id, kind });
  if (!label) throw new AppError('NOT_FOUND', `${NOUN[kind]} not found`, 404);
  const counts = await countItems(kind, [label._id]);
  return toPublic(label, counts.get(label._id.toHexString()) ?? 0);
}

export async function createLabel(
  actor: AccessTokenPayload,
  kind: HpLabelKind,
  body: LabelBody,
  requestId?: string,
): Promise<PublicHpLabel> {
  const nameKey = labelKey(body.name);
  const taken = await HpLabelModel.findOne({ kind, nameKey });
  if (taken) {
    throw new AppError(
      'LABEL_TAKEN',
      `A ${NOUN[kind]} called "${taken.name}" already exists`,
      409,
      {
        id: taken._id.toHexString(),
      },
    );
  }
  const label = await HpLabelModel.create({
    kind,
    name: body.name,
    nameKey,
    ...(body.description !== undefined ? { description: body.description } : {}),
    createdById: new Types.ObjectId(actor.sub),
  });
  await audit({
    actorId: actor.sub,
    action: `hp.${kind}.create`,
    entityType: 'hp-label',
    entityId: label._id,
    after: { name: label.name },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublic(label, 0);
}

export async function updateLabel(
  actor: AccessTokenPayload,
  kind: HpLabelKind,
  id: Types.ObjectId,
  patch: UpdateLabelBody,
  requestId?: string,
): Promise<PublicHpLabel> {
  const label = await HpLabelModel.findOne({ _id: id, kind });
  if (!label) throw new AppError('NOT_FOUND', `${NOUN[kind]} not found`, 404);

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  if (patch.name !== undefined && patch.name !== label.name) {
    const nameKey = labelKey(patch.name);
    const taken = await HpLabelModel.findOne({ kind, nameKey, _id: { $ne: id } });
    if (taken) {
      throw new AppError(
        'LABEL_TAKEN',
        `A ${NOUN[kind]} called "${taken.name}" already exists`,
        409,
        { id: taken._id.toHexString() },
      );
    }
    before.name = label.name;
    after.name = patch.name;
    label.name = patch.name;
    label.nameKey = nameKey;
  }
  if (patch.description !== undefined) {
    const next = patch.description ?? undefined;
    if (next !== label.description) {
      before.description = label.description;
      after.description = next;
      if (next === undefined) label.set('description', undefined);
      else label.description = next;
    }
  }
  await label.save();

  if (Object.keys(after).length > 0) {
    await audit({
      actorId: actor.sub,
      action: `hp.${kind}.update`,
      entityType: 'hp-label',
      entityId: label._id,
      before,
      after,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }
  const counts = await countItems(kind, [label._id]);
  return toPublic(label, counts.get(label._id.toHexString()) ?? 0);
}

/**
 * Gone for good — there is no trash for a label, because nothing else refers
 * to one except the items it is refused for. Move those first.
 */
export async function deleteLabel(
  actor: AccessTokenPayload,
  kind: HpLabelKind,
  id: Types.ObjectId,
  requestId?: string,
): Promise<void> {
  const label = await HpLabelModel.findOne({ _id: id, kind });
  if (!label) throw new AppError('NOT_FOUND', `${NOUN[kind]} not found`, 404);
  const inUse = await HpItemModel.countDocuments({ [itemFieldFor(kind)]: id, ...NOT_TRASHED });
  if (inUse > 0) {
    throw new AppError(
      'LABEL_IN_USE',
      `${String(inUse)} ${inUse === 1 ? 'item is' : 'items are'} filed under this ${NOUN[kind]} — move them first`,
      409,
      { itemCount: inUse },
    );
  }
  await label.deleteOne();
  await audit({
    actorId: actor.sub,
    action: `hp.${kind}.delete`,
    entityType: 'hp-label',
    entityId: id,
    before: { name: label.name },
    ...(requestId !== undefined ? { requestId } : {}),
  });
}

/**
 * The label a sheet names, if any. Matched the way the unique index matches,
 * so a supplier's "NASCO" finds the branch's "Nasco".
 */
export async function labelIndex(kind: HpLabelKind): Promise<{
  list: { id: string; name: string }[];
  byKey: Map<string, string>;
}> {
  const list = await allLabels(kind);
  const byKey = new Map<string, string>();
  for (const l of list) {
    byKey.set(labelKey(l.name), l.id);
    byKey.set(l.id, l.id);
  }
  return { list, byKey };
}

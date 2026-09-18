import type { Types } from 'mongoose';
import { createdAtFilter } from '../../lib/time.js';
import {
  AuditLogModel,
  CashAccountModel,
  CustomerModel,
  ExpenseModel,
  FixedAssetModel,
  HpAgreementModel,
  HpItemModel,
  LoanModel,
  SavingsAccountModel,
  SusuAccountModel,
  UserModel,
  type AuditLog,
  type Role,
} from '../../models/index.js';
import type { ListAuditLogsQuery } from './audit-logs.schemas.js';

/**
 * Reading the trail rule 3 writes.
 *
 * Every mutating action in the API leaves an `AuditLog` behind — who, what,
 * to which record, with the figures before and after. Nothing here changes
 * one; the collection is append-only and this module only ever reads it. The
 * office reads it to answer "who did this, and when": a figure that moved
 * without a correction on file, a customer moved between rounds, a staff
 * account re-enabled.
 *
 * The rows hold ids. The names are joined for display, the way every other
 * listing joins them, so the screen can say "Ama Serwaa" and "#SU00000012"
 * rather than two hex strings.
 */

export interface PublicAuditLog {
  id: string;
  actorId: string;
  /** Joined for display; a deleted account leaves it unset. */
  actorName?: string;
  actorRole?: Role;
  action: string;
  entityType: string;
  entityId: string;
  /** The record's own name or number, where its type has one and it still exists. */
  entityLabel?: string;
  amountBefore?: number;
  amountAfter?: number;
  before?: unknown;
  after?: unknown;
  requestId?: string;
  /** Where the change came from. Absent on a worker's entries. */
  method?: string;
  path?: string;
  userAgent?: string;
  createdAt: Date;
}

export interface AuditLogList {
  items: PublicAuditLog[];
  page: number;
  limit: number;
  total: number;
}

/** Regex-escape one action prefix so a `-` or `.` in it is read literally. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The Mongo filter a query turns into. Exported so the export and the count
 * read the same set.
 */
export function filterFor(query: ListAuditLogsQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (query.actorId) filter.actorId = query.actorId;
  if (query.entityType) filter.entityType = query.entityType;
  if (query.entityId) filter.entityId = query.entityId;
  if (query.action) {
    // `susu` reaches `susu.deposit.record` but not `susu-account-something`:
    // a prefix ends at a dot or at the end of the action.
    const alternatives = query.action.map(escapeRegex).join('|');
    filter.action = { $regex: `^(?:${alternatives})(?:\\.|$)` };
  }
  const createdAt = createdAtFilter(query.from, query.to);
  if (createdAt) filter.createdAt = createdAt;
  return filter;
}

export async function listAuditLogs(query: ListAuditLogsQuery): Promise<AuditLogList> {
  const filter = filterFor(query);
  const [rows, total] = await Promise.all([
    AuditLogModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    AuditLogModel.countDocuments(filter),
  ]);
  const names = await auditNames(rows);
  return {
    items: rows.map((r) => toPublicAuditLog(r, names)),
    page: query.page,
    limit: query.limit,
    total,
  };
}

// ---------------------------------------------------------------- names

interface AuditNames {
  actors: Map<string, { name: string; role: Role }>;
  /** `${entityType}:${entityId}` → label. */
  entities: Map<string, string>;
}

type Labeller = (ids: Types.ObjectId[]) => Promise<[string, string][]>;

/**
 * How each kind of record names itself. Only the types that carry a name or a
 * number people use are here; the rest show as their type and id, which is
 * still enough to find them on the record's own page.
 */
const LABELLERS: Record<string, Labeller> = {
  customer: async (ids) =>
    (await CustomerModel.find({ _id: { $in: ids } }, { fullName: 1 }).lean()).map((c) => [
      c._id.toHexString(),
      c.fullName,
    ]),
  user: async (ids) =>
    (await UserModel.find({ _id: { $in: ids } }, { name: 1 }).lean()).map((u) => [
      u._id.toHexString(),
      u.name,
    ]),
  'susu-account': async (ids) =>
    (await SusuAccountModel.find({ _id: { $in: ids } }, { accountNumber: 1 }).lean()).map((a) => [
      a._id.toHexString(),
      `#${a.accountNumber}`,
    ]),
  'savings-account': async (ids) =>
    (await SavingsAccountModel.find({ _id: { $in: ids } }, { accountNumber: 1 }).lean()).map(
      (a) => [a._id.toHexString(), `#${a.accountNumber}`],
    ),
  loan: async (ids) =>
    (await LoanModel.find({ _id: { $in: ids } }, { accountNumber: 1 }).lean()).flatMap((l) =>
      l.accountNumber ? [[l._id.toHexString(), `#${l.accountNumber}`] as [string, string]] : [],
    ),
  'hp-agreement': async (ids) =>
    (await HpAgreementModel.find({ _id: { $in: ids } }, { accountNumber: 1 }).lean()).flatMap(
      (a) =>
        a.accountNumber ? [[a._id.toHexString(), `#${a.accountNumber}`] as [string, string]] : [],
    ),
  'hp-item': async (ids) =>
    (await HpItemModel.find({ _id: { $in: ids } }, { name: 1 }).lean()).map((i) => [
      i._id.toHexString(),
      i.name,
    ]),
  expense: async (ids) =>
    (await ExpenseModel.find({ _id: { $in: ids } }, { description: 1 }).lean()).map((e) => [
      e._id.toHexString(),
      e.description,
    ]),
  'cash-account': async (ids) =>
    (await CashAccountModel.find({ _id: { $in: ids } }, { name: 1 }).lean()).map((a) => [
      a._id.toHexString(),
      a.name,
    ]),
  'fixed-asset': async (ids) =>
    (await FixedAssetModel.find({ _id: { $in: ids } }, { name: 1 }).lean()).map((a) => [
      a._id.toHexString(),
      a.name,
    ]),
};

/** One query per kind of record on the page, plus one for the people. */
async function auditNames(rows: AuditLog[]): Promise<AuditNames> {
  const actorIds = new Set<string>();
  const byType = new Map<string, Map<string, Types.ObjectId>>();
  for (const row of rows) {
    actorIds.add(row.actorId.toHexString());
    if (!(row.entityType in LABELLERS)) continue;
    const ids = byType.get(row.entityType) ?? new Map<string, Types.ObjectId>();
    ids.set(row.entityId.toHexString(), row.entityId);
    byType.set(row.entityType, ids);
  }

  const [users, ...labelled] = await Promise.all([
    UserModel.find({ _id: { $in: [...actorIds] } }, { name: 1, role: 1 }).lean(),
    ...[...byType.entries()].map(async ([type, ids]) => {
      const labeller = LABELLERS[type];
      if (!labeller) return [] as [string, string][];
      const pairs = await labeller([...ids.values()]);
      return pairs.map(([id, label]) => [`${type}:${id}`, label] as [string, string]);
    }),
  ]);

  return {
    actors: new Map(users.map((u) => [u._id.toHexString(), { name: u.name, role: u.role }])),
    entities: new Map(labelled.flat()),
  };
}

export function toPublicAuditLog(row: AuditLog, names: AuditNames): PublicAuditLog {
  const actorId = row.actorId.toHexString();
  const entityId = row.entityId.toHexString();
  const actor = names.actors.get(actorId);
  const entityLabel = names.entities.get(`${row.entityType}:${entityId}`);
  return {
    id: row._id.toHexString(),
    actorId,
    ...(actor ? { actorName: actor.name, actorRole: actor.role } : {}),
    action: row.action,
    entityType: row.entityType,
    entityId,
    ...(entityLabel !== undefined ? { entityLabel } : {}),
    ...(row.amountBefore !== undefined ? { amountBefore: row.amountBefore } : {}),
    ...(row.amountAfter !== undefined ? { amountAfter: row.amountAfter } : {}),
    ...(row.before !== undefined ? { before: row.before } : {}),
    ...(row.after !== undefined ? { after: row.after } : {}),
    ...(row.requestId !== undefined ? { requestId: row.requestId } : {}),
    ...(row.method !== undefined ? { method: row.method } : {}),
    ...(row.path !== undefined ? { path: row.path } : {}),
    ...(row.userAgent !== undefined ? { userAgent: row.userAgent } : {}),
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------- export

/**
 * One flat row per entry for the spreadsheet. The snapshots are objects of
 * no fixed shape, so they travel as JSON in one cell each rather than as a
 * column per field that would differ from row to row.
 */
export function toAuditExportRow(log: PublicAuditLog): Record<string, unknown> {
  return {
    at: log.createdAt.toISOString(),
    actor: log.actorName ?? log.actorId,
    actorRole: log.actorRole ?? '',
    action: log.action,
    entityType: log.entityType,
    entity: log.entityLabel ?? '',
    entityId: log.entityId,
    amountBefore: log.amountBefore ?? '',
    amountAfter: log.amountAfter ?? '',
    before: log.before === undefined ? '' : JSON.stringify(log.before),
    after: log.after === undefined ? '' : JSON.stringify(log.after),
    endpoint: log.method && log.path ? `${log.method} ${log.path}` : '',
    device: log.userAgent ?? '',
    requestId: log.requestId ?? '',
  };
}

import mongoose, { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { createdAtFilter } from '../../lib/time.js';
import { formatGhs } from '../../lib/money.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { enqueueSms } from '../../lib/sms.js';
import { escapeRegex, fuzzyCustomerIds } from '../../lib/fuzzy.js';
import { EXPORT_MAX_ROWS } from '../../lib/exports.js';
import { addMonthsClamped, allocateRepayment, buildSchedule } from '../../domain/loans.js';
import {
  HP_ELIGIBILITY_MIN_MONTHS,
  HP_REDEMPTION_WINDOW_MONTHS,
  computeDepositSplit,
  computeHpFinancing,
  validatePricing,
} from '../../domain/hire-purchase.js';
import {
  CustomerModel,
  HpAgreementModel,
  HpConfigModel,
  HpItemModel,
  HpPaymentModel,
  HpSaleModel,
  HpScheduleModel,
  LoanModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SusuAccountModel,
  SusuDepositModel,
  UserModel,
  type HpAgreement,
  type HpItem,
  type HpPayment,
  type HpSale,
  type HpSaleLine,
} from '../../models/index.js';
import { buildReceiptPdf, receiptNumber, type ReceiptLine } from '../../lib/receipt-pdf.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import { NOT_TRASHED, requireDeletedAt, type Channel } from '../../models/shared.js';
import type {
  CreateAgreementBody,
  CreateItemBody,
  ListAgreementsQuery,
  ListItemsQuery,
  ListSalesQuery,
  RecordSaleBody,
  TrashListQuery,
  UpdateItemBody,
} from './hp.schemas.js';

/** Agreement states that count as "customer has an open HP" (blocks loans too). */
export const OPEN_HP_STATUSES = ['pending', 'active', 'in-arrears', 'repossessed'] as const;
const OPEN_LOAN_STATUSES = ['pending', 'active', 'arrears'] as const;

// ---------------------------------------------------------------- items

export interface PublicHpItem {
  id: string;
  name: string;
  description?: string;
  quantityInStock: number;
  costPrice: number;
  sellingPrice: number;
  condition: 'new' | 'used';
  status: string;
  createdAt: Date;
}

function toPublicItem(i: HpItem): PublicHpItem {
  return {
    id: i._id.toHexString(),
    name: i.name,
    ...(i.description !== undefined ? { description: i.description } : {}),
    quantityInStock: i.quantityInStock,
    costPrice: i.costPrice,
    sellingPrice: i.sellingPrice,
    condition: i.condition,
    status: i.status,
    createdAt: i.createdAt,
  };
}

/** Flat spreadsheet row for inventory exports (format=csv|xlsx). Office-only route, so costPrice is fine here. */
export function toHpItemExportRow(i: PublicHpItem): Record<string, unknown> {
  return {
    id: i.id,
    name: i.name,
    quantityInStock: i.quantityInStock,
    costPrice: i.costPrice,
    sellingPrice: i.sellingPrice,
    condition: i.condition,
    status: i.status,
    createdAt: i.createdAt,
  };
}

export async function createItem(
  actor: AccessTokenPayload,
  body: CreateItemBody,
  requestId?: string,
): Promise<PublicHpItem> {
  const { description, ...fields } = body;
  const item = await HpItemModel.create({
    ...fields,
    ...(description !== undefined ? { description } : {}),
    createdById: new Types.ObjectId(actor.sub),
  });
  await audit({
    actorId: actor.sub,
    action: 'hp.item.create',
    entityType: 'hp-item',
    entityId: item._id,
    after: {
      name: item.name,
      quantityInStock: item.quantityInStock,
      costPrice: item.costPrice,
      sellingPrice: item.sellingPrice,
    },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicItem(item);
}

export async function listItems(
  query: ListItemsQuery,
): Promise<{ items: PublicHpItem[]; page: number; limit: number; total: number }> {
  const filter: Record<string, unknown> = { ...NOT_TRASHED };
  if (query.status) filter.status = query.status;
  if (query.inStockOnly) filter.quantityInStock = { $gt: 0 };
  if (query.search !== undefined) {
    const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.name = { $regex: escaped, $options: 'i' };
  }
  const dateFilter = createdAtFilter(query.from, query.to);
  if (dateFilter) filter.createdAt = dateFilter;
  const [items, total] = await Promise.all([
    HpItemModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    HpItemModel.countDocuments(filter),
  ]);
  return { items: items.map(toPublicItem), page: query.page, limit: query.limit, total };
}

export async function updateItem(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  patch: UpdateItemBody,
  requestId?: string,
): Promise<PublicHpItem> {
  const item = await HpItemModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!item) throw new AppError('NOT_FOUND', 'Item not found', 404);

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of ['name', 'description', 'costPrice', 'sellingPrice', 'status'] as const) {
    const next = patch[key];
    if (next !== undefined && next !== item[key]) {
      before[key] = item[key];
      after[key] = next;
      (item as Record<typeof key, unknown>)[key] = next;
    }
  }
  validatePricing(item.costPrice, item.sellingPrice);
  await item.save();

  if (Object.keys(after).length > 0) {
    await audit({
      actorId: actor.sub,
      action: 'hp.item.update',
      entityType: 'hp-item',
      entityId: item._id,
      before,
      after,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }
  return toPublicItem(item);
}

export async function adjustStock(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  delta: number,
  reason: string,
  requestId?: string,
): Promise<PublicHpItem> {
  const item = await HpItemModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!item) throw new AppError('NOT_FOUND', 'Item not found', 404);
  if (item.quantityInStock + delta < 0) {
    throw new AppError('STOCK_UNDERFLOW', 'Adjustment would make stock negative', 422, {
      quantityInStock: item.quantityInStock,
    });
  }
  const upd = await HpItemModel.updateOne(
    { _id: id, quantityInStock: item.quantityInStock },
    { $inc: { quantityInStock: delta } },
  );
  if (upd.modifiedCount !== 1) {
    throw new AppError('CONFLICT', 'Stock changed concurrently — retry', 409);
  }
  await audit({
    actorId: actor.sub,
    action: 'hp.item.adjust-stock',
    entityType: 'hp-item',
    entityId: id,
    before: { quantityInStock: item.quantityInStock },
    after: { quantityInStock: item.quantityInStock + delta, reason },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  const fresh = await HpItemModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!fresh) throw new AppError('NOT_FOUND', 'Item not found', 404);
  return toPublicItem(fresh);
}

// ---------------------------------------------------------------- item trash

export interface TrashedHpItem extends PublicHpItem {
  deletedAt: Date;
  deletedById?: string;
  deleteReason?: string;
}

function toTrashedItem(i: HpItem): TrashedHpItem {
  return {
    ...toPublicItem(i),
    deletedAt: requireDeletedAt(i.deletedAt),
    ...(i.deletedById !== undefined ? { deletedById: i.deletedById.toHexString() } : {}),
    ...(i.deleteReason !== undefined ? { deleteReason: i.deleteReason } : {}),
  };
}

export async function trashHpItem(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  reason: string | undefined,
  requestId?: string,
): Promise<TrashedHpItem> {
  const item = await HpItemModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!item) throw new AppError('NOT_FOUND', 'Item not found', 404);
  // Any agreement — open, closed or trashed — pins the item as history.
  const agreements = await HpAgreementModel.countDocuments({ itemId: id });
  if (agreements > 0) {
    throw new AppError(
      'CANNOT_TRASH',
      'Items already used by agreements cannot be moved to the trash',
      422,
      { agreements },
    );
  }
  const trashed = await HpItemModel.findOneAndUpdate(
    { _id: id, ...NOT_TRASHED },
    {
      $set: {
        deletedAt: new Date(),
        deletedById: new Types.ObjectId(actor.sub),
        ...(reason !== undefined ? { deleteReason: reason } : {}),
      },
    },
    { returnDocument: 'after' },
  );
  if (!trashed) throw new AppError('NOT_FOUND', 'Item not found', 404);
  await audit({
    actorId: actor.sub,
    action: 'hp.item.trash',
    entityType: 'hp-item',
    entityId: id,
    before: { status: item.status, deletedAt: null },
    after: {
      status: trashed.status,
      deletedAt: trashed.deletedAt,
      ...(reason !== undefined ? { reason } : {}),
    },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  emitAdminEvent('hp.item.trashed', { id: id.toHexString(), name: item.name });
  return toTrashedItem(trashed);
}

export async function restoreHpItem(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  requestId?: string,
): Promise<PublicHpItem> {
  const item = await HpItemModel.findById(id);
  if (!item) throw new AppError('NOT_FOUND', 'Item not found', 404);
  if (!item.deletedAt) throw new AppError('NOT_TRASHED', 'Item is not in the trash', 409);
  const restored = await HpItemModel.findOneAndUpdate(
    { _id: id, deletedAt: { $ne: null } },
    { $set: { deletedAt: null }, $unset: { deletedById: '', deleteReason: '' } },
    { returnDocument: 'after' },
  );
  if (!restored) throw new AppError('NOT_TRASHED', 'Item is not in the trash', 409);
  await audit({
    actorId: actor.sub,
    action: 'hp.item.restore',
    entityType: 'hp-item',
    entityId: id,
    before: { status: item.status, deletedAt: item.deletedAt },
    after: { status: restored.status, deletedAt: null },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  emitAdminEvent('hp.item.restored', { id: id.toHexString(), name: restored.name });
  return toPublicItem(restored);
}

export async function listHpItemTrash(
  query: TrashListQuery,
): Promise<{ items: TrashedHpItem[]; page: number; limit: number; total: number }> {
  const filter = { deletedAt: { $ne: null } };
  const [items, total] = await Promise.all([
    HpItemModel.find(filter)
      .sort({ deletedAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    HpItemModel.countDocuments(filter),
  ]);
  return { items: items.map(toTrashedItem), page: query.page, limit: query.limit, total };
}

// ---------------------------------------------------------------- config

export async function getHpConfig(): Promise<{
  interestRatePercent: number;
  interestMethod: string;
}> {
  const doc = await HpConfigModel.findOne().sort({ updatedAt: -1 });
  return {
    interestRatePercent: doc?.interestRatePercent ?? 0,
    interestMethod: 'flat-once', // client-confirmed 2026-08-02: flat, applied once to the financed half
  };
}

export async function putHpConfig(
  actor: AccessTokenPayload,
  interestRatePercent: number,
  requestId?: string,
): Promise<{ interestRatePercent: number; interestMethod: string }> {
  const before = await getHpConfig();
  await HpConfigModel.findOneAndUpdate(
    {},
    { interestRatePercent, updatedById: new Types.ObjectId(actor.sub) },
    { upsert: true, sort: { updatedAt: -1 } },
  );
  await audit({
    actorId: actor.sub,
    action: 'hp.config.update',
    entityType: 'hp-config',
    entityId: new Types.ObjectId(actor.sub),
    before: { interestRatePercent: before.interestRatePercent },
    after: { interestRatePercent },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return getHpConfig();
}

// ---------------------------------------------------------------- eligibility

export interface HpEligibility {
  customer: { id: string; fullName: string };
  hasActiveSusuOrSavings: boolean;
  firstActivityAt: Date | null;
  monthsOfHistory: number;
  openLoan: boolean;
  openHpAgreement: boolean;
  eligible: boolean;
  reasons: string[];
}

export async function hpEligibility(customerId: Types.ObjectId): Promise<HpEligibility> {
  const customer = await CustomerModel.findOne({ _id: customerId, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);

  const [activeSusu, activeSavings, firstSusu, firstSavings, openLoan, openHp] = await Promise.all([
    SusuAccountModel.exists({ customerId, status: 'active', ...NOT_TRASHED }),
    SavingsAccountModel.exists({ customerId, status: 'active', ...NOT_TRASHED }),
    SusuDepositModel.findOne({ customerId, ...NOT_TRASHED }).sort({ createdAt: 1 }),
    SavingsTxnModel.findOne({ customerId, ...NOT_TRASHED }).sort({ createdAt: 1 }),
    LoanModel.exists({ customerId, status: { $in: OPEN_LOAN_STATUSES }, ...NOT_TRASHED }),
    HpAgreementModel.exists({ customerId, status: { $in: OPEN_HP_STATUSES }, ...NOT_TRASHED }),
  ]);

  const firsts = [firstSusu?.createdAt, firstSavings?.createdAt].filter(
    (d): d is Date => d !== undefined,
  );
  const firstActivityAt =
    firsts.length > 0 ? new Date(Math.min(...firsts.map((d) => d.getTime()))) : null;
  const monthsOfHistory = firstActivityAt
    ? Math.floor((Date.now() - firstActivityAt.getTime()) / (30.44 * 24 * 60 * 60 * 1000))
    : 0;

  const reasons: string[] = [];
  if (!activeSusu && !activeSavings) reasons.push('No active susu or savings account');
  if (monthsOfHistory < HP_ELIGIBILITY_MIN_MONTHS) {
    reasons.push(`Saving history under ${String(HP_ELIGIBILITY_MIN_MONTHS)} months`);
  }
  if (openLoan) reasons.push('Customer has an active loan (loans and HP block each other)');
  if (openHp) reasons.push('Customer already has an open hire purchase agreement');

  return {
    customer: { id: customer._id.toHexString(), fullName: customer.fullName },
    hasActiveSusuOrSavings: Boolean(activeSusu ?? activeSavings),
    firstActivityAt,
    monthsOfHistory,
    openLoan: openLoan !== null,
    openHpAgreement: openHp !== null,
    eligible: reasons.length === 0,
    reasons,
  };
}

// ---------------------------------------------------------------- agreements

export interface PublicHpAgreement {
  id: string;
  customerId: string;
  customerName?: string;
  item: { name: string; description?: string; sellingPrice: number };
  depositRequired: number;
  financedAmount: number;
  durationMonths: number;
  interestRatePercent: number;
  interestAmount?: number;
  totalPayable?: number;
  /** totalPayable − (totalPaid − deposit); 0 until activation. */
  remaining: number;
  totalPaid: number;
  status: string;
  itemReleasedAt?: Date;
  arrearsAt?: Date;
  repossessedAt?: Date;
  repossessionReason?: string;
  redemptionDeadline?: Date;
  closedAt?: Date;
  rejectionReason?: string;
  createdAt: Date;
}

/** What the customer still owes on the financed portion (post-activation). */
export function remainingOn(a: HpAgreement): number {
  if (a.totalPayable === undefined) return 0;
  return a.totalPayable - (a.totalPaid - a.depositRequired);
}

/** Customer-facing shape: cost price (Yadah's margin) is deliberately absent. */
function toPublicAgreement(a: HpAgreement): PublicHpAgreement {
  return {
    id: a._id.toHexString(),
    customerId: a.customerId.toHexString(),
    item: {
      name: a.itemSnapshot.name,
      ...(a.itemSnapshot.description !== undefined
        ? { description: a.itemSnapshot.description }
        : {}),
      sellingPrice: a.itemSnapshot.sellingPrice,
    },
    depositRequired: a.depositRequired,
    financedAmount: a.financedAmount,
    durationMonths: a.durationMonths,
    interestRatePercent: a.interestRatePercent,
    ...(a.interestAmount !== undefined ? { interestAmount: a.interestAmount } : {}),
    ...(a.totalPayable !== undefined ? { totalPayable: a.totalPayable } : {}),
    remaining: remainingOn(a),
    totalPaid: a.totalPaid,
    status: a.status,
    ...(a.itemReleasedAt !== undefined ? { itemReleasedAt: a.itemReleasedAt } : {}),
    ...(a.arrearsAt !== undefined ? { arrearsAt: a.arrearsAt } : {}),
    ...(a.repossessedAt !== undefined ? { repossessedAt: a.repossessedAt } : {}),
    ...(a.repossessionReason !== undefined ? { repossessionReason: a.repossessionReason } : {}),
    ...(a.redemptionDeadline !== undefined ? { redemptionDeadline: a.redemptionDeadline } : {}),
    ...(a.closedAt !== undefined ? { closedAt: a.closedAt } : {}),
    ...(a.rejectionReason !== undefined ? { rejectionReason: a.rejectionReason } : {}),
    createdAt: a.createdAt,
  };
}

/** Flat spreadsheet row for agreement exports (format=csv|xlsx). */
export function toHpAgreementExportRow(a: PublicHpAgreement): Record<string, unknown> {
  return {
    id: a.id,
    customerName: a.customerName ?? '',
    itemName: a.item.name,
    depositRequired: a.depositRequired,
    financedAmount: a.financedAmount,
    interestRatePercent: a.interestRatePercent,
    totalPayable: a.totalPayable ?? null, // null until activation
    totalPaid: a.totalPaid,
    remaining: a.remaining,
    durationMonths: a.durationMonths,
    status: a.status,
    createdAt: a.createdAt,
  };
}

export async function createAgreement(
  actor: AccessTokenPayload,
  body: CreateAgreementBody,
  requestId?: string,
): Promise<PublicHpAgreement> {
  const eligibility = await hpEligibility(body.customerId);
  if (!eligibility.eligible) {
    throw new AppError('NOT_ELIGIBLE', 'Customer is not eligible for hire purchase', 422, {
      reasons: eligibility.reasons,
    });
  }
  const customer = await CustomerModel.findOne({ _id: body.customerId, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);

  const item = await HpItemModel.findOne({ _id: body.itemId, ...NOT_TRASHED });
  if (item?.status !== 'active') {
    throw new AppError('NOT_FOUND', 'Item not found or discontinued', 404);
  }
  if (item.quantityInStock < 1) {
    throw new AppError('OUT_OF_STOCK', 'Item is out of stock', 422);
  }
  validatePricing(item.costPrice, item.sellingPrice);
  const { depositRequired, financedAmount } = computeDepositSplit(item.sellingPrice);
  const config = await getHpConfig();

  const session = await mongoose.startSession();
  let agreement!: HpAgreement;
  try {
    await session.withTransaction(async () => {
      // Stock decrements when the agreement is signed (HP guide).
      const stockUpd = await HpItemModel.updateOne(
        { _id: item._id, quantityInStock: { $gte: 1 }, status: 'active' },
        { $inc: { quantityInStock: -1 } },
        { session },
      );
      if (stockUpd.modifiedCount !== 1) {
        throw new AppError('OUT_OF_STOCK', 'Item went out of stock — retry', 409);
      }
      const [created] = await HpAgreementModel.create(
        [
          {
            customerId: customer._id,
            itemId: item._id,
            itemSnapshot: {
              name: item.name,
              ...(item.description !== undefined ? { description: item.description } : {}),
              costPrice: item.costPrice,
              sellingPrice: item.sellingPrice,
            },
            depositRequired,
            financedAmount,
            durationMonths: body.durationMonths,
            interestRatePercent: config.interestRatePercent,
            createdById: new Types.ObjectId(actor.sub),
          },
        ],
        { session },
      );
      agreement = created as HpAgreement;
      await audit(
        {
          actorId: actor.sub,
          action: 'hp.agreement.create',
          entityType: 'hp-agreement',
          entityId: agreement._id,
          amountAfter: item.sellingPrice,
          after: {
            item: item.name,
            depositRequired,
            financedAmount,
            durationMonths: body.durationMonths,
          },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  await enqueueSms({
    to: customer.phone,
    template: 'hp-signed',
    message:
      `Yadah: hire purchase for ${item.name} created. ` +
      `Deposit due: ${formatGhs(depositRequired)}. The item is released once the deposit is paid.`,
    relatedEntityType: 'hp-agreement',
    relatedEntityId: agreement._id,
  });
  emitAdminEvent('hp.agreement.created', {
    id: agreement._id.toHexString(),
    customerId: customer._id.toHexString(),
    customerName: customer.fullName,
    item: item.name,
    sellingPrice: item.sellingPrice,
  });
  return toPublicAgreement(agreement);
}

export async function recordDeposit(
  actor: AccessTokenPayload,
  agreementId: Types.ObjectId,
  amount: number,
  idempotencyKey: string,
  channel: Channel,
  requestId?: string,
): Promise<{ agreement: PublicHpAgreement; replayed: boolean }> {
  const existing = await HpPaymentModel.findOne({ idempotencyKey });
  if (existing) {
    const agreement = await HpAgreementModel.findById(existing.agreementId);
    if (!agreement) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
    return { agreement: toPublicAgreement(agreement), replayed: true };
  }

  const pre = await HpAgreementModel.findOne({ _id: agreementId, ...NOT_TRASHED });
  if (!pre) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  if (pre.status !== 'pending') {
    throw new AppError('NOT_PENDING', `Agreement is ${pre.status} — deposit not applicable`, 422);
  }
  if (amount !== pre.depositRequired) {
    throw new AppError(
      'DEPOSIT_MISMATCH',
      `Deposit must be exactly ${formatGhs(pre.depositRequired)} (50% of the item price)`,
      422,
      { required: pre.depositRequired },
    );
  }
  const customer = await CustomerModel.findById(pre.customerId);

  // Flat interest, once, on the financed half (client-confirmed) — the
  // repayment plan is generated at activation.
  const { interestAmount, totalPayable } = computeHpFinancing(
    pre.financedAmount,
    pre.interestRatePercent,
  );
  const now = new Date();
  const schedule = buildSchedule(totalPayable, pre.durationMonths, now);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const upd = await HpAgreementModel.updateOne(
        { _id: agreementId, status: 'pending' },
        {
          $set: { status: 'active', itemReleasedAt: now, interestAmount, totalPayable },
          $inc: { totalPaid: amount },
        },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Agreement changed concurrently — retry', 409);
      }
      await HpScheduleModel.create(
        schedule.map((line) => ({
          agreementId,
          customerId: pre.customerId,
          installmentNumber: line.installmentNumber,
          dueDate: line.dueDate,
          amountDue: line.amountDue,
        })),
        { session, ordered: true },
      );
      await HpPaymentModel.create(
        [
          {
            agreementId,
            customerId: pre.customerId,
            type: 'deposit',
            amount,
            channel,
            recordedById: new Types.ObjectId(actor.sub),
            idempotencyKey,
          },
        ],
        { session },
      );
      await audit(
        {
          actorId: actor.sub,
          action: 'hp.deposit.record',
          entityType: 'hp-agreement',
          entityId: agreementId,
          amountBefore: 0,
          amountAfter: amount,
          after: { itemReleased: true, totalPayable, interestAmount },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const after = await HpAgreementModel.findById(agreementId);
  if (!after) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  if (customer) {
    const monthly = schedule[0]?.amountDue ?? 0;
    await enqueueSms({
      to: customer.phone,
      template: 'hp-deposit-receipt',
      message:
        `Yadah: deposit of ${formatGhs(amount)} received for ${after.itemSnapshot.name}. ` +
        `Item released. Balance: ${formatGhs(totalPayable)} over ${String(after.durationMonths)} months ` +
        `(about ${formatGhs(monthly)}/month).`,
      relatedEntityType: 'hp-agreement',
      relatedEntityId: agreementId,
    });
  }
  emitAdminEvent('hp.deposit', {
    id: agreementId.toHexString(),
    customerId: pre.customerId.toHexString(),
    amount,
    item: after.itemSnapshot.name,
  });
  return { agreement: toPublicAgreement(after), replayed: false };
}

export async function rejectAgreement(
  actor: AccessTokenPayload,
  agreementId: Types.ObjectId,
  reason: string,
  requestId?: string,
): Promise<PublicHpAgreement> {
  const pre = await HpAgreementModel.findOne({ _id: agreementId, ...NOT_TRASHED });
  if (!pre) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  if (pre.status !== 'pending') {
    throw new AppError('NOT_PENDING', `Agreement is ${pre.status}`, 409);
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const upd = await HpAgreementModel.updateOne(
        { _id: agreementId, status: 'pending' },
        { $set: { status: 'rejected', rejectionReason: reason, closedAt: new Date() } },
        { session },
      );
      if (upd.modifiedCount !== 1) throw new AppError('CONFLICT', 'Agreement changed — retry', 409);
      // Item never left the shop — put it back on the shelf.
      await HpItemModel.updateOne(
        { _id: pre.itemId },
        { $inc: { quantityInStock: 1 } },
        { session },
      );
      await audit(
        {
          actorId: actor.sub,
          action: 'hp.agreement.reject',
          entityType: 'hp-agreement',
          entityId: agreementId,
          after: { reason, stockRestored: true },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }
  const after = await HpAgreementModel.findById(agreementId);
  if (!after) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  return toPublicAgreement(after);
}

// ---------------------------------------------------------------- payments (Stage B)

/**
 * Core payment writer — runs INSIDE the caller's transaction so transfers
 * (susu/savings → HP) can reuse it. Applies to instalments oldest-first;
 * settling the totalPayable transfers ownership. Redemption requires the
 * FULL remaining balance while the window is open.
 */
export async function applyHpPaymentInTxn(
  actor: AccessTokenPayload,
  agreement: HpAgreement,
  amount: number,
  type: 'installment' | 'redemption',
  channel: Channel,
  idempotencyKey: string,
  session: mongoose.ClientSession,
  requestId?: string,
): Promise<{ settled: boolean }> {
  const remaining = remainingOn(agreement);
  if (amount > remaining) {
    throw new AppError(
      'EXCEEDS_BALANCE',
      `Amount exceeds the remaining balance (${formatGhs(remaining)})`,
      422,
      {
        remaining,
        amount,
      },
    );
  }
  const settled = amount === remaining;
  const now = new Date();

  const upd = await HpAgreementModel.updateOne(
    { _id: agreement._id, status: agreement.status, totalPaid: agreement.totalPaid },
    {
      $inc: { totalPaid: amount },
      ...(settled
        ? {
            $set: {
              status: type === 'redemption' ? 'closed-redeemed' : 'closed-completed',
              closedAt: now,
            },
          }
        : {}),
    },
    { session },
  );
  if (upd.modifiedCount !== 1) {
    throw new AppError('CONFLICT', 'Agreement was updated concurrently — retry', 409);
  }

  const schedule = await HpScheduleModel.find({ agreementId: agreement._id })
    .sort({ installmentNumber: 1 })
    .session(session);
  const additions = allocateRepayment(
    schedule.map((s) => ({ amountDue: s.amountDue, amountPaid: s.amountPaid })),
    amount,
  );
  for (const [i, line] of schedule.entries()) {
    const add = additions[i] ?? 0;
    if (add === 0) continue;
    const paid = line.amountPaid + add;
    await HpScheduleModel.updateOne(
      { _id: line._id },
      { $set: { amountPaid: paid, status: paid >= line.amountDue ? 'paid' : 'partial' } },
      { session },
    );
  }

  // A payment that clears every month-overdue instalment lifts arrears —
  // regardless of how the money arrived (cash or internal transfer).
  if (!settled && agreement.status === 'in-arrears') {
    const stillOverdue = await HpScheduleModel.findOne({
      agreementId: agreement._id,
      status: { $ne: 'paid' },
      dueDate: { $lt: addMonthsClamped(now, -1) },
    }).session(session);
    if (!stillOverdue) {
      await HpAgreementModel.updateOne(
        { _id: agreement._id, status: 'in-arrears' },
        { $set: { status: 'active' }, $unset: { arrearsAt: '' } },
        { session },
      );
    }
  }

  await HpPaymentModel.create(
    [
      {
        agreementId: agreement._id,
        customerId: agreement.customerId,
        type,
        amount,
        channel,
        recordedById: new Types.ObjectId(actor.sub),
        idempotencyKey,
      },
    ],
    { session },
  );
  await audit(
    {
      actorId: actor.sub,
      action: type === 'redemption' ? 'hp.redemption.record' : 'hp.payment.record',
      entityType: 'hp-agreement',
      entityId: agreement._id,
      amountBefore: remaining,
      amountAfter: remaining - amount,
      after: { settled },
      ...(requestId !== undefined ? { requestId } : {}),
    },
    session,
  );
  return { settled };
}

async function replayPayment(
  idempotencyKey: string,
): Promise<{ agreement: PublicHpAgreement; replayed: boolean } | null> {
  const existing = await HpPaymentModel.findOne({ idempotencyKey });
  if (!existing) return null;
  const agreement = await HpAgreementModel.findById(existing.agreementId);
  if (!agreement) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  return { agreement: toPublicAgreement(agreement), replayed: true };
}

export async function payInstallment(
  actor: AccessTokenPayload,
  agreementId: Types.ObjectId,
  amount: number,
  idempotencyKey: string,
  channel: Channel,
  requestId?: string,
): Promise<{ agreement: PublicHpAgreement; replayed: boolean }> {
  const replayed = await replayPayment(idempotencyKey);
  if (replayed) return replayed;

  const agreement = await HpAgreementModel.findOne({ _id: agreementId, ...NOT_TRASHED });
  if (!agreement) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  if (agreement.status !== 'active' && agreement.status !== 'in-arrears') {
    throw new AppError(
      'AGREEMENT_NOT_OPEN',
      `Agreement is ${agreement.status} — payments not accepted`,
      422,
    );
  }
  const customer = await CustomerModel.findById(agreement.customerId);

  const session = await mongoose.startSession();
  const outcome = { settled: false };
  try {
    await session.withTransaction(async () => {
      const result = await applyHpPaymentInTxn(
        actor,
        agreement,
        amount,
        'installment',
        channel,
        idempotencyKey,
        session,
        requestId,
      );
      outcome.settled = result.settled;
    });
  } finally {
    await session.endSession();
  }

  const after = await HpAgreementModel.findById(agreementId);
  if (!after) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  if (customer) {
    await enqueueSms({
      to: customer.phone,
      template: 'hp-payment-receipt',
      message: outcome.settled
        ? `Yadah: ${formatGhs(amount)} received. ${after.itemSnapshot.name} is fully paid — the item is now yours!`
        : `Yadah: ${formatGhs(amount)} received for ${after.itemSnapshot.name}. Balance: ${formatGhs(remainingOn(after))}.`,
      relatedEntityType: 'hp-agreement',
      relatedEntityId: agreementId,
    });
  }
  emitAdminEvent(outcome.settled ? 'hp.completed' : 'hp.payment', {
    id: agreementId.toHexString(),
    customerId: after.customerId.toHexString(),
    amount,
    remaining: remainingOn(after),
  });
  return { agreement: toPublicAgreement(after), replayed: false };
}

export async function redeem(
  actor: AccessTokenPayload,
  agreementId: Types.ObjectId,
  idempotencyKey: string,
  channel: Channel,
  requestId?: string,
): Promise<{ agreement: PublicHpAgreement; amount: number; replayed: boolean }> {
  const replayed = await replayPayment(idempotencyKey);
  if (replayed) return { ...replayed, amount: 0 };

  const agreement = await HpAgreementModel.findOne({ _id: agreementId, ...NOT_TRASHED });
  if (!agreement) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  if (agreement.status !== 'repossessed') {
    throw new AppError('INVALID_TRANSITION', `Cannot redeem a ${agreement.status} agreement`, 409);
  }
  if (!agreement.redemptionDeadline || Date.now() > agreement.redemptionDeadline.getTime()) {
    throw new AppError(
      'REDEMPTION_WINDOW_LAPSED',
      'The 1-month redemption window has passed',
      422,
      {
        redemptionDeadline: agreement.redemptionDeadline,
      },
    );
  }
  const amount = remainingOn(agreement); // redemption = FULL remaining balance
  const customer = await CustomerModel.findById(agreement.customerId);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await applyHpPaymentInTxn(
        actor,
        agreement,
        amount,
        'redemption',
        channel,
        idempotencyKey,
        session,
        requestId,
      );
    });
  } finally {
    await session.endSession();
  }

  const after = await HpAgreementModel.findById(agreementId);
  if (!after) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  if (customer) {
    await enqueueSms({
      to: customer.phone,
      template: 'hp-redeemed',
      message: `Yadah: ${formatGhs(amount)} received. ${after.itemSnapshot.name} is redeemed and now yours.`,
      relatedEntityType: 'hp-agreement',
      relatedEntityId: agreementId,
    });
  }
  emitAdminEvent('hp.redeemed', { id: agreementId.toHexString(), amount });
  return { agreement: toPublicAgreement(after), amount, replayed: false };
}

// ---------------------------------------------------------------- manual state transitions
// The arrears trigger is automated (instalment ≥1 month overdue — see
// lib/hp-arrears.ts); the transitions also remain available as office actions.

export async function markArrears(
  actor: AccessTokenPayload,
  agreementId: Types.ObjectId,
  requestId?: string,
): Promise<PublicHpAgreement> {
  const agreement = await HpAgreementModel.findOne({ _id: agreementId, ...NOT_TRASHED });
  if (!agreement) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  if (agreement.status !== 'active') {
    throw new AppError('INVALID_TRANSITION', `Cannot mark ${agreement.status} as in-arrears`, 409);
  }
  agreement.status = 'in-arrears';
  agreement.arrearsAt = new Date();
  await agreement.save();
  await audit({
    actorId: actor.sub,
    action: 'hp.agreement.arrears',
    entityType: 'hp-agreement',
    entityId: agreementId,
    ...(requestId !== undefined ? { requestId } : {}),
  });
  const customer = await CustomerModel.findById(agreement.customerId);
  if (customer) {
    await enqueueSms({
      to: customer.phone,
      template: 'hp-arrears-warning',
      message:
        `Yadah: your hire purchase payment for ${agreement.itemSnapshot.name} is overdue. ` +
        `Please visit the office to avoid repossession.`,
      relatedEntityType: 'hp-agreement',
      relatedEntityId: agreementId,
    });
  }
  emitAdminEvent('hp.arrears', {
    id: agreementId.toHexString(),
    item: agreement.itemSnapshot.name,
  });
  return toPublicAgreement(agreement);
}

export async function repossess(
  actor: AccessTokenPayload,
  agreementId: Types.ObjectId,
  reason: string,
  requestId?: string,
): Promise<PublicHpAgreement> {
  const agreement = await HpAgreementModel.findOne({ _id: agreementId, ...NOT_TRASHED });
  if (!agreement) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  if (agreement.status !== 'active' && agreement.status !== 'in-arrears') {
    throw new AppError(
      'INVALID_TRANSITION',
      `Cannot repossess a ${agreement.status} agreement`,
      409,
    );
  }
  const now = new Date();
  const redemptionDeadline = addMonthsClamped(now, HP_REDEMPTION_WINDOW_MONTHS);
  agreement.status = 'repossessed';
  agreement.repossessedAt = now;
  agreement.repossessionReason = reason;
  agreement.redemptionDeadline = redemptionDeadline;
  await agreement.save();
  await audit({
    actorId: actor.sub,
    action: 'hp.agreement.repossess',
    entityType: 'hp-agreement',
    entityId: agreementId,
    amountBefore: agreement.totalPaid,
    amountAfter: agreement.totalPaid, // payments are KEPT (HP guide)
    after: { reason, redemptionDeadline: redemptionDeadline.toISOString() },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  const customer = await CustomerModel.findById(agreement.customerId);
  if (customer) {
    await enqueueSms({
      to: customer.phone,
      template: 'hp-repossessed',
      message:
        `Yadah: ${agreement.itemSnapshot.name} has been repossessed. You may redeem it by paying ` +
        `the full remaining balance at the office before ${redemptionDeadline.toISOString().slice(0, 10)}.`,
      relatedEntityType: 'hp-agreement',
      relatedEntityId: agreementId,
    });
  }
  emitAdminEvent('hp.repossessed', {
    id: agreementId.toHexString(),
    item: agreement.itemSnapshot.name,
    redemptionDeadline,
  });
  return toPublicAgreement(agreement);
}

export interface ForfeitRestock {
  name?: string | undefined;
  description?: string | undefined;
  costPrice: number;
  sellingPrice: number;
}

export async function forfeit(
  actor: AccessTokenPayload,
  agreementId: Types.ObjectId,
  restock?: ForfeitRestock,
  requestId?: string,
): Promise<{ agreement: PublicHpAgreement; restockedItem?: PublicHpItem }> {
  const agreement = await HpAgreementModel.findOne({ _id: agreementId, ...NOT_TRASHED });
  if (!agreement) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  if (agreement.status !== 'repossessed') {
    throw new AppError('INVALID_TRANSITION', `Cannot forfeit a ${agreement.status} agreement`, 409);
  }
  if (!agreement.redemptionDeadline || Date.now() <= agreement.redemptionDeadline.getTime()) {
    throw new AppError(
      'REDEMPTION_WINDOW_OPEN',
      'The 1-month redemption window has not lapsed yet',
      422,
      { redemptionDeadline: agreement.redemptionDeadline },
    );
  }
  if (restock) validatePricing(restock.costPrice, restock.sellingPrice);

  const session = await mongoose.startSession();
  let restockedItem: PublicHpItem | undefined;
  try {
    await session.withTransaction(async () => {
      const upd = await HpAgreementModel.updateOne(
        { _id: agreementId, status: 'repossessed' },
        { $set: { status: 'closed-forfeited', closedAt: new Date() } },
        { session },
      );
      if (upd.modifiedCount !== 1) throw new AppError('CONFLICT', 'Agreement changed — retry', 409);

      // Client-confirmed: forfeited items go back on the shelf as USED at a
      // new office-set price.
      if (restock) {
        const [created] = await HpItemModel.create(
          [
            {
              name: restock.name ?? `${agreement.itemSnapshot.name} (used)`,
              ...(restock.description !== undefined ? { description: restock.description } : {}),
              quantityInStock: 1,
              costPrice: restock.costPrice,
              sellingPrice: restock.sellingPrice,
              condition: 'used',
              createdById: new Types.ObjectId(actor.sub),
            },
          ],
          { session },
        );
        restockedItem = toPublicItem(created as HpItem);
      }

      await audit(
        {
          actorId: actor.sub,
          action: 'hp.agreement.forfeit',
          entityType: 'hp-agreement',
          entityId: agreementId,
          amountBefore: agreement.totalPaid,
          amountAfter: agreement.totalPaid, // forfeited to Yadah for good (HP guide)
          after: { restocked: restock !== undefined },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const after = await HpAgreementModel.findById(agreementId);
  if (!after) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  emitAdminEvent('hp.forfeited', {
    id: agreementId.toHexString(),
    item: after.itemSnapshot.name,
  });
  return {
    agreement: toPublicAgreement(after),
    ...(restockedItem ? { restockedItem } : {}),
  };
}

// ---------------------------------------------------------------- listing

export async function listAgreements(
  query: ListAgreementsQuery,
): Promise<{ items: PublicHpAgreement[]; page: number; limit: number; total: number }> {
  const filter: Record<string, unknown> = { ...NOT_TRASHED };
  if (query.customerId) filter.customerId = query.customerId;
  if (query.status) filter.status = query.status;
  if (query.search !== undefined) {
    filter.customerId = { $in: await fuzzyCustomerIds(query.search) };
  }
  const agreementDateFilter = createdAtFilter(query.from, query.to);
  if (agreementDateFilter) filter.createdAt = agreementDateFilter;
  const [agreements, total] = await Promise.all([
    HpAgreementModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    HpAgreementModel.countDocuments(filter),
  ]);
  const unique = [...new Set(agreements.map((a) => a.customerId.toHexString()))];
  const customers = await CustomerModel.find({ _id: { $in: unique } }, { fullName: 1 });
  const names = new Map(customers.map((c) => [c._id.toHexString(), c.fullName]));
  return {
    items: agreements.map((a) => ({
      ...toPublicAgreement(a),
      customerName: names.get(a.customerId.toHexString()) ?? '',
    })),
    page: query.page,
    limit: query.limit,
    total,
  };
}

export async function getAgreement(agreementId: Types.ObjectId): Promise<{
  agreement: PublicHpAgreement;
  schedule: {
    installmentNumber: number;
    dueDate: Date;
    amountDue: number;
    amountPaid: number;
    status: string;
  }[];
  payments: { id: string; type: string; amount: number; recordedById: string; createdAt: Date }[];
}> {
  const agreement = await HpAgreementModel.findOne({ _id: agreementId, ...NOT_TRASHED });
  if (!agreement) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  const [schedule, payments] = await Promise.all([
    HpScheduleModel.find({ agreementId }).sort({ installmentNumber: 1 }),
    HpPaymentModel.find({ agreementId }).sort({ createdAt: -1 }),
  ]);
  return {
    agreement: toPublicAgreement(agreement),
    schedule: schedule.map((s) => ({
      installmentNumber: s.installmentNumber,
      dueDate: s.dueDate,
      amountDue: s.amountDue,
      amountPaid: s.amountPaid,
      status: s.status,
    })),
    payments: payments.map((p: HpPayment) => ({
      id: p._id.toHexString(),
      type: p.type,
      amount: p.amount,
      recordedById: p.recordedById.toHexString(),
      createdAt: p.createdAt,
    })),
  };
}

// ---------------------------------------------------------------- agreement trash

export interface TrashedHpAgreement extends PublicHpAgreement {
  deletedAt: Date;
  deletedById?: string;
  deleteReason?: string;
}

function toTrashedAgreement(a: HpAgreement): TrashedHpAgreement {
  return {
    ...toPublicAgreement(a),
    deletedAt: requireDeletedAt(a.deletedAt),
    ...(a.deletedById !== undefined ? { deletedById: a.deletedById.toHexString() } : {}),
    ...(a.deleteReason !== undefined ? { deleteReason: a.deleteReason } : {}),
  };
}

export async function trashHpAgreement(
  actor: AccessTokenPayload,
  agreementId: Types.ObjectId,
  reason: string | undefined,
  requestId?: string,
): Promise<TrashedHpAgreement> {
  const agreement = await HpAgreementModel.findOne({ _id: agreementId, ...NOT_TRASHED });
  if (!agreement) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  const payments = await HpPaymentModel.countDocuments({ agreementId });
  if ((agreement.status !== 'pending' && agreement.status !== 'rejected') || payments > 0) {
    throw new AppError(
      'CANNOT_TRASH',
      'Only unpaid pending or rejected agreements can be moved to the trash',
      422,
      { status: agreement.status, payments },
    );
  }
  const trashSet = {
    deletedAt: new Date(),
    deletedById: new Types.ObjectId(actor.sub),
    ...(reason !== undefined ? { deleteReason: reason } : {}),
  };

  if (agreement.status === 'pending') {
    // Stock decremented at signing and the item never left the shop —
    // restock atomically with the trashing (mirrors reject).
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const upd = await HpAgreementModel.updateOne(
          { _id: agreementId, status: 'pending', ...NOT_TRASHED },
          { $set: trashSet },
          { session },
        );
        if (upd.modifiedCount !== 1) {
          throw new AppError('CONFLICT', 'Agreement changed concurrently — retry', 409);
        }
        await HpItemModel.updateOne(
          { _id: agreement.itemId },
          { $inc: { quantityInStock: 1 } },
          { session },
        );
        await audit(
          {
            actorId: actor.sub,
            action: 'hp.agreement.trash',
            entityType: 'hp-agreement',
            entityId: agreementId,
            before: { status: agreement.status, deletedAt: null },
            after: {
              status: agreement.status,
              deletedAt: trashSet.deletedAt,
              stockRestored: true,
              ...(reason !== undefined ? { reason } : {}),
            },
            ...(requestId !== undefined ? { requestId } : {}),
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
  } else {
    // Rejected agreements already restocked at rejection — plain write.
    const upd = await HpAgreementModel.updateOne(
      { _id: agreementId, status: 'rejected', ...NOT_TRASHED },
      { $set: trashSet },
    );
    if (upd.modifiedCount !== 1) {
      throw new AppError('CONFLICT', 'Agreement changed concurrently — retry', 409);
    }
    await audit({
      actorId: actor.sub,
      action: 'hp.agreement.trash',
      entityType: 'hp-agreement',
      entityId: agreementId,
      before: { status: agreement.status, deletedAt: null },
      after: {
        status: agreement.status,
        deletedAt: trashSet.deletedAt,
        ...(reason !== undefined ? { reason } : {}),
      },
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }

  const after = await HpAgreementModel.findById(agreementId);
  if (!after) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  emitAdminEvent('hp.agreement.trashed', {
    id: agreementId.toHexString(),
    customerId: agreement.customerId.toHexString(),
    item: agreement.itemSnapshot.name,
    status: agreement.status,
  });
  return toTrashedAgreement(after);
}

export async function restoreHpAgreement(
  actor: AccessTokenPayload,
  agreementId: Types.ObjectId,
  requestId?: string,
): Promise<PublicHpAgreement> {
  const agreement = await HpAgreementModel.findById(agreementId);
  if (!agreement) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  if (!agreement.deletedAt) {
    throw new AppError('NOT_TRASHED', 'Agreement is not in the trash', 409);
  }

  if (agreement.status === 'pending') {
    // A pending agreement holds a unit of the item — re-reserve it with the
    // same stock guard as signing.
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const stockUpd = await HpItemModel.updateOne(
          { _id: agreement.itemId, quantityInStock: { $gte: 1 } },
          { $inc: { quantityInStock: -1 } },
          { session },
        );
        if (stockUpd.modifiedCount !== 1) {
          throw new AppError(
            'OUT_OF_STOCK',
            'Item is out of stock — cannot restore the agreement',
            422,
          );
        }
        const upd = await HpAgreementModel.updateOne(
          { _id: agreementId, deletedAt: { $ne: null } },
          { $set: { deletedAt: null }, $unset: { deletedById: '', deleteReason: '' } },
          { session },
        );
        if (upd.modifiedCount !== 1) {
          throw new AppError('CONFLICT', 'Agreement changed concurrently — retry', 409);
        }
        await audit(
          {
            actorId: actor.sub,
            action: 'hp.agreement.restore',
            entityType: 'hp-agreement',
            entityId: agreementId,
            before: { status: agreement.status, deletedAt: agreement.deletedAt },
            after: { status: agreement.status, deletedAt: null, stockReserved: true },
            ...(requestId !== undefined ? { requestId } : {}),
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
  } else {
    const upd = await HpAgreementModel.updateOne(
      { _id: agreementId, deletedAt: { $ne: null } },
      { $set: { deletedAt: null }, $unset: { deletedById: '', deleteReason: '' } },
    );
    if (upd.modifiedCount !== 1) {
      throw new AppError('NOT_TRASHED', 'Agreement is not in the trash', 409);
    }
    await audit({
      actorId: actor.sub,
      action: 'hp.agreement.restore',
      entityType: 'hp-agreement',
      entityId: agreementId,
      before: { status: agreement.status, deletedAt: agreement.deletedAt },
      after: { status: agreement.status, deletedAt: null },
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }

  const after = await HpAgreementModel.findById(agreementId);
  if (!after) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  emitAdminEvent('hp.agreement.restored', {
    id: agreementId.toHexString(),
    customerId: agreement.customerId.toHexString(),
    item: agreement.itemSnapshot.name,
  });
  return toPublicAgreement(after);
}

export async function listHpAgreementTrash(
  query: TrashListQuery,
): Promise<{ items: TrashedHpAgreement[]; page: number; limit: number; total: number }> {
  const filter = { deletedAt: { $ne: null } };
  const [agreements, total] = await Promise.all([
    HpAgreementModel.find(filter)
      .sort({ deletedAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    HpAgreementModel.countDocuments(filter),
  ]);
  const unique = [...new Set(agreements.map((a) => a.customerId.toHexString()))];
  const customers = await CustomerModel.find({ _id: { $in: unique } }, { fullName: 1 });
  const names = new Map(customers.map((c) => [c._id.toHexString(), c.fullName]));
  return {
    items: agreements.map((a) => ({
      ...toTrashedAgreement(a),
      customerName: names.get(a.customerId.toHexString()) ?? '',
    })),
    page: query.page,
    limit: query.limit,
    total,
  };
}

// ---------------------------------------------------------------- outright sales

export interface PublicHpSaleLine {
  itemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  listPrice: number;
  lineTotal: number;
}

export interface PublicHpSale {
  id: string;
  receiptNo: string;
  customerId: string | null;
  buyerName: string;
  buyerPhone?: string;
  lines: PublicHpSaleLine[];
  subtotal: number;
  discount: number;
  total: number;
  channel: string;
  soldById: string;
  status: 'completed' | 'voided';
  voidedAt?: Date;
  voidReason?: string;
  createdAt: Date;
}

/** Cost and profit are internal — never in a customer-facing response. */
export function toPublicSale(sale: HpSale): PublicHpSale {
  return {
    id: sale._id.toHexString(),
    receiptNo: receiptNumber('SALE', sale._id),
    customerId: sale.customerId ? sale.customerId.toHexString() : null,
    buyerName: sale.buyerName,
    ...(sale.buyerPhone !== undefined ? { buyerPhone: sale.buyerPhone } : {}),
    lines: sale.lines.map((l) => ({
      itemId: l.itemId.toHexString(),
      name: l.name,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      listPrice: l.listPrice,
      lineTotal: l.lineTotal,
    })),
    subtotal: sale.subtotal,
    discount: sale.discount,
    total: sale.total,
    channel: sale.channel,
    soldById: sale.soldById.toHexString(),
    status: sale.status,
    ...(sale.voidedAt !== undefined ? { voidedAt: sale.voidedAt } : {}),
    ...(sale.voidReason !== undefined ? { voidReason: sale.voidReason } : {}),
    createdAt: sale.createdAt,
  };
}

/** Office-facing row: profit is included here, and only here. */
export function toSaleExportRow(sale: HpSale): Record<string, unknown> {
  return {
    id: sale._id.toHexString(),
    receiptNo: receiptNumber('SALE', sale._id),
    soldAt: sale.createdAt,
    buyerName: sale.buyerName,
    buyerPhone: sale.buyerPhone ?? '',
    registeredCustomer: sale.customerId ? 'yes' : 'no',
    items: sale.lines.map((l) => `${l.name} x${String(l.quantity)}`).join('; '),
    subtotal: sale.subtotal,
    discount: sale.discount,
    total: sale.total,
    totalCost: sale.totalCost,
    profit: sale.profit,
    channel: sale.channel,
    status: sale.status,
  };
}

export interface SaleResult {
  sale: PublicHpSale;
  /** True when this response replays an earlier identical request. */
  replayed: boolean;
}

/**
 * Record an outright counter sale: stock out, money in, done. No agreement,
 * no deposit, no instalments — this is the customer who simply buys the thing
 * (client request 2026-08-21).
 *
 * The buyer need not be a registered customer. Where they are, their record is
 * the source of truth for the name; a walk-in is recorded by name alone.
 */
export async function recordSale(
  actor: AccessTokenPayload,
  body: RecordSaleBody,
  requestId?: string,
): Promise<SaleResult> {
  const existing = await HpSaleModel.findOne({ idempotencyKey: body.idempotencyKey });
  if (existing) return { sale: toPublicSale(existing), replayed: true };

  let buyerName = body.buyerName ?? '';
  let buyerPhone = body.buyerPhone;
  if (body.customerId) {
    const customer = await CustomerModel.findOne({ _id: body.customerId, ...NOT_TRASHED });
    if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
    buyerName = customer.fullName;
    buyerPhone = body.buyerPhone ?? customer.phone;
  }

  // Prices and stock are read before the transaction to give precise errors;
  // the decrement inside the transaction is still guarded, so a concurrent
  // sale of the last unit loses rather than overselling.
  const items = await HpItemModel.find({
    _id: { $in: body.lines.map((l) => l.itemId) },
    ...NOT_TRASHED,
  });
  const itemById = new Map(items.map((i) => [i._id.toHexString(), i]));

  const lines: HpSaleLine[] = [];
  for (const line of body.lines) {
    const item = itemById.get(line.itemId.toHexString());
    if (!item) {
      throw new AppError('ITEM_NOT_FOUND', 'One of the items does not exist', 404, {
        itemId: line.itemId.toHexString(),
      });
    }
    if (item.status !== 'active') {
      throw new AppError('ITEM_DISCONTINUED', `${item.name} is discontinued`, 422, {
        itemId: item._id.toHexString(),
      });
    }
    if (item.quantityInStock < line.quantity) {
      throw new AppError('INSUFFICIENT_STOCK', `Not enough ${item.name} in stock`, 422, {
        itemId: item._id.toHexString(),
        requested: line.quantity,
        quantityInStock: item.quantityInStock,
      });
    }
    const unitPrice = line.unitPrice ?? item.sellingPrice;
    lines.push({
      itemId: item._id,
      name: item.name,
      quantity: line.quantity,
      unitPrice,
      listPrice: item.sellingPrice,
      unitCost: item.costPrice,
      lineTotal: unitPrice * line.quantity,
    });
  }

  const subtotal = lines.reduce((sum, l) => sum + l.listPrice * l.quantity, 0);
  const total = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const totalCost = lines.reduce((sum, l) => sum + l.unitCost * l.quantity, 0);

  const session = await mongoose.startSession();
  let created!: HpSale;
  try {
    await session.withTransaction(async () => {
      for (const line of lines) {
        // Guarded on available stock, so two tills cannot sell the same unit.
        const upd = await HpItemModel.updateOne(
          { _id: line.itemId, quantityInStock: { $gte: line.quantity }, ...NOT_TRASHED },
          { $inc: { quantityInStock: -line.quantity } },
          { session },
        );
        if (upd.modifiedCount !== 1) {
          throw new AppError('INSUFFICIENT_STOCK', `${line.name} sold out while ringing up`, 409, {
            itemId: line.itemId.toHexString(),
          });
        }
      }

      const [sale] = await HpSaleModel.create(
        [
          {
            ...(body.customerId ? { customerId: body.customerId } : {}),
            buyerName,
            ...(buyerPhone !== undefined ? { buyerPhone } : {}),
            lines,
            subtotal,
            discount: subtotal - total,
            total,
            totalCost,
            profit: total - totalCost,
            channel: body.channel,
            soldById: new Types.ObjectId(actor.sub),
            idempotencyKey: body.idempotencyKey,
            status: 'completed',
          },
        ],
        { session },
      );
      if (!sale) throw new AppError('INTERNAL_ERROR', 'Sale was not written', 500);
      created = sale;

      await audit(
        {
          actorId: actor.sub,
          action: 'hp.sale.record',
          entityType: 'hp-sale',
          entityId: sale._id,
          amountBefore: 0,
          amountAfter: total,
          after: {
            buyerName,
            registeredCustomer: body.customerId ? body.customerId.toHexString() : null,
            lines: lines.map((l) => ({
              itemId: l.itemId.toHexString(),
              quantity: l.quantity,
              unitPrice: l.unitPrice,
            })),
            subtotal,
            discount: subtotal - total,
            total,
            profit: total - totalCost,
            channel: body.channel,
          },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  emitAdminEvent('hp.sale.recorded', {
    id: created._id.toHexString(),
    buyerName,
    total,
    items: lines.length,
  });
  return { sale: toPublicSale(created), replayed: false };
}

/**
 * Reverse a sale rung up in error: stock goes back and the sale stops counting
 * toward revenue, but the row stays — a ledger never forgets, it annotates.
 */
export async function voidSale(
  actor: AccessTokenPayload,
  saleId: Types.ObjectId,
  reason: string,
  requestId?: string,
): Promise<PublicHpSale> {
  const pre = await HpSaleModel.findById(saleId);
  if (!pre) throw new AppError('NOT_FOUND', 'Sale not found', 404);
  if (pre.status === 'voided') {
    throw new AppError('ALREADY_VOIDED', 'This sale has already been voided', 409);
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const upd = await HpSaleModel.updateOne(
        { _id: saleId, status: 'completed' },
        {
          $set: {
            status: 'voided',
            voidedAt: new Date(),
            voidedById: new Types.ObjectId(actor.sub),
            voidReason: reason,
          },
        },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('ALREADY_VOIDED', 'This sale has already been voided', 409);
      }

      for (const line of pre.lines) {
        await HpItemModel.updateOne(
          { _id: line.itemId },
          { $inc: { quantityInStock: line.quantity } },
          { session },
        );
      }

      await audit(
        {
          actorId: actor.sub,
          action: 'hp.sale.void',
          entityType: 'hp-sale',
          entityId: saleId,
          amountBefore: pre.total,
          amountAfter: 0,
          before: { status: 'completed', total: pre.total },
          after: {
            status: 'voided',
            reason,
            restocked: pre.lines.map((l) => ({
              itemId: l.itemId.toHexString(),
              quantity: l.quantity,
            })),
          },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const after = await HpSaleModel.findById(saleId);
  if (!after) throw new AppError('NOT_FOUND', 'Sale not found', 404);
  emitAdminEvent('hp.sale.voided', { id: saleId.toHexString(), total: pre.total, reason });
  return toPublicSale(after);
}

export interface SaleList {
  items: PublicHpSale[];
  page: number;
  limit: number;
  total: number;
  /** Across the whole filter, not just this page. Voided sales are excluded. */
  totals: { salesCount: number; revenue: number; profit: number };
}

function buildSaleFilter(query: ListSalesQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (query.customerId) filter.customerId = query.customerId;
  if (query.status) filter.status = query.status;
  // `null` matches both an explicit null and a missing field.
  if (query.walkInOnly === true) filter.customerId = null;
  if (query.search !== undefined) {
    filter.buyerName = { $regex: escapeRegex(query.search), $options: 'i' };
  }
  const dateFilter = createdAtFilter(query.from, query.to);
  if (dateFilter) filter.createdAt = dateFilter;
  return filter;
}

export async function listSales(query: ListSalesQuery): Promise<SaleList> {
  const filter = buildSaleFilter(query);

  const [rows, total, summary] = await Promise.all([
    HpSaleModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    HpSaleModel.countDocuments(filter),
    HpSaleModel.aggregate<{ salesCount: number; revenue: number; profit: number }>([
      { $match: { ...filter, status: 'completed' } },
      {
        $group: {
          _id: null,
          salesCount: { $sum: 1 },
          revenue: { $sum: '$total' },
          profit: { $sum: '$profit' },
        },
      },
    ]),
  ]);

  return {
    items: rows.map(toPublicSale),
    page: query.page,
    limit: query.limit,
    total,
    totals: {
      salesCount: summary[0]?.salesCount ?? 0,
      revenue: summary[0]?.revenue ?? 0,
      profit: summary[0]?.profit ?? 0,
    },
  };
}

/** Export rows carry cost and profit, so this is office-only by route. */
export async function listSalesForExport(
  query: ListSalesQuery,
): Promise<Record<string, unknown>[]> {
  const rows = await HpSaleModel.find(buildSaleFilter(query))
    .sort({ createdAt: -1 })
    .limit(EXPORT_MAX_ROWS);
  return rows.map(toSaleExportRow);
}

export async function getSale(saleId: Types.ObjectId): Promise<PublicHpSale> {
  const sale = await HpSaleModel.findById(saleId);
  if (!sale) throw new AppError('NOT_FOUND', 'Sale not found', 404);
  return toPublicSale(sale);
}

export interface SaleReceiptFile {
  buffer: Buffer;
  filename: string;
}

/** Counter receipt: one line per basket item, then the totals. */
export async function saleReceipt(saleId: Types.ObjectId): Promise<SaleReceiptFile> {
  const sale = await HpSaleModel.findById(saleId);
  if (!sale) throw new AppError('NOT_FOUND', 'Sale not found', 404);

  const lines: ReceiptLine[] = sale.lines.map((l) => ({
    label: `${l.name} x ${String(l.quantity)}`,
    value:
      l.unitPrice === l.listPrice
        ? formatGhs(l.lineTotal)
        : `${formatGhs(l.lineTotal)} (list ${formatGhs(l.listPrice * l.quantity)})`,
  }));
  if (sale.discount > 0) {
    lines.push({ label: 'Subtotal at list', value: formatGhs(sale.subtotal) });
    lines.push({ label: 'Discount', value: `less ${formatGhs(sale.discount)}` });
  }
  lines.push({ label: 'Total paid', value: formatGhs(sale.total), emphasis: true });
  lines.push({ label: 'Payment method', value: sale.channel });
  if (sale.status === 'voided') {
    lines.push({ label: 'VOIDED', value: sale.voidReason ?? 'Sale reversed', emphasis: true });
  }

  const staff = await UserModel.findById(sale.soldById).select('name');
  const receiptNo = receiptNumber('SALE', sale._id);
  const buffer = await buildReceiptPdf({
    receiptNo,
    kind: 'deposit', // money in, from the company's side
    title: 'Sales Receipt',
    customerName: sale.buyerName,
    ...(sale.buyerPhone !== undefined ? { customerPhone: sale.buyerPhone } : {}),
    // Outright sales have no account; say so rather than printing a blank.
    accountNumber: sale.customerId ? 'Registered customer' : 'Walk-in',
    amount: sale.total,
    lines,
    recordedByName: staff?.name ?? 'Yadah staff',
    at: sale.createdAt,
    reference: sale._id.toHexString(),
  });
  return { buffer, filename: `sale-${receiptNo}.pdf` };
}

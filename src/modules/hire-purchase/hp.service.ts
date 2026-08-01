import mongoose, { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { formatGhs } from '../../lib/money.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { enqueueSms } from '../../lib/sms.js';
import { fuzzyCustomerIds } from '../../lib/fuzzy.js';
import { addMonthsClamped } from '../../domain/loans.js';
import {
  HP_ELIGIBILITY_MIN_MONTHS,
  HP_REDEMPTION_WINDOW_MONTHS,
  computeDepositSplit,
  validatePricing,
} from '../../domain/hire-purchase.js';
import {
  CustomerModel,
  HpAgreementModel,
  HpConfigModel,
  HpItemModel,
  HpPaymentModel,
  LoanModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SusuAccountModel,
  SusuDepositModel,
  type HpAgreement,
  type HpItem,
  type HpPayment,
} from '../../models/index.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type { Channel } from '../../models/shared.js';
import type {
  CreateAgreementBody,
  CreateItemBody,
  ListAgreementsQuery,
  ListItemsQuery,
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
  status: string;
}

function toPublicItem(i: HpItem): PublicHpItem {
  return {
    id: i._id.toHexString(),
    name: i.name,
    ...(i.description !== undefined ? { description: i.description } : {}),
    quantityInStock: i.quantityInStock,
    costPrice: i.costPrice,
    sellingPrice: i.sellingPrice,
    status: i.status,
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
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.inStockOnly) filter.quantityInStock = { $gt: 0 };
  if (query.search !== undefined) {
    const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.name = { $regex: escaped, $options: 'i' };
  }
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
  const item = await HpItemModel.findById(id);
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
  const item = await HpItemModel.findById(id);
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
  const fresh = await HpItemModel.findById(id);
  if (!fresh) throw new AppError('NOT_FOUND', 'Item not found', 404);
  return toPublicItem(fresh);
}

// ---------------------------------------------------------------- config

export async function getHpConfig(): Promise<{
  interestRatePercent: number;
  interestMethod: string;
}> {
  const doc = await HpConfigModel.findOne().sort({ updatedAt: -1 });
  return {
    interestRatePercent: doc?.interestRatePercent ?? 0,
    interestMethod: 'PENDING_CLIENT_DECISION', // flat vs declining balance — Stage B
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
  const customer = await CustomerModel.findById(customerId);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);

  const [activeSusu, activeSavings, firstSusu, firstSavings, openLoan, openHp] = await Promise.all([
    SusuAccountModel.exists({ customerId, status: 'active' }),
    SavingsAccountModel.exists({ customerId, status: 'active' }),
    SusuDepositModel.findOne({ customerId }).sort({ createdAt: 1 }),
    SavingsTxnModel.findOne({ customerId }).sort({ createdAt: 1 }),
    LoanModel.exists({ customerId, status: { $in: OPEN_LOAN_STATUSES } }),
    HpAgreementModel.exists({ customerId, status: { $in: OPEN_HP_STATUSES } }),
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
  const customer = await CustomerModel.findById(body.customerId);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);

  const item = await HpItemModel.findById(body.itemId);
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

  const pre = await HpAgreementModel.findById(agreementId);
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

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const upd = await HpAgreementModel.updateOne(
        { _id: agreementId, status: 'pending' },
        { $set: { status: 'active', itemReleasedAt: new Date() }, $inc: { totalPaid: amount } },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Agreement changed concurrently — retry', 409);
      }
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
          after: { itemReleased: true },
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
    await enqueueSms({
      to: customer.phone,
      template: 'hp-deposit-receipt',
      message:
        `Yadah: deposit of ${formatGhs(amount)} received for ${after.itemSnapshot.name}. ` +
        `Item released. Balance: ${formatGhs(after.financedAmount)} over ${String(after.durationMonths)} months.`,
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
  const pre = await HpAgreementModel.findById(agreementId);
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

// ---------------------------------------------------------------- manual state transitions
// Automation of the arrears trigger (installment ≥1 month overdue) arrives in
// Stage B with schedules; the transitions themselves are office actions.

export async function markArrears(
  actor: AccessTokenPayload,
  agreementId: Types.ObjectId,
  requestId?: string,
): Promise<PublicHpAgreement> {
  const agreement = await HpAgreementModel.findById(agreementId);
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
  const agreement = await HpAgreementModel.findById(agreementId);
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

export async function forfeit(
  actor: AccessTokenPayload,
  agreementId: Types.ObjectId,
  requestId?: string,
): Promise<PublicHpAgreement> {
  const agreement = await HpAgreementModel.findById(agreementId);
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
  agreement.status = 'closed-forfeited';
  agreement.closedAt = new Date();
  await agreement.save();
  await audit({
    actorId: actor.sub,
    action: 'hp.agreement.forfeit',
    entityType: 'hp-agreement',
    entityId: agreementId,
    amountBefore: agreement.totalPaid,
    amountAfter: agreement.totalPaid, // forfeited to Yadah for good (HP guide)
    ...(requestId !== undefined ? { requestId } : {}),
  });
  emitAdminEvent('hp.forfeited', {
    id: agreementId.toHexString(),
    item: agreement.itemSnapshot.name,
  });
  return toPublicAgreement(agreement);
}

// ---------------------------------------------------------------- listing

export async function listAgreements(
  query: ListAgreementsQuery,
): Promise<{ items: PublicHpAgreement[]; page: number; limit: number; total: number }> {
  const filter: Record<string, unknown> = {};
  if (query.customerId) filter.customerId = query.customerId;
  if (query.status) filter.status = query.status;
  if (query.search !== undefined) {
    filter.customerId = { $in: await fuzzyCustomerIds(query.search) };
  }
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
  payments: { id: string; type: string; amount: number; recordedById: string; createdAt: Date }[];
}> {
  const agreement = await HpAgreementModel.findById(agreementId);
  if (!agreement) throw new AppError('NOT_FOUND', 'Agreement not found', 404);
  const payments = await HpPaymentModel.find({ agreementId }).sort({ createdAt: -1 });
  return {
    agreement: toPublicAgreement(agreement),
    payments: payments.map((p: HpPayment) => ({
      id: p._id.toHexString(),
      type: p.type,
      amount: p.amount,
      recordedById: p.recordedById.toHexString(),
      createdAt: p.createdAt,
    })),
  };
}

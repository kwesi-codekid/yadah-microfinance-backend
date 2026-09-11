import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { escapeRegex } from '../../lib/fuzzy.js';
import { accraDay } from '../../lib/time.js';
import { ExpenseModel, UserModel, type Expense, type ExpenseCategory } from '../../models/index.js';
import { NOT_TRASHED, requireDeletedAt } from '../../models/shared.js';
import { getAccountOrThrow } from '../accounting/cash.service.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type {
  AttachReceiptBody,
  CreateExpenseBody,
  ExpenseSummaryQuery,
  ListExpensesQuery,
  PayExpenseBody,
  TrashListQuery,
  UpdateExpenseBody,
} from './expenses.schemas.js';

/**
 * Money the business spends on itself: recorded → approved → paid.
 *
 * Only PAYMENT touches cash. An approved-but-unpaid expense is a liability on
 * the balance sheet, which is what stops the cash position drifting away from
 * the drawer. Editing is allowed only while pending — once someone has
 * approved an amount, changing it behind them would make the approval
 * meaningless.
 *
 * Recording is counter work: petty cash is spent by whoever is at the counter,
 * and a book only the office can reach is a book that gets written up days
 * late from a pocketful of receipts. Deciding and paying stay with the office,
 * and nobody approves their own spending.
 *
 * This is its own module rather than part of accounting because the two are
 * used by different people at different times — the counter records an expense
 * the moment it happens; the accounting statements are read at month end. The
 * balance sheet still reads `expensesByCategory` and `accruedExpenses` from
 * here, which are the only two functions it needs.
 */

export interface PublicExpense {
  id: string;
  category: string;
  description: string;
  amount: number;
  payee?: string;
  incurredOn: string;
  status: string;
  cashAccountId?: string;
  paidOn?: string;
  recordedById: string;
  recordedByName?: string;
  approvedById?: string;
  approvedByName?: string;
  approvedAt?: Date;
  rejectionReason?: string;
  receiptUrl?: string;
  reference?: string;
  writeOffEntityType?: string;
  writeOffEntityId?: string;
  createdAt: Date;
}

export function toPublicExpense(e: Expense, names?: Map<string, string>): PublicExpense {
  const recordedById = e.recordedById.toHexString();
  const approvedById = e.approvedById?.toHexString();
  const recordedByName = names?.get(recordedById);
  const approvedByName = approvedById === undefined ? undefined : names?.get(approvedById);
  return {
    id: e._id.toHexString(),
    category: e.category,
    description: e.description,
    amount: e.amount,
    ...(e.payee !== undefined ? { payee: e.payee } : {}),
    incurredOn: e.incurredOn,
    status: e.status,
    ...(e.cashAccountId !== undefined ? { cashAccountId: e.cashAccountId.toHexString() } : {}),
    ...(e.paidOn !== undefined ? { paidOn: e.paidOn } : {}),
    recordedById,
    ...(recordedByName !== undefined ? { recordedByName } : {}),
    ...(approvedById !== undefined ? { approvedById } : {}),
    ...(approvedByName !== undefined ? { approvedByName } : {}),
    ...(e.approvedAt !== undefined ? { approvedAt: e.approvedAt } : {}),
    ...(e.rejectionReason !== undefined ? { rejectionReason: e.rejectionReason } : {}),
    ...(e.receiptUrl !== undefined ? { receiptUrl: e.receiptUrl } : {}),
    ...(e.reference !== undefined ? { reference: e.reference } : {}),
    ...(e.writeOffEntityType !== undefined ? { writeOffEntityType: e.writeOffEntityType } : {}),
    ...(e.writeOffEntityId !== undefined
      ? { writeOffEntityId: e.writeOffEntityId.toHexString() }
      : {}),
    createdAt: e.createdAt,
  };
}

async function withNames(expenses: Expense[]): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const e of expenses) {
    ids.add(e.recordedById.toHexString());
    if (e.approvedById) ids.add(e.approvedById.toHexString());
  }
  const users = await UserModel.find({ _id: { $in: [...ids] } }, { name: 1 });
  return new Map(users.map((u) => [u._id.toHexString(), u.name]));
}

export async function recordExpense(
  actor: AccessTokenPayload,
  body: CreateExpenseBody,
  requestId?: string,
): Promise<PublicExpense> {
  const expense = await ExpenseModel.create({
    category: body.category,
    description: body.description,
    amount: body.amount,
    incurredOn: body.incurredOn,
    ...(body.payee !== undefined ? { payee: body.payee } : {}),
    ...(body.receiptUrl !== undefined ? { receiptUrl: body.receiptUrl } : {}),
    ...(body.reference !== undefined ? { reference: body.reference } : {}),
    ...(body.writeOffEntityType !== undefined
      ? { writeOffEntityType: body.writeOffEntityType }
      : {}),
    ...(body.writeOffEntityId !== undefined ? { writeOffEntityId: body.writeOffEntityId } : {}),
    recordedById: new Types.ObjectId(actor.sub),
  });

  await audit({
    actorId: actor.sub,
    action: 'expense.record',
    entityType: 'expense',
    entityId: expense._id,
    amountAfter: body.amount,
    after: { category: body.category, amount: body.amount, description: body.description },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicExpense(expense, await withNames([expense]));
}

async function loadPending(id: Types.ObjectId) {
  const expense = await ExpenseModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!expense) throw new AppError('NOT_FOUND', 'Expense not found', 404);
  if (expense.status !== 'pending') {
    throw new AppError(
      'NOT_PENDING',
      `This expense is already ${expense.status} and can no longer be changed`,
      409,
    );
  }
  return expense;
}

/** Editable only while pending — see the note at the top of this file. */
export async function updateExpense(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  body: UpdateExpenseBody,
  requestId?: string,
): Promise<PublicExpense> {
  const expense = await loadPending(id);
  const before = { amount: expense.amount, category: expense.category };
  Object.assign(expense, body);
  await expense.save();

  await audit({
    actorId: actor.sub,
    action: 'expense.update',
    entityType: 'expense',
    entityId: expense._id,
    amountBefore: before.amount,
    amountAfter: expense.amount,
    before,
    after: { amount: expense.amount, category: expense.category },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicExpense(expense, await withNames([expense]));
}

export async function approveExpense(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  requestId?: string,
): Promise<PublicExpense> {
  const expense = await loadPending(id);
  // Approving your own spending defeats the point of an approval step.
  if (expense.recordedById.toHexString() === actor.sub) {
    throw new AppError(
      'SELF_APPROVAL',
      'An expense must be approved by someone other than the person who recorded it',
      403,
    );
  }

  expense.status = 'approved';
  expense.approvedById = new Types.ObjectId(actor.sub);
  expense.approvedAt = new Date();
  await expense.save();

  await audit({
    actorId: actor.sub,
    action: 'expense.approve',
    entityType: 'expense',
    entityId: expense._id,
    amountAfter: expense.amount,
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicExpense(expense, await withNames([expense]));
}

export async function rejectExpense(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  reason: string,
  requestId?: string,
): Promise<PublicExpense> {
  const expense = await loadPending(id);
  expense.status = 'rejected';
  expense.rejectionReason = reason;
  expense.approvedById = new Types.ObjectId(actor.sub);
  expense.approvedAt = new Date();
  await expense.save();

  await audit({
    actorId: actor.sub,
    action: 'expense.reject',
    entityType: 'expense',
    entityId: expense._id,
    after: { reason },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicExpense(expense, await withNames([expense]));
}

/**
 * Pay an approved expense from a named account. This is the only step that
 * moves money, so it is the only one that names an account.
 */
export async function payExpense(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  body: PayExpenseBody,
  requestId?: string,
): Promise<PublicExpense> {
  const expense = await ExpenseModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!expense) throw new AppError('NOT_FOUND', 'Expense not found', 404);
  if (expense.status === 'paid') {
    throw new AppError('ALREADY_PAID', 'This expense has already been paid', 409);
  }
  if (expense.status !== 'approved') {
    throw new AppError(
      'NOT_APPROVED',
      `Only an approved expense can be paid — this one is ${expense.status}`,
      422,
    );
  }

  const account = await getAccountOrThrow(body.cashAccountId);
  const paidOn = body.paidOn ?? accraDay();
  if (paidOn < accraDay(account.openingDate)) {
    throw new AppError(
      'BEFORE_OPENING_DATE',
      `That account's records start on ${accraDay(account.openingDate)} — a payment before then would not reach its balance`,
      422,
    );
  }

  expense.status = 'paid';
  expense.cashAccountId = account._id;
  expense.paidOn = paidOn;
  expense.paidById = new Types.ObjectId(actor.sub);
  await expense.save();

  await audit({
    actorId: actor.sub,
    action: 'expense.pay',
    entityType: 'expense',
    entityId: expense._id,
    amountAfter: expense.amount,
    after: { cashAccountId: account._id.toHexString(), paidOn },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicExpense(expense, await withNames([expense]));
}

export interface ExpenseList {
  items: PublicExpense[];
  page: number;
  limit: number;
  total: number;
  /** Total amount matching the filters across ALL pages, not just this one. */
  totalAmount: number;
}

export async function listExpenses(query: ListExpensesQuery): Promise<ExpenseList> {
  const filter: Record<string, unknown> = { ...NOT_TRASHED };
  if (query.category) filter.category = query.category;
  if (query.status) filter.status = query.status;
  if (query.cashAccountId) filter.cashAccountId = query.cashAccountId;
  if (query.from || query.to) {
    filter.incurredOn = {
      ...(query.from ? { $gte: query.from } : {}),
      ...(query.to ? { $lte: query.to } : {}),
    };
  }
  if (query.search) {
    const rx = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [{ description: rx }, { payee: rx }, { reference: rx }];
  }

  const [items, total, sum] = await Promise.all([
    ExpenseModel.find(filter)
      .sort({ incurredOn: -1, createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    ExpenseModel.countDocuments(filter),
    ExpenseModel.aggregate<{ amount: number }>([
      { $match: filter },
      { $group: { _id: null, amount: { $sum: '$amount' } } },
    ]),
  ]);

  const names = await withNames(items);
  return {
    items: items.map((e) => toPublicExpense(e, names)),
    page: query.page,
    limit: query.limit,
    total,
    totalAmount: sum[0]?.amount ?? 0,
  };
}

export interface CategoryTotal {
  category: string;
  count: number;
  amount: number;
}

/**
 * Expenses by category over a period, for the profit and loss statement.
 *
 * Counts expenses by the day the COST belongs to (`incurredOn`), not the day
 * they were paid — August salaries settled in September are an August cost.
 * Rejected expenses are excluded; pending ones are included, because a cost
 * the business has incurred does not stop existing while it awaits approval.
 */
export async function expensesByCategory(from: string, to: string): Promise<CategoryTotal[]> {
  const rows = await ExpenseModel.aggregate<{ _id: string; count: number; amount: number }>([
    {
      $match: {
        incurredOn: { $gte: from, $lte: to },
        status: { $ne: 'rejected' },
        ...NOT_TRASHED,
      },
    },
    { $group: { _id: '$category', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    { $sort: { amount: -1 } },
  ]);
  return rows.map((r) => ({ category: r._id, count: r.count, amount: r.amount }));
}

/**
 * Incurred but not yet paid — a liability the business still owes.
 *
 * Counts PENDING as well as approved, and must stay in step with
 * expensesByCategory above: that charges every non-rejected expense against
 * profit, so anything it charges and the cash has not yet paid has to appear
 * here or the balance sheet will not balance.
 */
export async function accruedExpenses(asOf: string): Promise<{ count: number; amount: number }> {
  const [row] = await ExpenseModel.aggregate<{ count: number; amount: number }>([
    {
      $match: {
        status: { $in: ['pending', 'approved'] },
        incurredOn: { $lte: asOf },
        ...NOT_TRASHED,
      },
    },
    { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
  ]);
  return { count: row?.count ?? 0, amount: row?.amount ?? 0 };
}

export function toExpenseExportRow(e: PublicExpense): Record<string, unknown> {
  return {
    date: e.incurredOn,
    category: e.category,
    description: e.description,
    payee: e.payee ?? '',
    amount: e.amount,
    status: e.status,
    paidOn: e.paidOn ?? '',
    recordedBy: e.recordedByName ?? '',
    approvedBy: e.approvedByName ?? '',
    reference: e.reference ?? '',
  };
}

// ---------------------------------------------------------------- one expense

export async function getExpense(id: Types.ObjectId): Promise<PublicExpense> {
  const expense = await ExpenseModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!expense) throw new AppError('NOT_FOUND', 'Expense not found', 404);
  return toPublicExpense(expense, await withNames([expense]));
}

/**
 * Attach or replace the receipt photograph.
 *
 * Separate from editing because it is allowed at any status: a receipt turning
 * up after an expense was approved is the ordinary case, and refusing it would
 * mean the record is worse for being on time.
 */
export async function attachReceipt(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  body: AttachReceiptBody,
  requestId?: string,
): Promise<PublicExpense> {
  const expense = await ExpenseModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!expense) throw new AppError('NOT_FOUND', 'Expense not found', 404);
  const before = expense.receiptUrl;
  expense.receiptUrl = body.receiptUrl;
  await expense.save();

  await audit({
    actorId: actor.sub,
    action: 'expense.attach-receipt',
    entityType: 'expense',
    entityId: expense._id,
    ...(before !== undefined ? { before: { receiptUrl: before } } : {}),
    after: { receiptUrl: body.receiptUrl },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicExpense(expense, await withNames([expense]));
}

// ---------------------------------------------------------------- summary

export interface ExpenseSummary {
  from: string | null;
  to: string | null;
  /** Every non-rejected expense in the period — what the business actually spent. */
  totalAmount: number;
  totalCount: number;
  byCategory: { category: ExpenseCategory; count: number; amount: number }[];
  /** Broken out so the office can see what is still waiting on them. */
  byStatus: { status: string; count: number; amount: number }[];
  /** Incurred but not yet paid, within the period. */
  outstandingAmount: number;
}

/**
 * What was spent in a period, by category and by status.
 *
 * Dated by `incurredOn` like the profit and loss, so the two agree: a cost
 * belongs to the month it was incurred, not the month somebody got round to
 * settling it. Rejected expenses are left out of the totals — they are not
 * costs — but kept in the status breakdown so the count still adds up.
 */
export async function expenseSummary(query: ExpenseSummaryQuery): Promise<ExpenseSummary> {
  const incurredOn =
    query.from !== undefined || query.to !== undefined
      ? {
          ...(query.from !== undefined ? { $gte: query.from } : {}),
          ...(query.to !== undefined ? { $lte: query.to } : {}),
        }
      : undefined;
  const match = { ...(incurredOn ? { incurredOn } : {}), ...NOT_TRASHED };

  const [byCategory, byStatus] = await Promise.all([
    ExpenseModel.aggregate<{ _id: ExpenseCategory; count: number; amount: number }>([
      { $match: { ...match, status: { $ne: 'rejected' } } },
      { $group: { _id: '$category', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
      { $sort: { amount: -1 } },
    ]),
    ExpenseModel.aggregate<{ _id: string; count: number; amount: number }>([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
  ]);

  const outstanding = byStatus
    .filter((s) => s._id === 'pending' || s._id === 'approved')
    .reduce((sum, s) => sum + s.amount, 0);

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    totalAmount: byCategory.reduce((sum, c) => sum + c.amount, 0),
    totalCount: byCategory.reduce((sum, c) => sum + c.count, 0),
    byCategory: byCategory.map((c) => ({
      category: c._id,
      count: c.count,
      amount: c.amount,
    })),
    byStatus: byStatus.map((s) => ({ status: s._id, count: s.count, amount: s.amount })),
    outstandingAmount: outstanding,
  };
}

// ---------------------------------------------------------------- trash

export interface TrashedExpense extends PublicExpense {
  deletedAt: Date;
  deletedById?: string;
  deleteReason?: string;
}

function toTrashedExpense(e: Expense, names?: Map<string, string>): TrashedExpense {
  return {
    ...toPublicExpense(e, names),
    deletedAt: requireDeletedAt(e.deletedAt),
    ...(e.deletedById !== undefined ? { deletedById: e.deletedById.toHexString() } : {}),
    ...(e.deleteReason !== undefined ? { deleteReason: e.deleteReason } : {}),
  };
}

/**
 * Bin an expense. Pending or rejected only.
 *
 * An approved expense is already a liability on the balance sheet and a paid
 * one has already moved cash; removing either would silently restate a period
 * that may have been read and acted on. The way to undo those is a correcting
 * entry, not a disappearance.
 */
export async function trashExpense(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  reason: string | undefined,
  requestId?: string,
): Promise<TrashedExpense> {
  const expense = await ExpenseModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!expense) throw new AppError('NOT_FOUND', 'Expense not found', 404);
  if (expense.status === 'approved' || expense.status === 'paid') {
    throw new AppError(
      'CANNOT_TRASH',
      `This expense is ${expense.status} and is already on the books — record a correcting entry instead`,
      422,
    );
  }

  expense.deletedAt = new Date();
  expense.deletedById = new Types.ObjectId(actor.sub);
  if (reason !== undefined) expense.deleteReason = reason;
  await expense.save();

  await audit({
    actorId: actor.sub,
    action: 'expense.trash',
    entityType: 'expense',
    entityId: id,
    before: { deletedAt: null },
    after: { deletedAt: expense.deletedAt, ...(reason !== undefined ? { reason } : {}) },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toTrashedExpense(expense, await withNames([expense]));
}

export async function restoreExpense(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  requestId?: string,
): Promise<PublicExpense> {
  const expense = await ExpenseModel.findById(id);
  if (!expense) throw new AppError('NOT_FOUND', 'Expense not found', 404);
  if (!expense.deletedAt) throw new AppError('NOT_TRASHED', 'Expense is not in the trash', 409);

  expense.deletedAt = null;
  expense.set('deletedById', undefined);
  expense.set('deleteReason', undefined);
  await expense.save();

  await audit({
    actorId: actor.sub,
    action: 'expense.restore',
    entityType: 'expense',
    entityId: id,
    after: { deletedAt: null },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicExpense(expense, await withNames([expense]));
}

export async function listExpenseTrash(
  query: TrashListQuery,
): Promise<{ items: TrashedExpense[]; page: number; limit: number; total: number }> {
  const filter = { deletedAt: { $ne: null } };
  const [items, total] = await Promise.all([
    ExpenseModel.find(filter)
      .sort({ deletedAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    ExpenseModel.countDocuments(filter),
  ]);
  const names = await withNames(items);
  return {
    items: items.map((e) => toTrashedExpense(e, names)),
    page: query.page,
    limit: query.limit,
    total,
  };
}

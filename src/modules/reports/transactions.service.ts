import { Types, type PipelineStage } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import {
  directionOf,
  moduleOf,
  TXN_MODULES,
  type TxnDirection,
  type TxnModule,
  type TxnType,
} from '../../domain/transactions.js';
import { susuBalance } from '../../domain/susu.js';
import {
  CustomerModel,
  HpAgreementModel,
  LoanModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SusuAccountModel,
  SusuDepositModel,
  UserModel,
} from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import { remainingOn } from '../hire-purchase/hp.service.js';
import { rangeToWindow } from './reports.service.js';
import type { TransactionsQuery } from './reports.schemas.js';

/** Automated debt-recovery moves are recorded by this well-known actor. */
const SYSTEM_ACTOR_HEX = '000000000000000000000000';
/**
 * Outright counter sales often have no registered customer. The feed row
 * shape requires one, so walk-ins are projected onto this well-known id and
 * rendered by name; the sale document itself stores no customerId at all.
 */
const WALK_IN_CUSTOMER_HEX = '000000000000000000000001';

/** Statements are bounded; a customer can't realistically exceed this. */
const STATEMENT_MAX_ROWS = 5000;
/** CSV exports skip pagination but are capped — documented in the OpenAPI spec. */
const CSV_MAX_ROWS = 10_000;

type RefKind =
  'susu-account' | 'savings-account' | 'loan' | 'hp-agreement' | 'hp-sale' | 'transfer';

/** The shape every $unionWith branch projects to. */
interface RawRow {
  _id: Types.ObjectId;
  type: TxnType;
  amount: number;
  fee?: number;
  customerId: Types.ObjectId;
  refId: Types.ObjectId;
  refKind: RefKind;
  channel?: string | null;
  detail?: string | null;
  recordedById?: Types.ObjectId | null;
  balanceAfter?: number;
  createdAt: Date;
}

export interface UnifiedTxnRow {
  id: string;
  module: TxnModule;
  type: TxnType;
  direction: TxnDirection;
  amount: number; // pesewas
  fee: number; // pesewas
  channel: string | null;
  /** Type-specific discriminator: payout destination, repayment source, transfer route. */
  detail: string | null;
  customerId: string;
  customerName: string;
  ref: { kind: RefKind; id: string; accountNumber?: string };
  /** Savings rows only: running balance after the transaction. */
  balanceAfter?: number;
  recordedById: string | null;
  recordedByName: string | null;
  createdAt: Date;
}

export interface TxnTotals {
  in: { count: number; amount: number };
  out: { count: number; amount: number };
  internal: { count: number; amount: number };
  /** Savings withdrawal/closure fees in the range (company revenue). */
  feesCollected: number;
}

// ---------------------------------------------------------------- union pipeline

interface Branch {
  coll: string;
  stages: (PipelineStage.Match | PipelineStage.Project)[];
}

/**
 * One branch per source collection, each filtered to the window and projected
 * to the RawRow shape. Loan disbursements have no transaction document, so
 * they are synthesized from loans matched on disbursedAt.
 */
function buildBranches(
  window: { start: Date; end: Date },
  customerId?: Types.ObjectId,
  modules?: TxnModule[],
): Branch[] {
  const createdAt = { $gte: window.start, $lt: window.end };
  const byCustomer = customerId ? { customerId } : {};
  const wanted = new Set<TxnModule>(modules ?? [...TXN_MODULES]);
  const branches: Branch[] = [];

  if (wanted.has('susu')) {
    branches.push(
      {
        coll: 'susu-deposits',
        stages: [
          { $match: { createdAt, ...byCustomer, ...NOT_TRASHED } },
          {
            $project: {
              type: { $literal: 'susu-deposit' },
              amount: 1,
              fee: { $literal: 0 },
              customerId: 1,
              refId: '$accountId',
              refKind: { $literal: 'susu-account' },
              channel: 1,
              detail: { $literal: null },
              recordedById: '$collectorId',
              createdAt: 1,
            },
          },
        ],
      },
      {
        coll: 'susu-payouts',
        stages: [
          { $match: { createdAt, ...byCustomer } },
          {
            $project: {
              // A partial withdrawal leaves the account open, so it reads as a
              // different event from the payout that ends one.
              type: {
                $cond: [{ $eq: ['$kind', 'partial-withdrawal'] }, 'susu-withdrawal', 'susu-payout'],
              },
              amount: 1,
              fee: { $literal: 0 },
              customerId: 1,
              refId: '$accountId',
              refKind: { $literal: 'susu-account' },
              channel: { $literal: null },
              detail: '$destination',
              recordedById: 1,
              createdAt: 1,
            },
          },
        ],
      },
    );
  }

  if (wanted.has('savings')) {
    branches.push({
      coll: 'savings-txns',
      stages: [
        { $match: { createdAt, ...byCustomer, ...NOT_TRASHED } },
        {
          $project: {
            type: { $concat: ['savings-', '$type'] },
            amount: 1,
            fee: { $ifNull: ['$fee', 0] },
            customerId: 1,
            refId: '$accountId',
            refKind: { $literal: 'savings-account' },
            channel: 1,
            detail: { $literal: null },
            recordedById: 1,
            balanceAfter: 1,
            createdAt: 1,
          },
        },
      ],
    });
  }

  if (wanted.has('loans')) {
    branches.push(
      {
        coll: 'loans',
        stages: [
          {
            $match: {
              disbursedAt: { $gte: window.start, $lt: window.end },
              ...byCustomer,
              ...NOT_TRASHED,
            },
          },
          {
            $project: {
              type: { $literal: 'loan-disbursement' },
              amount: '$principal',
              fee: { $literal: 0 },
              customerId: 1,
              refId: '$_id',
              refKind: { $literal: 'loan' },
              channel: { $literal: 'cash' },
              detail: { $literal: null },
              recordedById: '$approvedById',
              createdAt: '$disbursedAt',
            },
          },
        ],
      },
      {
        coll: 'repayments',
        stages: [
          { $match: { createdAt, ...byCustomer } },
          {
            $project: {
              type: { $literal: 'loan-repayment' },
              amount: 1,
              fee: { $literal: 0 },
              customerId: 1,
              refId: '$loanId',
              refKind: { $literal: 'loan' },
              channel: 1,
              detail: '$source',
              recordedById: 1,
              createdAt: 1,
            },
          },
        ],
      },
    );
  }

  if (wanted.has('hire-purchase')) {
    branches.push({
      coll: 'hp-payments',
      stages: [
        { $match: { createdAt, ...byCustomer } },
        {
          $project: {
            type: { $concat: ['hp-', '$type'] },
            amount: 1,
            fee: { $literal: 0 },
            customerId: 1,
            refId: '$agreementId',
            refKind: { $literal: 'hp-agreement' },
            channel: 1,
            detail: { $literal: null },
            recordedById: 1,
            createdAt: 1,
          },
        },
      ],
    });
  }

  if (wanted.has('hire-purchase')) {
    branches.push({
      coll: 'hp-sales',
      stages: [
        // Voided sales are excluded: the row stays in its own collection for
        // the audit trail, but it is no longer money the business took.
        { $match: { createdAt, status: 'completed', ...byCustomer } },
        {
          $project: {
            type: { $literal: 'hp-sale' },
            amount: '$total',
            fee: { $literal: 0 },
            customerId: {
              $ifNull: ['$customerId', new Types.ObjectId(WALK_IN_CUSTOMER_HEX)],
            },
            refId: '$_id',
            refKind: { $literal: 'hp-sale' },
            channel: 1,
            detail: '$buyerName',
            recordedById: '$soldById',
            createdAt: 1,
          },
        },
      ],
    });
  }

  if (wanted.has('transfers')) {
    branches.push({
      coll: 'transfers',
      stages: [
        { $match: { createdAt, ...byCustomer } },
        {
          $project: {
            type: { $literal: 'transfer' },
            amount: '$amountMoved',
            fee: 1,
            customerId: 1,
            refId: '$_id',
            refKind: { $literal: 'transfer' },
            channel: { $literal: null },
            detail: { $concat: ['$fromType', '->', '$toType'] },
            recordedById: 1,
            createdAt: 1,
          },
        },
      ],
    });
  }

  return branches;
}

/**
 * Base the aggregation on a guaranteed-empty match, then union in every
 * branch (including susu-deposits itself) so all sources go through one
 * uniform code path regardless of which modules are selected.
 */
function unionStages(branches: Branch[]): PipelineStage[] {
  return [
    { $match: { _id: new Types.ObjectId(SYSTEM_ACTOR_HEX) } },
    ...branches.map((b): PipelineStage => ({ $unionWith: { coll: b.coll, pipeline: b.stages } })),
  ];
}

// ---------------------------------------------------------------- row resolution

/** Batch-resolve customer names, staff names, and account numbers for a page of rows. */
async function resolveRows(raw: RawRow[]): Promise<UnifiedTxnRow[]> {
  const customerIds = new Set<string>();
  const userIds = new Set<string>();
  const susuIds = new Set<string>();
  const savingsIds = new Set<string>();
  for (const r of raw) {
    customerIds.add(r.customerId.toHexString());
    if (r.recordedById) userIds.add(r.recordedById.toHexString());
    if (r.refKind === 'susu-account') susuIds.add(r.refId.toHexString());
    if (r.refKind === 'savings-account') savingsIds.add(r.refId.toHexString());
  }

  const [customers, users, susuAccounts, savingsAccounts] = await Promise.all([
    CustomerModel.find({ _id: { $in: [...customerIds] } }, { fullName: 1 }),
    UserModel.find({ _id: { $in: [...userIds] } }, { name: 1 }),
    SusuAccountModel.find({ _id: { $in: [...susuIds] } }, { accountNumber: 1 }),
    SavingsAccountModel.find({ _id: { $in: [...savingsIds] } }, { accountNumber: 1 }),
  ]);
  const customerNames = new Map(customers.map((c) => [c._id.toHexString(), c.fullName]));
  const userNames = new Map(users.map((u) => [u._id.toHexString(), u.name]));
  const accountNumbers = new Map(
    [...susuAccounts, ...savingsAccounts].map((a) => [a._id.toHexString(), a.accountNumber]),
  );

  return raw.map((r) => {
    const channel = r.channel ?? null;
    const detail = r.detail ?? null;
    const recordedById = r.recordedById?.toHexString() ?? null;
    const accountNumber = accountNumbers.get(r.refId.toHexString());
    return {
      id: r._id.toHexString(),
      module: moduleOf(r.type),
      type: r.type,
      direction: directionOf(r.type, channel, detail),
      amount: r.amount,
      fee: r.fee ?? 0,
      channel,
      detail,
      customerId: r.customerId.toHexString(),
      customerName:
        r.customerId.toHexString() === WALK_IN_CUSTOMER_HEX
          ? 'Walk-in customer'
          : (customerNames.get(r.customerId.toHexString()) ?? ''),
      ref: {
        kind: r.refKind,
        id: r.refId.toHexString(),
        ...(accountNumber !== undefined ? { accountNumber } : {}),
      },
      ...(r.balanceAfter !== undefined ? { balanceAfter: r.balanceAfter } : {}),
      recordedById,
      recordedByName:
        recordedById === SYSTEM_ACTOR_HEX
          ? 'System'
          : recordedById
            ? (userNames.get(recordedById) ?? null)
            : null,
      createdAt: r.createdAt,
    };
  });
}

function emptyTotals(): TxnTotals {
  return {
    in: { count: 0, amount: 0 },
    out: { count: 0, amount: 0 },
    internal: { count: 0, amount: 0 },
    feesCollected: 0,
  };
}

interface SummaryGroup {
  _id: { type: TxnType; channel: string | null; detail: string | null };
  count: number;
  amount: number;
  fee: number;
}

function totalsFromGroups(groups: SummaryGroup[]): TxnTotals {
  const totals = emptyTotals();
  for (const g of groups) {
    const direction = directionOf(g._id.type, g._id.channel, g._id.detail);
    totals[direction].count += g.count;
    totals[direction].amount += g.amount;
    // Fees on transfer rows mirror the savings-leg fee — count savings only.
    if (g._id.type === 'savings-withdrawal' || g._id.type === 'savings-closure') {
      totals.feesCollected += g.fee;
    }
  }
  return totals;
}

// ---------------------------------------------------------------- grouped totals

/** Per-type totals over a window — powers the dashboard's cash figures. */
export interface TxnGroupSummary {
  from: string;
  to: string;
  totals: TxnTotals;
  groups: {
    type: TxnType;
    direction: TxnDirection;
    count: number;
    amount: number;
    fee: number;
  }[];
}

export async function transactionGroups(from?: string, to?: string): Promise<TxnGroupSummary> {
  const window = rangeToWindow(from, to);
  const groups = await SusuDepositModel.aggregate<SummaryGroup>([
    ...unionStages(buildBranches(window)),
    {
      $group: {
        _id: { type: '$type', channel: '$channel', detail: '$detail' },
        count: { $sum: 1 },
        amount: { $sum: '$amount' },
        fee: { $sum: '$fee' },
      },
    },
  ]);
  return {
    from: window.from,
    to: window.to,
    totals: totalsFromGroups(groups),
    groups: groups.map((g) => ({
      type: g._id.type,
      direction: directionOf(g._id.type, g._id.channel, g._id.detail),
      count: g.count,
      amount: g.amount,
      fee: g.fee,
    })),
  };
}

// ---------------------------------------------------------------- feed

export interface TransactionsFeed {
  from: string;
  to: string;
  items: UnifiedTxnRow[];
  page: number;
  limit: number;
  total: number;
  totals: TxnTotals;
}

export async function listTransactions(query: TransactionsQuery): Promise<TransactionsFeed> {
  const window = rangeToWindow(query.from, query.to);
  const branches = buildBranches(
    window,
    query.customerId,
    query.module ? [query.module] : undefined,
  );

  const [facet] = await SusuDepositModel.aggregate<{
    rows: RawRow[];
    total: { n: number }[];
    groups: SummaryGroup[];
  }>([
    ...unionStages(branches),
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $facet: {
        rows: [{ $skip: (query.page - 1) * query.limit }, { $limit: query.limit }],
        total: [{ $count: 'n' }],
        groups: [
          {
            $group: {
              _id: { type: '$type', channel: '$channel', detail: '$detail' },
              count: { $sum: 1 },
              amount: { $sum: '$amount' },
              fee: { $sum: '$fee' },
            },
          },
        ],
      },
    },
  ]);

  return {
    from: window.from,
    to: window.to,
    items: await resolveRows(facet?.rows ?? []),
    page: query.page,
    limit: query.limit,
    total: facet?.total[0]?.n ?? 0,
    totals: totalsFromGroups(facet?.groups ?? []),
  };
}

/** Flat rows for CSV export — same filters, no pagination, capped. */
export async function transactionsCsvRows(
  query: TransactionsQuery,
): Promise<Record<string, unknown>[]> {
  const window = rangeToWindow(query.from, query.to);
  const branches = buildBranches(
    window,
    query.customerId,
    query.module ? [query.module] : undefined,
  );
  const raw = await SusuDepositModel.aggregate<RawRow>([
    ...unionStages(branches),
    { $sort: { createdAt: -1, _id: -1 } },
    { $limit: CSV_MAX_ROWS },
  ]);
  return (await resolveRows(raw)).map(toCsvRow);
}

function toCsvRow(r: UnifiedTxnRow): Record<string, unknown> {
  return {
    date: r.createdAt,
    module: r.module,
    type: r.type,
    direction: r.direction,
    amount: r.amount,
    fee: r.fee,
    channel: r.channel ?? '',
    detail: r.detail ?? '',
    customerName: r.customerName,
    accountRef: r.ref.accountNumber ?? r.ref.id,
    balanceAfter: r.balanceAfter ?? '',
    recordedBy: r.recordedByName ?? '',
  };
}

// ---------------------------------------------------------------- statement of account

export interface CustomerStatement {
  customer: {
    id: string;
    fullName: string;
    phone: string;
    email: string | null;
    residentialAddress: string | null;
  };
  period: { from: string; to: string };
  generatedAt: Date;
  products: {
    susu: {
      accountId: string;
      accountNumber: string;
      status: string;
      dailyAmount: number;
      depositsCount: number;
      totalDeposited: number;
      withdrawnAmount: number;
      balance: number;
      payoutRemaining: number;
    }[];
    savings: {
      accountId: string;
      accountNumber: string;
      accountType: string;
      status: string;
      openingBalance: number;
      closingBalance: number;
      currentBalance: number;
    }[];
    loans: {
      loanId: string;
      tier: string;
      status: string;
      principal: number;
      totalDue: number;
      totalRepaid: number;
      remaining: number;
      dueDate: Date | null;
    }[];
    hirePurchase: {
      agreementId: string;
      itemName: string;
      status: string;
      totalPayable: number | null;
      totalPaid: number;
      remaining: number | null;
    }[];
  };
  totals: TxnTotals;
  /** Chronological (oldest first) within the period. */
  transactions: UnifiedTxnRow[];
  /** True when the period held more than the row cap — narrow the range. */
  truncated: boolean;
}

/** Balance of a savings account as of an instant: last txn before it, else 0. */
async function balanceAsOf(accountId: Types.ObjectId, instant: Date): Promise<number> {
  const last = await SavingsTxnModel.findOne(
    { accountId, createdAt: { $lt: instant }, ...NOT_TRASHED },
    { balanceAfter: 1 },
  ).sort({ createdAt: -1, _id: -1 });
  return last?.balanceAfter ?? 0;
}

export async function customerStatement(
  customerId: Types.ObjectId,
  from?: string,
  to?: string,
): Promise<CustomerStatement> {
  const customer = await CustomerModel.findOne({ _id: customerId, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  const window = rangeToWindow(from, to);

  const [susuAccounts, savingsAccounts, loans, hpAgreements, raw] = await Promise.all([
    SusuAccountModel.find({ customerId, ...NOT_TRASHED }).sort({ createdAt: 1 }),
    SavingsAccountModel.find({ customerId, ...NOT_TRASHED }).sort({ createdAt: 1 }),
    LoanModel.find({ customerId, status: { $ne: 'rejected' }, ...NOT_TRASHED }).sort({
      createdAt: 1,
    }),
    HpAgreementModel.find({ customerId, status: { $ne: 'rejected' }, ...NOT_TRASHED }).sort({
      createdAt: 1,
    }),
    SusuDepositModel.aggregate<RawRow>([
      ...unionStages(buildBranches(window, customerId)),
      { $sort: { createdAt: 1, _id: 1 } },
      { $limit: STATEMENT_MAX_ROWS + 1 },
    ]),
  ]);

  const truncated = raw.length > STATEMENT_MAX_ROWS;
  if (truncated) raw.pop();
  const transactions = await resolveRows(raw);

  const totals = emptyTotals();
  for (const t of transactions) {
    totals[t.direction].count += 1;
    totals[t.direction].amount += t.amount;
    if (t.type === 'savings-withdrawal' || t.type === 'savings-closure') {
      totals.feesCollected += t.fee;
    }
  }

  const savings = await Promise.all(
    savingsAccounts.map(async (a) => ({
      accountId: a._id.toHexString(),
      accountNumber: a.accountNumber,
      accountType: a.accountType,
      status: a.status,
      openingBalance: await balanceAsOf(a._id, window.start),
      closingBalance: await balanceAsOf(a._id, window.end),
      currentBalance: a.balance,
    })),
  );

  return {
    customer: {
      id: customer._id.toHexString(),
      fullName: customer.fullName,
      phone: customer.phone,
      email: customer.email ?? null,
      residentialAddress: customer.residentialAddress ?? null,
    },
    period: { from: window.from, to: window.to },
    generatedAt: new Date(),
    products: {
      susu: susuAccounts.map((a) => ({
        accountId: a._id.toHexString(),
        accountNumber: a.accountNumber,
        status: a.status,
        dailyAmount: a.dailyAmount,
        depositsCount: a.depositsCount,
        totalDeposited: a.totalDeposited,
        withdrawnAmount: a.withdrawnAmount,
        balance: susuBalance(a.totalDeposited, a.withdrawnAmount),
        payoutRemaining: a.payoutRemaining,
      })),
      savings,
      loans: loans.map((l) => ({
        loanId: l._id.toHexString(),
        tier: l.tier,
        status: l.status,
        principal: l.principal,
        totalDue: l.totalDue,
        totalRepaid: l.totalRepaid,
        remaining: l.totalDue - l.totalRepaid,
        dueDate: l.dueDate ?? null,
      })),
      hirePurchase: hpAgreements.map((h) => ({
        agreementId: h._id.toHexString(),
        itemName: h.itemSnapshot.name,
        status: h.status,
        totalPayable: h.totalPayable ?? null,
        totalPaid: h.totalPaid,
        remaining: h.totalPayable !== undefined ? remainingOn(h) : null,
      })),
    },
    totals,
    transactions,
    truncated,
  };
}

/** Statement transactions flattened for CSV export. */
export function statementCsvRows(statement: CustomerStatement): Record<string, unknown>[] {
  return statement.transactions.map(toCsvRow);
}

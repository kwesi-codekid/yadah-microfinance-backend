import { accountRef } from '../../lib/account-number.js';
import { Types, type PipelineStage } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import {
  directionOf,
  isRevenueFee,
  moduleOf,
  TXN_MODULES,
  type TxnDirection,
  type RecordedByKind,
  type TxnModule,
  type TxnStatus,
  type TxnType,
} from '../../domain/transactions.js';
import { susuBalance } from '../../domain/susu.js';
import {
  CustomerModel,
  HpAgreementModel,
  LoanModel,
  PaystackChargeModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SusuAccountModel,
  SusuDepositModel,
  UserModel,
} from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import { rangeToWindow } from '../../lib/time.js';
import { remainingOn } from '../hire-purchase/hp.service.js';
import { PAYSTACK_KEY_PREFIX } from '../payments/payments.service.js';
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
  /**
   * Ledger rows applied from a Paystack charge carry `paystack:<reference>`.
   * It is the only surviving link from the row back to who asked for it.
   */
  idempotencyKey?: string | null;
  /** Pending-charge rows alone know the actor's role first-hand. */
  initiatedByRole?: string | null;
  balanceAfter?: number;
  /** Absent on ledger rows, which are completed by definition. */
  status?: TxnStatus;
  createdAt: Date;
}

export interface UnifiedTxnRow {
  id: string;
  module: TxnModule;
  type: TxnType;
  direction: TxnDirection;
  amount: number; // pesewas
  fee: number; // pesewas
  /**
   * 'completed' for every ledger row. 'pending'/'failed' appear only when
   * includePending is set, and only for Paystack charges that have not been
   * applied — money that has not moved yet, so never counted in totals.
   */
  status: TxnStatus;
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
  /**
   * Which directory `recordedById` belongs to, and so how to read it: a User
   * id, a Customer id, the automation actor, or nothing at all.
   */
  recordedByKind: RecordedByKind;
  createdAt: Date;
}

export interface TxnTotals {
  in: { count: number; amount: number };
  out: { count: number; amount: number };
  internal: { count: number; amount: number };
  /**
   * Company revenue taken as a charge in the range: savings withdrawal and
   * closure fees, plus susu closing commissions. Named `feesCollected` for
   * the wire's sake — every client reads that key — but it is charges of
   * both kinds, and the screens label it accordingly.
   */
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
 *
 * `includePending` adds unapplied Paystack charges — money that has not landed
 * yet. Off by default, and never set for totals: including it would report
 * cash the business does not hold.
 */
function buildBranches(
  window: { start: Date; end: Date },
  customerId?: Types.ObjectId,
  modules?: TxnModule[],
  includePending = false,
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
              idempotencyKey: 1,
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
              // The one-day commission charged as the account stopped. Only
              // the row that stopped it carries a value; instalments of the
              // same closure, and partial withdrawals, carry zero. Rows
              // written before the field existed have none, and read as zero.
              fee: { $ifNull: ['$commissionAmount', 0] },
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
            idempotencyKey: 1,
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
              idempotencyKey: 1,
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
            idempotencyKey: 1,
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

  // Charge kinds belonging to each module, so a filtered feed does not leak
  // pending rows from modules the caller excluded.
  const pendingKinds = [
    ...(wanted.has('susu') ? ['susu-deposit'] : []),
    ...(wanted.has('savings') ? ['savings-deposit'] : []),
    ...(wanted.has('loans') ? ['loan-repayment'] : []),
    ...(wanted.has('hire-purchase') ? ['hp-deposit', 'hp-installment', 'hp-redemption'] : []),
  ];
  if (includePending && pendingKinds.length > 0) {
    branches.push({
      coll: 'paystack-charges',
      stages: [
        {
          $match: {
            createdAt,
            ...byCustomer,
            kind: { $in: pendingKinds },
            // Applied charges are already in the feed as the deposit/repayment
            // they created — including them here would double-count.
            $or: [
              { status: 'pending' },
              { status: 'success', executionStatus: { $in: ['pending', 'failed'] } },
            ],
          },
        },
        {
          $project: {
            // ChargeKind is a subset of TxnType, so it maps straight across.
            type: '$kind',
            amount: 1,
            fee: { $literal: 0 },
            customerId: 1,
            refId: '$targetId',
            refKind: {
              $switch: {
                branches: [
                  { case: { $eq: ['$kind', 'susu-deposit'] }, then: 'susu-account' },
                  { case: { $eq: ['$kind', 'savings-deposit'] }, then: 'savings-account' },
                  { case: { $eq: ['$kind', 'loan-repayment'] }, then: 'loan' },
                ],
                default: 'hp-agreement',
              },
            },
            channel: { $literal: 'paystack' },
            detail: { $literal: null },
            // Money Paystack took but that could not be applied needs office
            // action — it is not merely waiting.
            status: {
              $cond: [{ $eq: ['$executionStatus', 'failed'] }, 'failed', 'pending'],
            },
            recordedById: '$initiatedById',
            // A Customer id when the portal raised it, a User id otherwise —
            // this is the field that says which.
            initiatedByRole: 1,
            createdAt: 1,
          },
        },
      ],
    });
  }

  return branches;
}

/**
 * Every money row in a window, as aggregation stages to prepend to a pipeline
 * that runs on SusuDepositModel. Shared with the dashboard series so both read
 * the same definition of a transaction — completed ledger rows only.
 */
export function buildFeedUnion(window: { start: Date; end: Date }): PipelineStage[] {
  return unionStages(buildBranches(window));
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

/**
 * The Paystack reference a ledger row was applied from, or null.
 *
 * When a customer pays through the portal, the webhook applies the charge as
 * the SYSTEM actor — they cannot post to their own ledger — so the row itself
 * records no customer. What survives is the idempotency key, which embeds the
 * charge reference, and the charge remembers who asked. This is the join back.
 */
function paystackReference(key: string | null | undefined): string | null {
  if (key === null || key === undefined) return null;
  return key.startsWith(PAYSTACK_KEY_PREFIX) ? key.slice(PAYSTACK_KEY_PREFIX.length) : null;
}

/** Batch-resolve customer names, staff names, and account numbers for a page of rows. */
async function resolveRows(raw: RawRow[]): Promise<UnifiedTxnRow[]> {
  const customerIds = new Set<string>();
  const userIds = new Set<string>();
  // References to test against the charge book: only rows the system actor
  // wrote can be a laundered customer payment, so only those are worth asking
  // about.
  const references = new Set<string>();
  const susuIds = new Set<string>();
  const savingsIds = new Set<string>();
  const loanIds = new Set<string>();
  const hpIds = new Set<string>();
  for (const r of raw) {
    customerIds.add(r.customerId.toHexString());
    const actor = r.recordedById?.toHexString() ?? null;
    // A Customer id must never be looked up in the staff directory: it misses,
    // and the row then reads as if nobody recorded it.
    if (actor !== null && actor !== SYSTEM_ACTOR_HEX && r.initiatedByRole !== 'customer') {
      userIds.add(actor);
    }
    if (actor === SYSTEM_ACTOR_HEX) {
      const reference = paystackReference(r.idempotencyKey);
      if (reference !== null) references.add(reference);
    }
    if (r.refKind === 'susu-account') susuIds.add(r.refId.toHexString());
    if (r.refKind === 'savings-account') savingsIds.add(r.refId.toHexString());
    if (r.refKind === 'loan') loanIds.add(r.refId.toHexString());
    if (r.refKind === 'hp-agreement') hpIds.add(r.refId.toHexString());
  }

  const [customers, users, susuAccounts, savingsAccounts, loans, agreements, charges] =
    await Promise.all([
      CustomerModel.find({ _id: { $in: [...customerIds] } }, { fullName: 1 }),
      UserModel.find({ _id: { $in: [...userIds] } }, { name: 1 }),
      SusuAccountModel.find({ _id: { $in: [...susuIds] } }, { accountNumber: 1 }),
      SavingsAccountModel.find({ _id: { $in: [...savingsIds] } }, { accountNumber: 1 }),
      LoanModel.find({ _id: { $in: [...loanIds] } }, { accountNumber: 1 }),
      HpAgreementModel.find({ _id: { $in: [...hpIds] } }, { accountNumber: 1 }),
      references.size === 0
        ? []
        : PaystackChargeModel.find(
            { reference: { $in: [...references] }, initiatedByRole: 'customer' },
            { reference: 1 },
          ),
    ]);
  const customerNames = new Map(customers.map((c) => [c._id.toHexString(), c.fullName]));
  const userNames = new Map(users.map((u) => [u._id.toHexString(), u.name]));
  /** References the customer raised themselves, rather than the counter. */
  const selfServed = new Set(charges.map((c) => c.reference));
  // Loans and HP agreements predating the numbering scheme have none — those
  // rows simply carry no accountNumber, exactly as before.
  const accountNumbers = new Map(
    [...susuAccounts, ...savingsAccounts, ...loans, ...agreements].flatMap((a) =>
      a.accountNumber === undefined ? [] : [[a._id.toHexString(), a.accountNumber] as const],
    ),
  );

  return raw.map((r) => {
    const channel = r.channel ?? null;
    const detail = r.detail ?? null;
    const actor = r.recordedById?.toHexString() ?? null;
    const rowCustomerId = r.customerId.toHexString();
    const accountNumber = accountNumbers.get(r.refId.toHexString());

    // Who put this row on the ledger, in four cases:
    //
    //   1. A pending charge says so outright — initiatedByRole is on the
    //      charge document, and a portal one names the customer.
    //   2. An applied portal charge was written by the system actor, but its
    //      idempotency key leads back to a charge the customer raised. The
    //      customer who paid is always the row's own customer, so the name is
    //      already to hand.
    //   3. Any other system-actor row is genuine automation: debt recovery.
    //   4. Everything else is a member of staff — or, for a handful of older
    //      loans that never recorded an approver, nobody we can name.
    let recordedByKind: RecordedByKind;
    let recordedById: string | null = actor;
    let recordedByName: string | null;
    const reference = paystackReference(r.idempotencyKey);
    if (r.initiatedByRole === 'customer') {
      recordedByKind = 'customer';
      recordedByName = customerNames.get(rowCustomerId) ?? null;
    } else if (actor === SYSTEM_ACTOR_HEX && reference !== null && selfServed.has(reference)) {
      recordedByKind = 'customer';
      recordedById = rowCustomerId;
      recordedByName = customerNames.get(rowCustomerId) ?? null;
    } else if (actor === SYSTEM_ACTOR_HEX) {
      recordedByKind = 'system';
      recordedByName = 'System';
    } else if (actor !== null) {
      recordedByKind = 'staff';
      recordedByName = userNames.get(actor) ?? null;
    } else {
      recordedByKind = 'unknown';
      recordedByName = null;
    }

    return {
      id: r._id.toHexString(),
      module: moduleOf(r.type),
      type: r.type,
      direction: directionOf(r.type, channel, detail),
      amount: r.amount,
      fee: r.fee ?? 0,
      status: r.status ?? 'completed',
      channel,
      detail,
      customerId: rowCustomerId,
      customerName:
        rowCustomerId === WALK_IN_CUSTOMER_HEX
          ? 'Walk-in customer'
          : (customerNames.get(rowCustomerId) ?? ''),
      ref: {
        kind: r.refKind,
        id: r.refId.toHexString(),
        ...(accountNumber !== undefined ? { accountNumber } : {}),
      },
      ...(r.balanceAfter !== undefined ? { balanceAfter: r.balanceAfter } : {}),
      recordedById,
      recordedByName,
      recordedByKind,
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
  _id: {
    type: TxnType;
    channel: string | null;
    detail: string | null;
    /** Undefined on ledger rows; only pending Paystack rows carry a value. */
    status?: TxnStatus | null;
  };
  count: number;
  amount: number;
  fee: number;
}

function totalsFromGroups(groups: SummaryGroup[]): TxnTotals {
  const totals = emptyTotals();
  for (const g of groups) {
    // Pending and failed Paystack rows are money that has not moved — they
    // appear in the feed but must never reach a cash total.
    if (g._id.status !== null && g._id.status !== undefined && g._id.status !== 'completed') {
      continue;
    }
    const direction = directionOf(g._id.type, g._id.channel, g._id.detail);
    totals[direction].count += g.count;
    totals[direction].amount += g.amount;
    if (isRevenueFee(g._id.type)) totals.feesCollected += g.fee;
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
    /** How the money moved: cash, paystack, momo — null when unrecorded. */
    channel: string | null;
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
        _id: { type: '$type', channel: '$channel', detail: '$detail', status: '$status' },
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
      channel: g._id.channel,
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
    query.includePending,
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
              _id: { type: '$type', channel: '$channel', detail: '$detail', status: '$status' },
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
    query.includePending,
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
    status: r.status,
    amount: r.amount,
    fee: r.fee,
    channel: r.channel ?? '',
    detail: r.detail ?? '',
    customerName: r.customerName,
    accountRef: r.ref.accountNumber ?? r.ref.id,
    balanceAfter: r.balanceAfter ?? '',
    recordedBy: r.recordedByName ?? '',
    // Appended, never inserted: csv.ts derives its header order from the keys
    // in first-seen order, so a new column in the middle would shift every
    // spreadsheet the office already reads by position.
    recordedByType: r.recordedByKind,
  };
}

// ---------------------------------------------------------------- statement of account

export interface CustomerStatement {
  customer: {
    id: string;
    fullName: string;
    phone: string;
    residentialAddress: string | null;
  };
  period: { from: string; to: string };
  generatedAt: Date;
  products: {
    susu: {
      accountId: string;
      /** The customer's susu number — every book they hold carries it. */
      accountNumber: string;
      /** The month this book is called, and the book's own distinct ref. */
      cycleMonth?: string;
      ref: string;
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
    if (isRevenueFee(t.type)) totals.feesCollected += t.fee;
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
      residentialAddress: customer.residentialAddress ?? null,
    },
    period: { from: window.from, to: window.to },
    generatedAt: new Date(),
    products: {
      // A customer with two books in one month gets two panels titled
      // identically unless the statement carries something that differs.
      susu: susuAccounts.map((a) => ({
        accountId: a._id.toHexString(),
        accountNumber: a.accountNumber,
        ...(a.cycleMonth !== undefined ? { cycleMonth: a.cycleMonth } : {}),
        ref: accountRef(a._id.toHexString(), a.createdAt),
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

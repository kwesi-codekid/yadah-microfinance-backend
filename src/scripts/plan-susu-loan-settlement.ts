/**
 * Reports what settling every susu loan account would do, ahead of taking the
 * product down. READ-ONLY: it writes nothing, to any collection.
 *
 * For each open account with money in it, the whole balance is put against
 * the customer's open loans, oldest first, up to what each still owes — not
 * just what has fallen due, as the hourly deduction does. Each account then
 * lands in one case:
 *
 *   part-paid          the balance is used up and a loan is still owed
 *   paid-off           the balance pays the loans off exactly
 *   leftover-savings   the loans are paid off and money is left; the customer
 *                      has a savings account to take it
 *   leftover-stranded  the same, but they have no savings account
 *   no-loan-savings    no open loan at all; they have a savings account
 *   no-loan-stranded   no open loan and no savings account
 *
 * The first two need no decision. Where the rest of the money goes in the
 * other four is the client's call, which is what this report is for.
 *
 *   npx tsx src/scripts/plan-susu-loan-settlement.ts [--csv <file>]
 */
import { writeFileSync } from 'node:fs';
import type { Types } from 'mongoose';
import { connectDb, databaseNameFromUri, disconnectDb } from '../lib/db.js';
import { env } from '../config/env.js';
import { formatGhs } from '../lib/money.js';
import {
  CustomerModel,
  LoanModel,
  SavingsAccountModel,
  SusuLoanAccountModel,
} from '../models/index.js';
import { NOT_TRASHED } from '../models/shared.js';

export const SETTLEMENT_CASES = [
  'part-paid',
  'paid-off',
  'leftover-savings',
  'leftover-stranded',
  'no-loan-savings',
  'no-loan-stranded',
] as const;
export type SettlementCase = (typeof SETTLEMENT_CASES)[number];

export interface SettlementRow {
  accountNumber: string;
  customerId: string;
  customerName: string;
  phone: string;
  case: SettlementCase;
  balance: number; // pesewas, as are all amounts here
  loanDebt: number; // still owed across their open loans, before settling
  toLoan: number;
  leftover: number; // balance − toLoan
  loanDebtAfter: number;
  loans: { loanId: string; owed: number; pays: number }[];
  /** A loan applied for or approved but not yet given out. */
  hasLoanInProgress: boolean;
  savingsAccountNumber?: string;
}

export interface SettlementPlan {
  accounts: number; // open accounts holding money
  emptyAccounts: number; // open and at zero: can simply be closed
  /** Closed or deleted accounts that still show a balance — should be none. */
  anomalies: { accountNumber: string; balance: number; reason: string }[];
  totalBalance: number;
  totalToLoan: number;
  totalLeftover: number;
  byCase: Record<SettlementCase, { accounts: number; balance: number; leftover: number }>;
  rows: SettlementRow[];
}

function caseOf(hasLoan: boolean, leftover: number, debtAfter: number, hasSavings: boolean) {
  if (!hasLoan) return hasSavings ? 'no-loan-savings' : 'no-loan-stranded';
  if (leftover === 0) return debtAfter > 0 ? 'part-paid' : 'paid-off';
  return hasSavings ? 'leftover-savings' : 'leftover-stranded';
}

export async function planSusuLoanSettlement(): Promise<SettlementPlan> {
  const plan: SettlementPlan = {
    accounts: 0,
    emptyAccounts: 0,
    anomalies: [],
    totalBalance: 0,
    totalToLoan: 0,
    totalLeftover: 0,
    byCase: Object.fromEntries(
      SETTLEMENT_CASES.map((c) => [c, { accounts: 0, balance: 0, leftover: 0 }]),
    ) as SettlementPlan['byCase'],
    rows: [],
  };

  const strays = await SusuLoanAccountModel.find({
    balance: { $ne: 0 },
    $or: [{ status: 'closed' }, { deletedAt: { $ne: null } }],
  }).lean();
  for (const a of strays) {
    plan.anomalies.push({
      accountNumber: a.accountNumber,
      balance: a.balance,
      reason: a.deletedAt ? 'deleted with a balance' : 'closed with a balance',
    });
  }

  const open = await SusuLoanAccountModel.find({ status: 'active', ...NOT_TRASHED })
    .sort({ accountNumber: 1 })
    .lean();
  for (const a of open) {
    if (a.balance < 0) {
      plan.anomalies.push({
        accountNumber: a.accountNumber,
        balance: a.balance,
        reason: 'negative balance',
      });
    }
  }
  plan.emptyAccounts = open.filter((a) => a.balance === 0).length;
  const holding = open.filter((a) => a.balance > 0);
  plan.accounts = holding.length;

  const customerIds = holding.map((a) => a.customerId);
  const byCustomer = <T extends { customerId: Types.ObjectId }>(docs: T[]): Map<string, T[]> => {
    const map = new Map<string, T[]>();
    for (const d of docs) {
      const key = d.customerId.toHexString();
      map.set(key, [...(map.get(key) ?? []), d]);
    }
    return map;
  };

  const customers = new Map(
    (await CustomerModel.find({ _id: { $in: customerIds } }).lean()).map((c) => [
      c._id.toHexString(),
      c,
    ]),
  );
  // Open loans oldest first, as the deduction pays them.
  const openLoans = byCustomer(
    await LoanModel.find({
      customerId: { $in: customerIds },
      status: { $in: ['active', 'arrears'] },
      ...NOT_TRASHED,
    })
      .sort({ disbursedAt: 1, createdAt: 1 })
      .lean(),
  );
  const inProgress = byCustomer(
    await LoanModel.find({
      customerId: { $in: customerIds },
      status: { $in: ['pending', 'approved'] },
      ...NOT_TRASHED,
    }).lean(),
  );
  // The account a leftover goes to today: their oldest open standard or student one.
  const savings = byCustomer(
    await SavingsAccountModel.find({
      customerId: { $in: customerIds },
      accountType: { $in: ['standard', 'student'] },
      status: 'active',
      ...NOT_TRASHED,
    })
      .sort({ createdAt: 1 })
      .lean(),
  );

  for (const a of holding) {
    const key = a.customerId.toHexString();
    const loans = openLoans.get(key) ?? [];
    let left = a.balance;
    let loanDebt = 0;
    const lines: SettlementRow['loans'] = [];
    for (const loan of loans) {
      const owed = Math.max(0, loan.totalDue - loan.totalRepaid);
      const pays = Math.min(owed, left);
      left -= pays;
      loanDebt += owed;
      lines.push({ loanId: loan._id.toHexString(), owed, pays });
    }
    const toLoan = a.balance - left;
    const target = savings.get(key)?.[0];
    const kind = caseOf(loans.length > 0, left, loanDebt - toLoan, target !== undefined);
    const customer = customers.get(key);

    plan.rows.push({
      accountNumber: a.accountNumber,
      customerId: key,
      customerName: customer?.fullName ?? '(customer not found)',
      phone: customer?.phone ?? '',
      case: kind,
      balance: a.balance,
      loanDebt,
      toLoan,
      leftover: left,
      loanDebtAfter: loanDebt - toLoan,
      loans: lines,
      hasLoanInProgress: inProgress.has(key),
      ...(target ? { savingsAccountNumber: target.accountNumber } : {}),
    });
    plan.totalBalance += a.balance;
    plan.totalToLoan += toLoan;
    plan.totalLeftover += left;
    plan.byCase[kind].accounts++;
    plan.byCase[kind].balance += a.balance;
    plan.byCase[kind].leftover += left;
  }
  return plan;
}

function toCsv(rows: SettlementRow[]): string {
  const ghs = (pesewas: number): string => (pesewas / 100).toFixed(2);
  const cell = (v: string): string => `"${v.replace(/"/g, '""')}"`;
  const head = [
    'Account',
    'Customer',
    'Phone',
    'Case',
    'Balance (GHS)',
    'Loan debt (GHS)',
    'To loan (GHS)',
    'Left over (GHS)',
    'Loan debt after (GHS)',
    'Savings account',
    'Loan in progress',
  ];
  const body = rows.map((r) =>
    [
      cell(r.accountNumber),
      cell(r.customerName),
      cell(r.phone),
      r.case,
      ghs(r.balance),
      ghs(r.loanDebt),
      ghs(r.toLoan),
      ghs(r.leftover),
      ghs(r.loanDebtAfter),
      cell(r.savingsAccountNumber ?? ''),
      r.hasLoanInProgress ? 'yes' : 'no',
    ].join(','),
  );
  return [head.join(','), ...body].join('\n') + '\n';
}

async function main(): Promise<void> {
  const csvAt = process.argv.indexOf('--csv');
  const csvPath = csvAt === -1 ? undefined : process.argv[csvAt + 1];
  if (csvAt !== -1 && !csvPath) {
    console.error('--csv needs a file path');
    process.exit(2);
  }

  await connectDb();
  console.log(`READ-ONLY report on database "${databaseNameFromUri(env.MONGO_URI)}"\n`);
  const plan = await planSusuLoanSettlement();

  console.log(`Open accounts holding money: ${String(plan.accounts)}`);
  console.log(`Open accounts at zero (close as they are): ${String(plan.emptyAccounts)}`);
  console.log(`Held in them:        ${formatGhs(plan.totalBalance)}`);
  console.log(`Would go to loans:   ${formatGhs(plan.totalToLoan)}`);
  console.log(`Would be left over:  ${formatGhs(plan.totalLeftover)}\n`);
  console.table(
    Object.fromEntries(
      SETTLEMENT_CASES.map((c) => [
        c,
        {
          accounts: plan.byCase[c].accounts,
          balance: formatGhs(plan.byCase[c].balance),
          leftover: formatGhs(plan.byCase[c].leftover),
        },
      ]),
    ),
  );
  if (plan.rows.length > 0) {
    console.table(
      plan.rows.map((r) => ({
        account: r.accountNumber,
        customer: r.customerName,
        case: r.case,
        balance: formatGhs(r.balance),
        loanDebt: formatGhs(r.loanDebt),
        toLoan: formatGhs(r.toLoan),
        leftover: formatGhs(r.leftover),
      })),
    );
  }
  if (plan.anomalies.length > 0) {
    console.log('NEEDS A LOOK — accounts that should hold nothing but do:');
    console.table(plan.anomalies.map((a) => ({ ...a, balance: formatGhs(a.balance) })));
  }
  if (csvPath) {
    writeFileSync(csvPath, toCsv(plan.rows));
    console.log(`Rows written to ${csvPath}`);
  }
  await disconnectDb();
}

const invokedDirectly = process.argv[1]
  ?.replace(/\\/g, '/')
  .endsWith('plan-susu-loan-settlement.ts');
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

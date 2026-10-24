/**
 * Converts every loan savings account into a susu loan account (client
 * decision, 23 Oct 2026: loan savings is taken down and the susu loan
 * account replaces it, keeping the balance and the history).
 *
 * For each savings account of type `loan`, in one transaction:
 *   - a susu loan account is opened with a new `SL` number (dated the month
 *     the old account opened), the same balance, status and opener;
 *   - each live row of the old account is copied across, keeping its date,
 *     amount, running balance and who recorded it: a deposit stays a deposit
 *     (or becomes a refund, when it was a deleted loan's money coming back),
 *     and a withdrawal that repaid the loan becomes a repayment naming it;
 *   - the loan repayments it paid are re-pointed at the new account
 *     (`source: 'susu-loan'`), so deleting such a loan later refunds to it;
 *   - the old account and its rows are removed, with the old account kept
 *     in full on the audit entry.
 *
 * A customer who already has a susu loan account is skipped and reported —
 * the office settles that one by hand. Dry run by default; `--apply` writes.
 * Refuses to run against anything but a local host unless --allow-remote is
 * given: this moves customer money between ledgers.
 */
import mongoose, { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../lib/db.js';
import { env } from '../config/env.js';
import { nextAccountNumber } from '../lib/account-number.js';
import { audit } from '../lib/audit.js';
import { SYSTEM_ACTOR_ID } from '../lib/debt-recovery.js';
import {
  RepaymentModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SusuLoanAccountModel,
  SusuLoanTxnModel,
  type SavingsTxn,
  type SusuLoanTxnType,
} from '../models/index.js';
import { NOT_TRASHED } from '../models/shared.js';

const APPLY = process.argv.includes('--apply');
const ALLOW_REMOTE = process.argv.includes('--allow-remote');

export interface LoanSavingsMigration {
  apply: boolean;
  accounts: number;
  converted: { from: string; to: string; customerId: string; balance: number; rows: number }[];
  skipped: { accountNumber: string; customerId: string; reason: string }[];
  balanceBefore: number;
  balanceAfter: number;
}

/** What an old row becomes, and the loan it names if any. */
async function convertRow(
  row: SavingsTxn,
  accountId: Types.ObjectId,
): Promise<{ type: SusuLoanTxnType; loanId?: Types.ObjectId } | null> {
  const key = row.idempotencyKey ?? '';
  if (row.type === 'closure') return null; // closed empty: no money moved
  if (row.type === 'deposit') {
    const refund = /^loan-trash:([0-9a-f]{24}):/.exec(key);
    return refund?.[1]
      ? { type: 'refund', loanId: new Types.ObjectId(refund[1]) }
      : { type: 'deposit' };
  }
  const original = key.startsWith('loan-savings:') ? key.slice('loan-savings:'.length) : null;
  const repayment = original
    ? await RepaymentModel.findOne({ savingsAccountId: accountId, idempotencyKey: original })
    : null;
  return repayment ? { type: 'repayment', loanId: repayment.loanId } : { type: 'repayment' };
}

export async function migrateLoanSavings(apply: boolean): Promise<LoanSavingsMigration> {
  const summary: LoanSavingsMigration = {
    apply,
    accounts: 0,
    converted: [],
    skipped: [],
    balanceBefore: 0,
    balanceAfter: 0,
  };
  const actor = SYSTEM_ACTOR_ID;
  const olds = await SavingsAccountModel.find({ accountType: 'loan', ...NOT_TRASHED }).sort({
    createdAt: 1,
  });
  summary.accounts = olds.length;

  for (const old of olds) {
    summary.balanceBefore += old.balance;
    const clash = await SusuLoanAccountModel.findOne({
      customerId: old.customerId,
      status: 'active',
      ...NOT_TRASHED,
    });
    if (clash && old.status === 'active') {
      summary.skipped.push({
        accountNumber: old.accountNumber,
        customerId: old.customerId.toHexString(),
        reason: `already has susu loan account ${clash.accountNumber}`,
      });
      summary.balanceAfter += old.balance;
      continue;
    }
    const rows = await SavingsTxnModel.find({ accountId: old._id, ...NOT_TRASHED }).sort({
      createdAt: 1,
      _id: 1,
    });
    const converted: { row: SavingsTxn; type: SusuLoanTxnType; loanId?: Types.ObjectId }[] = [];
    for (const row of rows) {
      const as = await convertRow(row, old._id);
      if (as) converted.push({ row, ...as });
    }

    if (!apply) {
      summary.converted.push({
        from: old.accountNumber,
        to: '(new SL number)',
        customerId: old.customerId.toHexString(),
        balance: old.balance,
        rows: converted.length,
      });
      summary.balanceAfter += old.balance;
      continue;
    }

    const accountNumber = await nextAccountNumber('SL', old.createdAt);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const [created] = await SusuLoanAccountModel.create(
          [
            {
              accountNumber,
              customerId: old.customerId,
              balance: old.balance,
              status: old.status,
              openedById: old.openedById,
              ...(old.closedById ? { closedById: old.closedById } : {}),
              ...(old.closedAt ? { closedAt: old.closedAt } : {}),
              migratedFromSavingsId: old._id,
              createdAt: old.createdAt,
              updatedAt: new Date(),
            },
          ],
          { session, timestamps: false },
        );
        const account = created!;
        if (converted.length > 0) {
          await SusuLoanTxnModel.insertMany(
            converted.map(({ row, type, loanId }) => ({
              accountId: account._id,
              customerId: row.customerId,
              type,
              amount: row.amount,
              balanceAfter: row.balanceAfter,
              channel: row.channel,
              ...(loanId ? { loanId } : {}),
              accraDay: row.accraDay,
              recordedById: row.recordedById,
              ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
              deletedAt: null,
              createdAt: row.createdAt,
              updatedAt: new Date(),
            })),
            { session },
          );
        }
        await RepaymentModel.updateMany(
          { source: 'loan-savings', savingsAccountId: old._id },
          {
            $set: { source: 'susu-loan', susuLoanAccountId: account._id },
            $unset: { savingsAccountId: '' },
          },
          { session },
        );
        // Every row, trashed ones too: the account they belong to is gone.
        await SavingsTxnModel.deleteMany({ accountId: old._id }, { session });
        await SavingsAccountModel.deleteOne({ _id: old._id }, { session });
        await audit(
          {
            actorId: actor,
            action: 'susu-loan.account.migrate',
            entityType: 'susu-loan-account',
            entityId: account._id,
            amountBefore: old.balance,
            amountAfter: account.balance,
            before: old.toObject(),
            after: { accountNumber, rows: converted.length },
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    summary.converted.push({
      from: old.accountNumber,
      to: accountNumber,
      customerId: old.customerId.toHexString(),
      balance: old.balance,
      rows: converted.length,
    });
    summary.balanceAfter += old.balance;
  }
  return summary;
}

async function main(): Promise<void> {
  const host = new URL(env.MONGO_URI.replace(/^mongodb(\+srv)?:\/\//, 'http://')).hostname;
  const local = host === '127.0.0.1' || host === 'localhost';
  if (!local && !ALLOW_REMOTE) {
    console.error(`Refusing to run against ${host} — pass --allow-remote to override.`);
    process.exit(2);
  }
  await connectDb();
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} on ${host}`);
  const summary = await migrateLoanSavings(APPLY);
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    summary.balanceBefore === summary.balanceAfter
      ? 'Money reconciles.'
      : `MONEY DOES NOT RECONCILE: ${String(summary.balanceBefore)} → ${String(summary.balanceAfter)}`,
  );
  await disconnectDb();
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('migrate-loan-savings.ts');
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

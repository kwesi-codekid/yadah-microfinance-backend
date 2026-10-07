import {
  CommissionModel,
  LoanModel,
  SavingsTxnModel,
  SusuCycleModel,
  SusuDepositModel,
  type Loan,
  type SavingsTxn,
  type SusuCycle,
} from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import {
  cashChannel,
  recordLoanFee,
  recordSavingsFee,
  recordSusuCommission,
} from './commissions.ledger.js';

export interface BackfillPart {
  entries: number;
  amount: number;
}

export interface CommissionBackfillSummary {
  susu: BackfillPart;
  savings: BackfillPart;
  loans: BackfillPart;
  /** All three together. */
  entries: number;
  amount: number;
}

/**
 * Yadah's commission account (7 Oct 2026) starts with what was earned before
 * it existed: every ended susu cycle that charged commission, every savings
 * withdrawal or closure that kept a fee, every loan that went out with a
 * processing fee — each without an entry gets one, dated when it was earned.
 * A dry run counts; `apply` writes. Idempotent: the ledger allows one entry
 * per cycle, savings transaction and loan, and those that have one are skipped.
 */
export async function backfillCommissions(apply: boolean): Promise<CommissionBackfillSummary> {
  const [cycles, txns, loans] = await Promise.all([
    SusuCycleModel.aggregate<SusuCycle>([
      { $match: { commissionAmount: { $gt: 0 } } },
      lookupMissing('_id', 'cycleId'),
      ...dropFound,
    ]),
    SavingsTxnModel.aggregate<SavingsTxn>([
      { $match: { type: { $in: ['withdrawal', 'closure'] }, fee: { $gt: 0 }, ...NOT_TRASHED } },
      lookupMissing('_id', 'savingsTxnId'),
      ...dropFound,
    ]),
    LoanModel.aggregate<Loan>([
      { $match: { disbursedAt: { $ne: null }, processingFee: { $gt: 0 }, ...NOT_TRASHED } },
      {
        $lookup: {
          from: CommissionModel.collection.name,
          let: { id: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$accountId', '$$id'] }, source: 'loan-fee' } },
            { $limit: 1 },
          ],
          as: 'entry',
        },
      },
      ...dropFound,
    ]),
  ]);

  const part = (amounts: number[]): BackfillPart => ({
    entries: amounts.length,
    amount: amounts.reduce((sum, a) => sum + a, 0),
  });
  const susu = part(cycles.map((c) => c.commissionAmount));
  const savings = part(txns.map((t) => t.fee ?? 0));
  const loanPart = part(loans.map((l) => l.processingFee ?? 0));
  const summary: CommissionBackfillSummary = {
    susu,
    savings,
    loans: loanPart,
    entries: susu.entries + savings.entries + loanPart.entries,
    amount: susu.amount + savings.amount + loanPart.amount,
  };
  if (!apply) return summary;

  // A completed cycle's commission sits wherever the deposit that completed
  // it came in; a cut-short one was settled at the office.
  const depositIds = cycles.flatMap((c) =>
    c.completedByDepositId ? [c.completedByDepositId] : [],
  );
  const deposits = await SusuDepositModel.find({ _id: { $in: depositIds } }, { channel: 1 });
  const channelOf = new Map(deposits.map((d) => [d._id.toHexString(), d.channel]));

  for (const c of cycles) {
    await recordSusuCommission(null, c, {
      channel: cashChannel(
        c.completedByDepositId ? channelOf.get(c.completedByDepositId.toHexString()) : 'cash',
      ),
    });
  }
  for (const t of txns) await recordSavingsFee(null, t);
  for (const l of loans) await recordLoanFee(null, l);
  return summary;
}

function lookupMissing(localField: string, foreignField: string) {
  return {
    $lookup: {
      from: CommissionModel.collection.name,
      localField,
      foreignField,
      as: 'entry',
    },
  };
}

const dropFound = [{ $match: { entry: { $size: 0 } } }, { $project: { entry: 0 } }];

import type { ClientSession, Types } from 'mongoose';
import {
  CommissionModel,
  type CommissionChannel,
  type CommissionReason,
  type Loan,
  type SavingsTxn,
  type SusuCycle,
} from '../../models/index.js';

/**
 * Writing to Yadah's commission account (commission.model.ts). Every place
 * that earns a commission or fee calls one of these inside its own
 * transaction, so an entry exists exactly when the money move that earned it
 * does. Kept free of any module's service so susu, savings and loans can all
 * import it without importing each other.
 */

/**
 * The company cash channel a record's money sits in. A transfer between a
 * customer's own accounts brought no new cash in, and a record with no channel
 * was handled at the office — both are the drawer's.
 */
export function cashChannel(channel: string | null | undefined): CommissionChannel {
  return channel === 'paystack' || channel === 'momo' ? channel : 'cash';
}

const SUSU_REASON: Record<SusuCycle['endReason'], CommissionReason> = {
  completed: 'cycle-completed',
  'withdraw-all': 'withdraw-all',
  'plan-stopped': 'plan-stopped',
  'account-closed': 'account-closed',
};

/** One ended susu cycle's commission. */
export async function recordSusuCommission(
  session: ClientSession | null,
  cycle: Pick<
    SusuCycle,
    | '_id'
    | 'accountId'
    | 'customerId'
    | 'planId'
    | 'cycleNumber'
    | 'dailyAmount'
    | 'commissionAmount'
    | 'endReason'
    | 'endedAt'
    | 'completedByDepositId'
    | 'endedById'
  >,
  extra: { channel: CommissionChannel; payoutId?: Types.ObjectId },
): Promise<void> {
  if (cycle.commissionAmount <= 0) return;
  await CommissionModel.create(
    [
      {
        source: 'susu',
        reason: SUSU_REASON[cycle.endReason],
        amount: cycle.commissionAmount,
        customerId: cycle.customerId,
        accountId: cycle.accountId,
        channel: extra.channel,
        takenAt: cycle.endedAt,
        planId: cycle.planId,
        cycleId: cycle._id,
        cycleNumber: cycle.cycleNumber,
        dailyAmount: cycle.dailyAmount,
        ...(cycle.completedByDepositId ? { depositId: cycle.completedByDepositId } : {}),
        ...(extra.payoutId ? { payoutId: extra.payoutId } : {}),
        ...(cycle.endedById ? { recordedById: cycle.endedById } : {}),
      },
    ],
    session ? { session } : {},
  );
}

/** The flat fee a savings withdrawal or closure kept. Nothing when there was none. */
export async function recordSavingsFee(
  session: ClientSession | null,
  txn: Pick<
    SavingsTxn,
    '_id' | 'accountId' | 'customerId' | 'type' | 'fee' | 'channel' | 'createdAt' | 'recordedById'
  >,
): Promise<void> {
  const fee = txn.fee ?? 0;
  if (fee <= 0) return;
  await CommissionModel.create(
    [
      {
        source: 'savings-fee',
        reason: txn.type === 'closure' ? 'savings-closure' : 'savings-withdrawal',
        amount: fee,
        customerId: txn.customerId,
        accountId: txn.accountId,
        channel: cashChannel(txn.channel),
        takenAt: txn.createdAt,
        recordedById: txn.recordedById,
        savingsTxnId: txn._id,
      },
    ],
    session ? { session } : {},
  );
}

/** A savings transaction undone (trashed): its fee leaves the commission account. */
export async function removeSavingsFee(
  session: ClientSession | null,
  savingsTxnId: Types.ObjectId,
): Promise<void> {
  await CommissionModel.deleteOne({ savingsTxnId }, session ? { session } : {});
}

/** The processing fee paid the day a loan went out — handed over at the office. */
export async function recordLoanFee(
  session: ClientSession | null,
  loan: Pick<Loan, '_id' | 'customerId' | 'processingFee' | 'disbursedAt' | 'approvedById'>,
): Promise<void> {
  const fee = loan.processingFee ?? 0;
  if (fee <= 0 || !loan.disbursedAt) return;
  await CommissionModel.create(
    [
      {
        source: 'loan-fee',
        reason: 'loan-disbursed',
        amount: fee,
        customerId: loan.customerId,
        accountId: loan._id,
        channel: 'cash',
        takenAt: loan.disbursedAt,
        ...(loan.approvedById ? { recordedById: loan.approvedById } : {}),
      },
    ],
    session ? { session } : {},
  );
}

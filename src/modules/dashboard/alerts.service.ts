import { NOT_TRASHED } from '../../models/shared.js';
import {
  HpAgreementModel,
  LoanModel,
  PaystackChargeModel,
  ReconciliationModel,
  SusuAccountModel,
  TxnCorrectionModel,
} from '../../models/index.js';
import { remainingOn } from '../hire-purchase/hp.service.js';

/**
 * The dashboard's alert panel: business conditions that need someone to act,
 * counted fresh on every call.
 *
 * These are aggregates over live state, deliberately NOT the notifications
 * collection — a notification is one past event addressed to one staff member,
 * whereas an alert is a standing condition ("14 payouts are waiting") that
 * stays true until the work is done and is the same for everyone in the
 * office. An alert with nothing behind it is omitted rather than returned
 * with a zero count.
 */

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface DashboardAlert {
  /** Stable identifier — safe to key UI off, unlike the human-facing title. */
  key: string;
  severity: AlertSeverity;
  title: string;
  /** One sentence stating the condition, already phrased for display. */
  body: string;
  /** How many records are behind the alert. */
  count: number;
  /** Money at stake in pesewas, or null when the alert is not about an amount. */
  amount: number | null;
  /**
   * Where the work lives, so the frontend can route its action button without
   * hardcoding a mapping from alert key to screen.
   */
  target: { module: string; filter: Record<string, string> };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Loans escalate a tier once overdue; past this the arrears are serious. */
const SERIOUS_ARREARS_DAYS = 30;

function ghs(pesewas: number): string {
  return `GHS ${(pesewas / 100).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function dashboardAlerts(): Promise<{ alerts: DashboardAlert[]; generatedAt: Date }> {
  const now = new Date();
  const seriousBefore = new Date(now.getTime() - SERIOUS_ARREARS_DAYS * DAY_MS);

  const [
    susuPending,
    loansArrears,
    loansSeriouslyOverdue,
    creditOutstanding,
    loansAwaitingDecision,
    openHp,
    handoversAwaitingConfirmation,
    stuckCharges,
    correctionsAwaitingDecision,
  ] = await Promise.all([
    SusuAccountModel.aggregate<{ count: number; amount: number }>([
      { $match: { status: 'pending-payout', ...NOT_TRASHED } },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$payoutRemaining' } } },
    ]),
    LoanModel.aggregate<{ count: number; amount: number }>([
      { $match: { status: 'arrears', ...NOT_TRASHED } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          amount: { $sum: { $subtract: ['$totalDue', '$totalRepaid'] } },
        },
      },
    ]),
    LoanModel.countDocuments({
      status: 'arrears',
      dueDate: { $lt: seriousBefore },
      ...NOT_TRASHED,
    }),
    LoanModel.aggregate<{ amount: number }>([
      { $match: { status: { $in: ['active', 'arrears'] }, ...NOT_TRASHED } },
      { $group: { _id: null, amount: { $sum: { $subtract: ['$totalDue', '$totalRepaid'] } } } },
    ]),
    LoanModel.countDocuments({ status: 'pending', ...NOT_TRASHED }),
    HpAgreementModel.find({ status: { $in: ['active', 'in-arrears'] }, ...NOT_TRASHED }),
    ReconciliationModel.countDocuments({ status: 'declared' }),
    // Paystack took the money but it could not be applied to the target
    // account — real cash sitting in limbo until someone resolves it.
    PaystackChargeModel.aggregate<{ count: number; amount: number }>([
      { $match: { status: 'success', executionStatus: 'failed' } },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
    // Corrections a teller asked for. Nothing moves until the office
    // answers, so an unanswered one is a figure the counter knows is wrong
    // and the ledger still shows.
    TxnCorrectionModel.countDocuments({ status: 'pending' }),
  ]);

  const alerts: DashboardAlert[] = [];

  const pending = susuPending[0];
  if (pending && pending.count > 0) {
    alerts.push({
      key: 'susu-payouts-pending',
      severity: 'warning',
      title: 'Susu payouts awaiting processing',
      body: `${String(pending.count)} completed ${pending.count === 1 ? 'cycle is' : 'cycles are'} due ${ghs(pending.amount)} in payouts to their customers.`,
      count: pending.count,
      amount: pending.amount,
      target: { module: 'susu', filter: { status: 'pending-payout' } },
    });
  }

  const hpInArrears = openHp.filter((a) => a.status === 'in-arrears');
  // The whole open credit book: loans plus hire purchase, both still owed.
  const creditBook =
    (creditOutstanding[0]?.amount ?? 0) + openHp.reduce((sum, a) => sum + remainingOn(a), 0);

  const arrears = loansArrears[0];
  if (arrears && arrears.count > 0) {
    const atRisk = creditBook === 0 ? 0 : Math.round((arrears.amount / creditBook) * 1000) / 10;
    const seriousNote =
      loansSeriouslyOverdue > 0
        ? ` ${String(loansSeriouslyOverdue)} ${loansSeriouslyOverdue === 1 ? 'is' : 'are'} more than ${String(SERIOUS_ARREARS_DAYS)} days past due.`
        : '';
    alerts.push({
      key: 'loans-in-arrears',
      severity: loansSeriouslyOverdue > 0 ? 'critical' : 'warning',
      title: 'Loans slipping into arrears',
      body: `${String(arrears.count)} ${arrears.count === 1 ? 'loan is' : 'loans are'} in arrears for ${ghs(arrears.amount)} — ${String(atRisk)}% of the credit book.${seriousNote}`,
      count: arrears.count,
      amount: arrears.amount,
      target: { module: 'loans', filter: { status: 'arrears' } },
    });
  }

  if (hpInArrears.length > 0) {
    const outstanding = hpInArrears.reduce((sum, a) => sum + remainingOn(a), 0);
    alerts.push({
      key: 'hp-in-arrears',
      severity: 'warning',
      title: 'Hire purchase agreements in arrears',
      body: `${String(hpInArrears.length)} ${hpInArrears.length === 1 ? 'agreement is' : 'agreements are'} behind on instalments, ${ghs(outstanding)} outstanding.`,
      count: hpInArrears.length,
      amount: outstanding,
      target: { module: 'hire-purchase', filter: { status: 'in-arrears' } },
    });
  }

  if (loansAwaitingDecision > 0) {
    alerts.push({
      key: 'loans-awaiting-decision',
      severity: 'info',
      title: 'Loan applications awaiting a decision',
      body: `${String(loansAwaitingDecision)} ${loansAwaitingDecision === 1 ? 'application needs' : 'applications need'} an admin decision — eligibility is summarised by the system but never auto-approved.`,
      count: loansAwaitingDecision,
      amount: null,
      target: { module: 'loans', filter: { status: 'pending' } },
    });
  }

  if (correctionsAwaitingDecision > 0) {
    alerts.push({
      key: 'corrections-awaiting-decision',
      severity: 'info',
      title: 'Corrections awaiting a decision',
      body: `${String(correctionsAwaitingDecision)} ${correctionsAwaitingDecision === 1 ? 'correction a teller asked for is' : 'corrections tellers asked for are'} waiting on the office — the ledger still shows the figure they say is wrong.`,
      count: correctionsAwaitingDecision,
      amount: null,
      target: { module: 'corrections', filter: { status: 'pending' } },
    });
  }

  if (handoversAwaitingConfirmation > 0) {
    alerts.push({
      key: 'handovers-awaiting-confirmation',
      severity: 'warning',
      title: 'Cash handovers awaiting confirmation',
      body: `${String(handoversAwaitingConfirmation)} collector ${handoversAwaitingConfirmation === 1 ? 'day has' : 'days have'} been declared but not yet confirmed by the office.`,
      count: handoversAwaitingConfirmation,
      amount: null,
      target: { module: 'reconciliation', filter: { status: 'declared' } },
    });
  }

  const stuck = stuckCharges[0];
  if (stuck && stuck.count > 0) {
    alerts.push({
      key: 'paystack-unapplied',
      severity: 'critical',
      title: 'Mobile money taken but not applied',
      body: `${String(stuck.count)} Paystack ${stuck.count === 1 ? 'payment' : 'payments'} totalling ${ghs(stuck.amount)} succeeded but could not be posted to the customer's account.`,
      count: stuck.count,
      amount: stuck.amount,
      target: { module: 'payments', filter: { executionStatus: 'failed' } },
    });
  }

  const severityRank: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return { alerts, generatedAt: new Date() };
}

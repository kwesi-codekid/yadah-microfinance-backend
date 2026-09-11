/**
 * Unified transaction feed: every money event across all modules mapped to a
 * single row shape. `direction` is from the COMPANY's cash perspective:
 *   in       — cash received from a customer
 *   out      — cash handed to a customer
 *   internal — money moved between the customer's own products (transfer
 *              legs); never counted in cash totals or the two would
 *              double-count every transfer.
 */

export const TXN_TYPES = [
  'susu-deposit',
  'susu-payout',
  /** Part of a balance taken while the account stays open — no commission. */
  'susu-withdrawal',
  'savings-deposit',
  'savings-withdrawal',
  'savings-closure',
  'loan-disbursement',
  'loan-repayment',
  'hp-deposit',
  'hp-installment',
  'hp-redemption',
  /** Outright counter sale — no agreement, paid in full at the till. */
  'hp-sale',
  'transfer',
] as const;
export type TxnType = (typeof TXN_TYPES)[number];

export const TXN_MODULES = ['susu', 'savings', 'loans', 'hire-purchase', 'transfers'] as const;
export type TxnModule = (typeof TXN_MODULES)[number];

export type TxnDirection = 'in' | 'out' | 'internal';

/**
 * Whether the money behind a row has actually moved.
 *
 * Every record written by the ledger is `completed` — the modules only write
 * once cash is in hand or a webhook has confirmed it. The other two states
 * exist solely for Paystack charges, which live in their own collection until
 * they are applied:
 *   pending — initiated, Paystack has not confirmed (or is being applied now)
 *   failed  — Paystack took the money but it could not be applied to the
 *             target account; the office has to resolve it
 *
 * Only `completed` rows count towards cash totals. Pending and failed rows are
 * opt-in (`includePending`) and never reach the dashboard's cash figures.
 */
export const TXN_STATUSES = ['completed', 'pending', 'failed'] as const;
export type TxnStatus = (typeof TXN_STATUSES)[number];

export function moduleOf(type: TxnType): TxnModule {
  switch (type) {
    case 'susu-deposit':
    case 'susu-payout':
    case 'susu-withdrawal':
      return 'susu';
    case 'savings-deposit':
    case 'savings-withdrawal':
    case 'savings-closure':
      return 'savings';
    case 'loan-disbursement':
    case 'loan-repayment':
      return 'loans';
    case 'hp-deposit':
    case 'hp-installment':
    case 'hp-redemption':
    case 'hp-sale':
      return 'hire-purchase';
    case 'transfer':
      return 'transfers';
  }
}

/**
 * `channel` is the record's Channel ('transfer' marks internal legs).
 * `detail` is the type-specific discriminator: a susu payout's destination
 * ('cash' | 'savings' | ...) or a repayment's source ('cash' | 'susu-closure'
 * | 'transfer'). Both are null when the record has none.
 */
export function directionOf(
  type: TxnType,
  channel: string | null,
  detail: string | null,
): TxnDirection {
  switch (type) {
    case 'susu-deposit':
    case 'savings-deposit':
    case 'hp-deposit':
    case 'hp-installment':
    case 'hp-redemption':
    case 'hp-sale':
      return channel === 'transfer' ? 'internal' : 'in';
    case 'savings-withdrawal':
    case 'savings-closure':
      return channel === 'transfer' ? 'internal' : 'out';
    case 'susu-payout':
    case 'susu-withdrawal':
      return detail === 'cash' ? 'out' : 'internal';
    case 'loan-repayment':
      return detail === 'cash' ? 'in' : 'internal';
    case 'loan-disbursement':
      return 'out';
    case 'transfer':
      return 'internal';
  }
}

/**
 * Whether a row's `fee` is money the company KEPT, as opposed to a charge
 * mirrored onto another row for display.
 *
 * Three row types carry real revenue: the two savings charges, and a susu
 * payout that stopped its account (one cycle-day's commission, charged once —
 * every later instalment of the same closure carries zero, so counting the
 * type here cannot double-charge). `transfer` is excluded deliberately: its
 * fee mirrors the savings leg's, and counting both would bill the customer
 * twice on paper. `susu-withdrawal` is a partial draw and never charges.
 */
export function isRevenueFee(type: TxnType): boolean {
  return type === 'savings-withdrawal' || type === 'savings-closure' || type === 'susu-payout';
}

/**
 * Who put the row on the ledger — which directory `recordedById` belongs to,
 * and therefore how to read it.
 *
 *   staff    — a signed-in User: counter, office, or a collector in the field.
 *   customer — the customer themselves, paying through the portal. They never
 *              write to the ledger directly: a portal charge is applied by the
 *              system on the webhook's word. The Paystack charge document is
 *              what remembers that the customer asked, and the feed reads it
 *              back, so the id on the row is a Customer id, not a User id.
 *   system   — an automated move with no human behind it, i.e. debt recovery
 *              sweeping a customer's own balances toward an overdue debt.
 *   unknown  — the source document never recorded an actor. Some older loans
 *              carry no approver. Calling that 'system' would claim a machine
 *              did it, which is worse than admitting we do not know.
 */
export const RECORDED_BY_KINDS = ['staff', 'customer', 'system', 'unknown'] as const;
export type RecordedByKind = (typeof RECORDED_BY_KINDS)[number];

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
  'savings-deposit',
  'savings-withdrawal',
  'savings-closure',
  'loan-disbursement',
  'loan-repayment',
  'hp-deposit',
  'hp-installment',
  'hp-redemption',
  'transfer',
] as const;
export type TxnType = (typeof TXN_TYPES)[number];

export const TXN_MODULES = ['susu', 'savings', 'loans', 'hire-purchase', 'transfers'] as const;
export type TxnModule = (typeof TXN_MODULES)[number];

export type TxnDirection = 'in' | 'out' | 'internal';

export function moduleOf(type: TxnType): TxnModule {
  switch (type) {
    case 'susu-deposit':
    case 'susu-payout':
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
      return channel === 'transfer' ? 'internal' : 'in';
    case 'savings-withdrawal':
    case 'savings-closure':
      return channel === 'transfer' ? 'internal' : 'out';
    case 'susu-payout':
      return detail === 'cash' ? 'out' : 'internal';
    case 'loan-repayment':
      return detail === 'cash' ? 'in' : 'internal';
    case 'loan-disbursement':
      return 'out';
    case 'transfer':
      return 'internal';
  }
}

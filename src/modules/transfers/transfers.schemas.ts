import { z } from 'zod';
import { idempotencyKey, objectId, positiveMoneyPesewas } from '../../schemas/common.js';

const fromSide = z.discriminatedUnion('type', [
  z.object({ type: z.literal('susu'), accountId: objectId }),
  z.object({ type: z.literal('savings'), accountId: objectId }),
]);

const toSide = z.discriminatedUnion('type', [
  z.object({ type: z.literal('savings'), accountId: objectId }),
  z.object({ type: z.literal('susu'), accountId: objectId }),
  z.object({ type: z.literal('loan'), loanId: objectId }),
  z.object({ type: z.literal('hire-purchase'), agreementId: objectId }),
]);

export const transferBody = z
  .object({
    from: fromSide,
    to: toSide,
    /**
     * Required when the source is savings (a withdrawal needs an amount).
     * For a susu source: omitted = the full available value; allowed only
     * as a partial draw on a pending-payout balance.
     */
    amount: positiveMoneyPesewas.min(1).optional(),
    idempotencyKey,
  })
  .check((ctx) => {
    const { from, to, amount } = ctx.value;
    if (from.type === 'savings' && amount === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'amount is required when transferring from savings',
        path: ['amount'],
        input: amount,
      });
    }
    if (from.type === to.type) {
      ctx.issues.push({
        code: 'custom',
        message: `Transfers between two ${from.type} accounts are not supported`,
        path: ['to'],
        input: to.type,
      });
    }
  });
export type TransferBody = z.infer<typeof transferBody>;

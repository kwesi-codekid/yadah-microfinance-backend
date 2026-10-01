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
     * What leaves the source. A susu source is a withdrawal like any other —
     * up to the account's availableToWithdraw — and a loan or HP destination
     * takes at most what it still owes.
     */
    amount: positiveMoneyPesewas.min(1),
    idempotencyKey,
  })
  .check((ctx) => {
    const { from, to } = ctx.value;
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

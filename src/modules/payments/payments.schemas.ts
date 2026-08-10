import { z } from 'zod';
import { ghanaPhone, objectId, positiveMoneyPesewas } from '../../schemas/common.js';
import { CHARGE_KINDS } from '../../models/paystack-charge.model.js';
import { MOMO_PROVIDERS } from '../../lib/paystack.js';

export const chargeBody = z
  .object({
    kind: z.enum(CHARGE_KINDS),
    /** The susu/savings account, loan, or HP agreement the money pays into. */
    targetId: objectId,
    /**
     * Pesewas. Required for every kind except hp-redemption, whose amount is
     * always the full remaining balance, computed server-side.
     */
    amount: positiveMoneyPesewas.optional(),
    /** The mobile-money wallet to charge. */
    phone: ghanaPhone,
    provider: z.enum(MOMO_PROVIDERS),
  })
  .check((ctx) => {
    if (ctx.value.kind !== 'hp-redemption' && ctx.value.amount === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'amount is required for this charge kind',
        path: ['amount'],
        input: ctx.value.amount,
      });
    }
  });
export type ChargeBody = z.infer<typeof chargeBody>;

export const referenceParams = z.object({
  reference: z
    .string()
    .min(8)
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/),
});
export type ReferenceParams = z.infer<typeof referenceParams>;

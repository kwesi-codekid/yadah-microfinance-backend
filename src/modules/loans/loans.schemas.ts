import { z } from 'zod';
import {
  channel,
  idempotencyKey,
  objectId,
  pagination,
  positiveMoneyPesewas,
} from '../../schemas/common.js';

export const applyBody = z.object({
  customerId: objectId,
  principal: positiveMoneyPesewas,
  durationMonths: z.union([z.literal(3), z.literal(6), z.literal(12)]),
});
export type ApplyBody = z.infer<typeof applyBody>;

export const listLoansQuery = pagination.extend({
  customerId: objectId.optional(),
  status: z.enum(['pending', 'active', 'repaid', 'rejected', 'arrears']).optional(),
  /** Fuzzy: typo-tolerant customer name or phone. */
  search: z.string().min(1).max(100).optional(),
});
export type ListLoansQuery = z.infer<typeof listLoansQuery>;

export const loanIdParams = z.object({ id: objectId });
export type LoanIdParams = z.infer<typeof loanIdParams>;

export const customerIdParams = z.object({ customerId: objectId });
export type CustomerIdParams = z.infer<typeof customerIdParams>;

export const rejectBody = z.object({
  reason: z.string().min(2).max(300).trim(),
});
export type RejectBody = z.infer<typeof rejectBody>;

export const repayBody = z.object({
  amount: positiveMoneyPesewas.min(1),
  idempotencyKey,
  channel,
});
export type RepayBody = z.infer<typeof repayBody>;

export const susuRepayBody = z.object({
  susuAccountId: objectId,
  idempotencyKey,
});
export type SusuRepayBody = z.infer<typeof susuRepayBody>;

export const putConfigBody = z
  .object({
    ratePercent3: z.number().int().min(1).max(100),
    ratePercent6: z.number().int().min(1).max(100),
    ratePercent12: z.number().int().min(1).max(100),
    smallMinPesewas: positiveMoneyPesewas,
    smallMaxPesewas: positiveMoneyPesewas,
    bigMaxPesewas: positiveMoneyPesewas,
  })
  .check((ctx) => {
    const v = ctx.value;
    if (!(v.smallMinPesewas < v.smallMaxPesewas && v.smallMaxPesewas < v.bigMaxPesewas)) {
      ctx.issues.push({
        code: 'custom',
        message: 'Tier bounds must satisfy smallMin < smallMax < bigMax',
        path: ['smallMaxPesewas'],
        input: v.smallMaxPesewas,
      });
    }
    if (!(v.ratePercent3 < v.ratePercent6 && v.ratePercent6 < v.ratePercent12)) {
      ctx.issues.push({
        code: 'custom',
        message: 'Rates must increase with duration (escalation ladder depends on it)',
        path: ['ratePercent12'],
        input: v.ratePercent12,
      });
    }
  });
export type PutConfigBody = z.infer<typeof putConfigBody>;

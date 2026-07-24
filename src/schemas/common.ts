import { Types } from 'mongoose';
import { z } from 'zod';

/**
 * Money is ALWAYS integer pesewas (GHS 10.50 = 1050). These schemas are the
 * only doorway money values enter the system through — never accept decimals.
 */
export const moneyPesewas = z
  .number()
  .int('Money must be integer pesewas — no decimals')
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

/** Money that must be > 0 (deposits, fees, repayment amounts). */
export const positiveMoneyPesewas = moneyPesewas.min(1, 'Amount must be at least 1 pesewa');

export const objectId = z
  .string()
  .refine((v) => Types.ObjectId.isValid(v), 'Invalid id')
  .transform((v) => new Types.ObjectId(v));

/** Ghanaian mobile number in local format, e.g. 0241234567. */
export const ghanaPhone = z
  .string()
  .regex(/^0[25]\d{8}$/, 'Expected a Ghanaian mobile number like 0241234567');

/** Ghana Card personal ID number, e.g. GHA-123456789-0. */
export const ghanaCardNumber = z
  .string()
  .regex(/^GHA-\d{9}-\d$/, 'Expected a Ghana Card number like GHA-123456789-0');

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof pagination>;

/** Future-proofing only — Phase 1 records cash; no online-payment flows. */
export const channel = z.enum(['cash', 'paystack', 'momo']).default('cash');

/** Idempotency key for money-mutating endpoints (rule 7). */
export const idempotencyKey = z.string().min(8).max(128);

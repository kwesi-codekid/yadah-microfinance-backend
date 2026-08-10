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

/** Voter ID number — exactly 8 digits. */
export const voterIdNumber = z.string().regex(/^\d{8}$/, 'Voter ID numbers are exactly 8 digits');

/** Passport number — a capital letter followed by 8 digits, e.g. G12345678. */
export const passportNumber = z
  .string()
  .regex(/^[A-Z]\d{8}$/, 'Expected a passport number like G12345678');

/** Driver's licence number — 10-20 letters, digits or hyphens. */
export const driversLicenceNumber = z
  .string()
  .regex(/^[A-Za-z0-9-]{10,20}$/, "Driver's licence numbers are 10-20 letters and digits");

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof pagination>;

export const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/** Inclusive Accra-day range for list filters — both ends optional. */
export const dateRangeFields = {
  from: isoDay.optional(),
  to: isoDay.optional(),
};

/** Standard from/to ordering issue for `.check()` blocks, or null when fine. */
export function fromToIssue(v: { from?: string | undefined; to?: string | undefined }): {
  code: 'custom';
  message: string;
  path: string[];
  input: unknown;
} | null {
  if (v.from && v.to && v.from > v.to) {
    return { code: 'custom', message: 'from must not be after to', path: ['from'], input: v.from };
  }
  return null;
}

/** Listing/report download format. */
export const exportFormat = z.enum(['json', 'csv', 'xlsx']).default('json');
export type ExportFormat = z.infer<typeof exportFormat>;

/** Optional reason recorded when moving an item to the trash. */
export const trashBody = z.object({
  reason: z.string().min(2).max(300).trim().optional(),
});
export type TrashBody = z.infer<typeof trashBody>;

/** Future-proofing only — Phase 1 records cash; no online-payment flows. */
export const channel = z.enum(['cash', 'paystack', 'momo']).default('cash');

/** Idempotency key for money-mutating endpoints (rule 7). */
export const idempotencyKey = z.string().min(8).max(128);

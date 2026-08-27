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

/**
 * Reduces the ways people actually type a Ghanaian number to the one local
 * form we store: spacing and punctuation dropped, `+233`/`233` country code
 * swapped for the leading `0`. `+233 24 123 4567` and `0241234567` are the
 * same number and must not be two different records.
 */
export function normalizeGhanaPhone(raw: string): string {
  const compact = raw.replace(/[\s().-]/g, '');
  // Anchored, so a local 023x number is never mistaken for a country code.
  const local = compact.replace(/^(?:\+233|233)/, '');
  return local.startsWith('0') ? local : `0${local}`;
}

/**
 * Ghanaian mobile number, stored as 0241234567 whatever format it arrived in.
 * Mobile prefixes only (02x/05x) — landlines (03x) are rejected on purpose:
 * this field is what SMS is sent to.
 */
export const ghanaPhone = z
  .string()
  .transform(normalizeGhanaPhone)
  .refine(
    (v) => /^0[25]\d{8}$/.test(v),
    'Expected a Ghanaian mobile number like 0241234567 or +233241234567',
  );

/**
 * An optional field that an edit form can also CLEAR. A blank string or an
 * explicit null both parse to `null`, meaning "unset this field" — kept
 * distinct from `undefined`, which means "leave it as it is".
 */
export function clearable<T extends z.ZodType>(schema: T): z.ZodType<z.output<T> | null> {
  return z.preprocess((v) => (v === '' || v === null ? null : v), z.union([z.null(), schema]));
}

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

/**
 * A boolean query-string flag. `z.coerce.boolean()` is not usable here: it
 * follows JS truthiness, so the string 'false' would parse as true.
 */
export const booleanFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

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

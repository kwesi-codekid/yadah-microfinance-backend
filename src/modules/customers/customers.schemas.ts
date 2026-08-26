import { z } from 'zod';
import {
  clearable,
  dateRangeFields,
  driversLicenceNumber,
  exportFormat,
  fromToIssue,
  ghanaCardNumber,
  ghanaPhone,
  objectId,
  pagination,
  passportNumber,
  voterIdNumber,
} from '../../schemas/common.js';

/** GhanaPost GPS digital address, e.g. WR-123-4567 or GA-1834-5678. */
export const ghanaPostGps = z
  .string()
  .regex(/^[A-Z]{2}-\d{3,4}-\d{4}$/i, 'Expected a GhanaPost address like WR-123-4567')
  .transform((v) => v.toUpperCase());

const idNumberRules: Record<
  'ghana-card' | 'passport' | 'drivers-license' | 'voter-id',
  { schema: z.ZodType<string>; message: string }
> = {
  'ghana-card': {
    schema: ghanaCardNumber,
    message: 'Ghana Card numbers look like GHA-123456789-0',
  },
  passport: { schema: passportNumber, message: 'Passport numbers look like G12345678' },
  'drivers-license': {
    schema: driversLicenceNumber,
    message: "Driver's licence numbers are 10-20 letters and digits",
  },
  'voter-id': { schema: voterIdNumber, message: 'Voter ID numbers are exactly 8 digits' },
};

export const identification = z
  .object({
    idType: z.enum(['ghana-card', 'passport', 'drivers-license', 'voter-id']),
    idNumber: z.string().min(3).max(30).trim(),
    idExpiryDate: clearable(z.coerce.date()).optional(),
    idPlaceOfIssue: clearable(z.string().min(2).max(100).trim()).optional(),
  })
  .check((ctx) => {
    const rule = idNumberRules[ctx.value.idType];
    if (!rule.schema.safeParse(ctx.value.idNumber).success) {
      ctx.issues.push({
        code: 'custom',
        message: rule.message,
        path: ['idNumber'],
        input: ctx.value.idNumber,
      });
    }
  });

/** Only URLs minted by our own uploads endpoint are accepted. */
export const uploadedImageUrl = z
  .url()
  .refine((v) => v.startsWith('https://res.cloudinary.com/'), 'Not an uploaded image URL');

export const nextOfKin = z.object({
  fullName: z.string().min(2).max(120).trim(),
  relationship: clearable(z.string().min(2).max(60).trim()).optional(),
  phone: clearable(ghanaPhone).optional(),
  address: clearable(z.string().min(2).max(300).trim()).optional(),
});

const MIN_CUSTOMER_AGE_YEARS = 10;

/** Evaluated per parse (not at module load) so long-running processes stay correct. */
function isAtLeastYearsOld(dateOfBirth: Date, years: number): boolean {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - years);
  return dateOfBirth <= cutoff;
}

export const PHONES_DISTINCT_MESSAGE =
  'Phone, alternate phone and next-of-kin phone must be different numbers';

/** Returns which fields clash under the pairwise-distinct phone rule. */
export function phoneClashes(v: {
  phone?: string | null | undefined;
  altPhone?: string | null | undefined;
  nextOfKinPhone?: string | null | undefined;
}): ('altPhone' | 'nextOfKinPhone')[] {
  const clashes: ('altPhone' | 'nextOfKinPhone')[] = [];
  // A cleared number (null) collides with nothing.
  const phone = v.phone ?? undefined;
  const altPhone = v.altPhone ?? undefined;
  const nextOfKinPhone = v.nextOfKinPhone ?? undefined;
  if (altPhone !== undefined && altPhone === phone) clashes.push('altPhone');
  if (nextOfKinPhone !== undefined && (nextOfKinPhone === phone || nextOfKinPhone === altPhone)) {
    clashes.push('nextOfKinPhone');
  }
  return clashes;
}

/**
 * Every optional field is `clearable`: registration and edit forms submit a
 * blank input as "" rather than omitting it, and the office must be able to
 * wipe a wrong alternate number or email instead of being stuck with it.
 */
const profileFields = {
  // Personal
  fullName: z.string().min(2).max(120).trim(),
  dateOfBirth: clearable(
    z.coerce
      .date()
      .refine(
        (d) => isAtLeastYearsOld(d, MIN_CUSTOMER_AGE_YEARS),
        `Customer must be at least ${String(MIN_CUSTOMER_AGE_YEARS)} years old`,
      ),
  ).optional(),
  gender: clearable(z.enum(['male', 'female'])).optional(),
  nationality: clearable(z.string().min(2).max(60).trim()).optional(),
  maritalStatus: clearable(z.enum(['single', 'married', 'other'])).optional(),
  mothersMaidenName: clearable(z.string().min(2).max(120).trim()).optional(),
  // Contact
  residentialAddress: clearable(z.string().min(2).max(300).trim()).optional(),
  ghanaPostGps: clearable(ghanaPostGps).optional(),
  postalAddress: clearable(z.string().min(2).max(300).trim()).optional(),
  phone: ghanaPhone,
  altPhone: clearable(ghanaPhone).optional(),
  email: clearable(z.email()).optional(),
  // Identification
  identification: clearable(identification).optional(),
  // Occupation
  occupation: clearable(z.string().min(2).max(120).trim()).optional(),
  employerOrBusiness: clearable(z.string().min(2).max(120).trim()).optional(),
  purposeOfAccount: clearable(z.string().min(2).max(200).trim()).optional(),
  // Next of kin
  nextOfKin: clearable(nextOfKin).optional(),
  // Attachments — required at registration; URLs minted by POST /uploads/images
  photoUrl: uploadedImageUrl.describe('Customer photo — from POST /uploads/images'),
  idDocumentFrontUrl: uploadedImageUrl.describe(
    'ID front — from POST /uploads/images?kind=document',
  ),
  idDocumentBackUrl: uploadedImageUrl.describe('ID back — from POST /uploads/images?kind=document'),
};

export const createCustomerBody = z
  .object({
    ...profileFields,
    /** Set at registration; changed only via the admin-only reassign route. */
    assignedCollectorId: objectId.describe('Collector who owns this customer'),
  })
  .check((ctx) => {
    for (const clash of phoneClashes({
      phone: ctx.value.phone,
      altPhone: ctx.value.altPhone,
      nextOfKinPhone: ctx.value.nextOfKin?.phone,
    })) {
      ctx.issues.push({
        code: 'custom',
        message: PHONES_DISTINCT_MESSAGE,
        path: clash === 'altPhone' ? ['altPhone'] : ['nextOfKin', 'phone'],
        input: clash === 'altPhone' ? ctx.value.altPhone : ctx.value.nextOfKin?.phone,
      });
    }
  });
export type CreateCustomerBody = z.infer<typeof createCustomerBody>;

export const updateCustomerBody = z
  .object({
    ...profileFields,
    fullName: profileFields.fullName.optional(),
    phone: ghanaPhone.optional(),
  })
  .partial()
  .refine((v) => Object.values(v).some((f) => f !== undefined), {
    message: 'At least one field must be provided',
  })
  .check((ctx) => {
    // Only catches clashes visible within the patch itself; the service
    // re-checks against stored values, which a partial update cannot see.
    for (const clash of phoneClashes({
      phone: ctx.value.phone,
      altPhone: ctx.value.altPhone,
      nextOfKinPhone: ctx.value.nextOfKin?.phone,
    })) {
      ctx.issues.push({
        code: 'custom',
        message: PHONES_DISTINCT_MESSAGE,
        path: clash === 'altPhone' ? ['altPhone'] : ['nextOfKin', 'phone'],
        input: clash === 'altPhone' ? ctx.value.altPhone : ctx.value.nextOfKin?.phone,
      });
    }
  });
export type UpdateCustomerBody = z.infer<typeof updateCustomerBody>;

export const listCustomersQuery = pagination
  .extend({
    status: z.enum(['active', 'inactive']).optional(),
    search: z.string().min(1).max(100).optional(),
    /** Office filter: one collector's round. Ignored for collectors — they
     *  are always pinned to their own list. */
    assignedCollectorId: objectId.optional(),
    /** Office filter: customers no collector owns (invisible in the field). */
    unassigned: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    /** Registration-date range (inclusive Accra days). */
    ...dateRangeFields,
    format: exportFormat,
  })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push(issue);
  });
export type ListCustomersQuery = z.infer<typeof listCustomersQuery>;

export const customerIdParams = z.object({ id: objectId });
export type CustomerIdParams = z.infer<typeof customerIdParams>;

export const reassignCollectorBody = z.object({
  collectorId: objectId,
  reason: z.string().min(2).max(300).trim().optional(),
});
export type ReassignCollectorBody = z.infer<typeof reassignCollectorBody>;

/** Hand a whole round over — used when a collector leaves or swaps zones. */
export const bulkReassignBody = z
  .object({
    fromCollectorId: objectId,
    toCollectorId: objectId,
    reason: z.string().min(2).max(300).trim().optional(),
  })
  .check((ctx) => {
    if (ctx.value.fromCollectorId.equals(ctx.value.toCollectorId)) {
      ctx.issues.push({
        code: 'custom',
        message: 'fromCollectorId and toCollectorId must be different collectors',
        path: ['toCollectorId'],
        input: ctx.value.toCollectorId,
      });
    }
  });
export type BulkReassignBody = z.infer<typeof bulkReassignBody>;

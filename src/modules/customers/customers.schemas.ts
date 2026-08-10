import { z } from 'zod';
import {
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
    idExpiryDate: z.coerce.date().optional(),
    idPlaceOfIssue: z.string().min(2).max(100).trim().optional(),
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
  relationship: z.string().min(2).max(60).trim().optional(),
  phone: ghanaPhone.optional(),
  address: z.string().min(2).max(300).trim().optional(),
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
  phone?: string | undefined;
  altPhone?: string | undefined;
  nextOfKinPhone?: string | undefined;
}): ('altPhone' | 'nextOfKinPhone')[] {
  const clashes: ('altPhone' | 'nextOfKinPhone')[] = [];
  if (v.altPhone !== undefined && v.altPhone === v.phone) clashes.push('altPhone');
  if (
    v.nextOfKinPhone !== undefined &&
    (v.nextOfKinPhone === v.phone || v.nextOfKinPhone === v.altPhone)
  ) {
    clashes.push('nextOfKinPhone');
  }
  return clashes;
}

const profileFields = {
  // Personal
  fullName: z.string().min(2).max(120).trim(),
  dateOfBirth: z.coerce
    .date()
    .refine(
      (d) => isAtLeastYearsOld(d, MIN_CUSTOMER_AGE_YEARS),
      `Customer must be at least ${String(MIN_CUSTOMER_AGE_YEARS)} years old`,
    )
    .optional(),
  gender: z.enum(['male', 'female']).optional(),
  nationality: z.string().min(2).max(60).trim().optional(),
  maritalStatus: z.enum(['single', 'married', 'other']).optional(),
  mothersMaidenName: z.string().min(2).max(120).trim().optional(),
  // Contact
  residentialAddress: z.string().min(2).max(300).trim().optional(),
  ghanaPostGps: ghanaPostGps.optional(),
  postalAddress: z.string().min(2).max(300).trim().optional(),
  phone: ghanaPhone,
  altPhone: ghanaPhone.optional(),
  email: z.email().optional(),
  // Identification
  identification: identification.optional(),
  // Occupation
  occupation: z.string().min(2).max(120).trim().optional(),
  employerOrBusiness: z.string().min(2).max(120).trim().optional(),
  purposeOfAccount: z.string().min(2).max(200).trim().optional(),
  // Next of kin
  nextOfKin: nextOfKin.optional(),
  // Attachments — required at registration; URLs minted by POST /uploads/images
  photoUrl: uploadedImageUrl.describe('Customer photo — from POST /uploads/images'),
  idDocumentFrontUrl: uploadedImageUrl.describe(
    'ID front — from POST /uploads/images?kind=document',
  ),
  idDocumentBackUrl: uploadedImageUrl.describe('ID back — from POST /uploads/images?kind=document'),
};

export const createCustomerBody = z.object(profileFields).check((ctx) => {
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
  });
export type UpdateCustomerBody = z.infer<typeof updateCustomerBody>;

export const listCustomersQuery = pagination
  .extend({
    status: z.enum(['active', 'inactive']).optional(),
    search: z.string().min(1).max(100).optional(),
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

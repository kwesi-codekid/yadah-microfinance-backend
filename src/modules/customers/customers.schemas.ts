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
 * What each profile field means, before any wrapper. The forms take these
 * through `clearable` below; the bulk import takes them plain, because
 * `clearable` is a union and a union reports "Invalid input" instead of the
 * rule that was actually broken — which is the only thing a preview screen
 * has to say.
 */
export const profileRules = {
  fullName: z.string().min(2).max(120).trim(),
  dateOfBirth: z.coerce
    .date()
    .refine(
      (d) => isAtLeastYearsOld(d, MIN_CUSTOMER_AGE_YEARS),
      `Customer must be at least ${String(MIN_CUSTOMER_AGE_YEARS)} years old`,
    ),
  gender: z.enum(['male', 'female']),
  nationality: z.string().min(2).max(60).trim(),
  maritalStatus: z.enum(['single', 'married', 'other']),
  residentialAddress: z.string().min(2).max(300).trim(),
  occupation: z.string().min(2).max(120).trim(),
};

/**
 * Every optional field is `clearable`: registration and edit forms submit a
 * blank input as "" rather than omitting it, and the office must be able to
 * wipe a wrong alternate number instead of being stuck with it.
 */
export const profileFields = {
  // Personal
  fullName: profileRules.fullName,
  dateOfBirth: clearable(profileRules.dateOfBirth).optional(),
  gender: clearable(profileRules.gender).optional(),
  nationality: clearable(profileRules.nationality).optional(),
  maritalStatus: clearable(profileRules.maritalStatus).optional(),
  // Contact
  residentialAddress: clearable(profileRules.residentialAddress).optional(),
  phone: ghanaPhone,
  altPhone: clearable(ghanaPhone).optional(),
  // Identification
  identification: clearable(identification).optional(),
  // Occupation
  occupation: clearable(profileRules.occupation).optional(),
  // Next of kin
  nextOfKin: clearable(nextOfKin).optional(),
  // Attachments — URLs minted by POST /uploads/images. The photo is required at
  // registration. The ID document is optional on the profile (client decision,
  // 10 Sep 2026) but gates credit: no loan or hire-purchase agreement opens
  // without both sides on file, and the service refuses to clear either side
  // while one is running (see lib/id-document.ts).
  photoUrl: uploadedImageUrl.describe('Customer photo — from POST /uploads/images'),
  idDocumentFrontUrl: clearable(uploadedImageUrl)
    .optional()
    .describe('ID front — from POST /uploads/images?kind=document; "" or null clears it'),
  idDocumentBackUrl: clearable(uploadedImageUrl)
    .optional()
    .describe('ID back — from POST /uploads/images?kind=document; "" or null clears it'),
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

/**
 * One customer as a bulk import produces them. Every rule is borrowed from
 * `profileFields`, so a spreadsheet is held to exactly what the registration
 * form is held to — except the photo, which no column can carry.
 */
export const importedCustomer = z
  .object({
    fullName: profileRules.fullName,
    phone: ghanaPhone,
    dateOfBirth: profileRules.dateOfBirth.optional(),
    gender: profileRules.gender.optional(),
    maritalStatus: profileRules.maritalStatus.optional(),
    nationality: profileRules.nationality.optional(),
    occupation: profileRules.occupation.optional(),
    residentialAddress: profileRules.residentialAddress.optional(),
    altPhone: ghanaPhone.optional(),
    identification: identification.optional(),
    nextOfKin: nextOfKin.optional(),
    assignedCollectorId: objectId,
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
export type ImportedCustomer = z.infer<typeof importedCustomer>;

/**
 * The corrected sheet coming back from the preview. Cells stay strings — the
 * office edits text, and the server is the one that decides what it means, so
 * a bad cell is reported against its column instead of rejecting the request.
 */
export const importRowsBody = z.object({
  rows: z
    .array(
      z.object({
        /** The sheet row this came from, so a failure names the right line. */
        row: z.number().int().min(1).optional(),
        values: z.record(z.string(), z.string()),
      }),
    )
    .min(1, 'No rows were sent'),
});
export type ImportRowsBody = z.infer<typeof importRowsBody>;
export type ImportRowInput = ImportRowsBody['rows'][number];

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

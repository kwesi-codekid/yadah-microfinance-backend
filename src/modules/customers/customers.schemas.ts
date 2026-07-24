import { z } from 'zod';
import { ghanaCardNumber, ghanaPhone, objectId, pagination } from '../../schemas/common.js';

/** GhanaPost GPS digital address, e.g. WR-123-4567 or GA-1834-5678. */
export const ghanaPostGps = z
  .string()
  .regex(/^[A-Z]{2}-\d{3,4}-\d{4}$/i, 'Expected a GhanaPost address like WR-123-4567')
  .transform((v) => v.toUpperCase());

export const identification = z
  .object({
    idType: z.enum(['ghana-card', 'passport', 'drivers-license', 'voter-id']),
    idNumber: z.string().min(3).max(30).trim(),
    idExpiryDate: z.coerce.date().optional(),
    idPlaceOfIssue: z.string().min(2).max(100).trim().optional(),
  })
  .check((ctx) => {
    if (
      ctx.value.idType === 'ghana-card' &&
      !ghanaCardNumber.safeParse(ctx.value.idNumber).success
    ) {
      ctx.issues.push({
        code: 'custom',
        message: 'Ghana Card numbers look like GHA-123456789-0',
        path: ['idNumber'],
        input: ctx.value.idNumber,
      });
    }
  });

export const nextOfKin = z.object({
  fullName: z.string().min(2).max(120).trim(),
  relationship: z.string().min(2).max(60).trim().optional(),
  phone: ghanaPhone.optional(),
  address: z.string().min(2).max(300).trim().optional(),
});

const profileFields = {
  // Personal
  fullName: z.string().min(2).max(120).trim(),
  dateOfBirth: z.coerce.date().max(new Date(), 'Date of birth must be in the past').optional(),
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
  // Administration
  assignedCollectorId: objectId.optional(),
};

export const createCustomerBody = z.object(profileFields);
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

export const listCustomersQuery = pagination.extend({
  status: z.enum(['active', 'inactive']).optional(),
  assignedCollectorId: objectId.optional(),
  search: z.string().min(1).max(100).optional(),
});
export type ListCustomersQuery = z.infer<typeof listCustomersQuery>;

export const customerIdParams = z.object({ id: objectId });
export type CustomerIdParams = z.infer<typeof customerIdParams>;

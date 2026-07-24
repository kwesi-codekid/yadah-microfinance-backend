import { z } from 'zod';
import { ghanaCardNumber, ghanaPhone, objectId, pagination } from '../../schemas/common.js';

/** GhanaPost GPS digital address, e.g. WR-123-4567 or GA-1834-5678. */
export const ghanaPostGps = z
  .string()
  .regex(/^[A-Z]{2}-\d{3,4}-\d{4}$/i, 'Expected a GhanaPost address like WR-123-4567')
  .transform((v) => v.toUpperCase());

export const createCustomerBody = z.object({
  fullName: z.string().min(2).max(120).trim(),
  phone: ghanaPhone,
  altPhone: ghanaPhone.optional(),
  ghanaCardNumber: ghanaCardNumber.optional(),
  residentialAddress: z.string().min(2).max(300).trim().optional(),
  ghanaPostGps: ghanaPostGps.optional(),
  assignedCollectorId: objectId.optional(),
});
export type CreateCustomerBody = z.infer<typeof createCustomerBody>;

export const updateCustomerBody = z
  .object({
    fullName: z.string().min(2).max(120).trim().optional(),
    phone: ghanaPhone.optional(),
    altPhone: ghanaPhone.optional(),
    ghanaCardNumber: ghanaCardNumber.optional(),
    residentialAddress: z.string().min(2).max(300).trim().optional(),
    ghanaPostGps: ghanaPostGps.optional(),
    assignedCollectorId: objectId.optional(),
  })
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

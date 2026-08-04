import { z } from 'zod';
import { ghanaPhone, objectId, pagination } from '../../schemas/common.js';
import { passwordField, username } from '../auth/auth.schemas.js';

const ROLE = z.enum(['admin', 'manager', 'collector']);
const STATUS = z.enum(['active', 'disabled']);

export const createUserBody = z.object({
  name: z.string().min(2).max(100).trim(),
  username,
  phone: ghanaPhone,
  email: z.email().optional(),
  role: ROLE,
  password: z.string().min(8).max(128),
});
export type CreateUserBody = z.infer<typeof createUserBody>;

export const updateUserBody = z
  .object({
    name: z.string().min(2).max(100).trim().optional(),
    phone: ghanaPhone.optional(),
    email: z.email().optional(),
    role: ROLE.optional(),
  })
  .refine((v) => Object.values(v).some((f) => f !== undefined), {
    message: 'At least one field must be provided',
  });
export type UpdateUserBody = z.infer<typeof updateUserBody>;

export const listUsersQuery = pagination.extend({
  role: ROLE.optional(),
  status: STATUS.optional(),
  search: z.string().min(1).max(100).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuery>;

export const userIdParams = z.object({ id: objectId });
export type UserIdParams = z.infer<typeof userIdParams>;

export const resetUserPasswordBody = z.object({
  newPassword: passwordField,
});
export type ResetUserPasswordBody = z.infer<typeof resetUserPasswordBody>;

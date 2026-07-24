import { z } from 'zod';
import { ghanaPhone } from '../../schemas/common.js';

export const loginBody = z.object({
  phone: ghanaPhone,
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof loginBody>;

export const refreshBody = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshBody = z.infer<typeof refreshBody>;

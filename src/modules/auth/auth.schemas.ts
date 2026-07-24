import { z } from 'zod';
import { ghanaPhone } from '../../schemas/common.js';

export const username = z
  .string()
  .min(3)
  .max(30)
  .regex(/^[a-z0-9._-]+$/i, 'Username may contain letters, digits, dots, dashes, underscores')
  .transform((v) => v.toLowerCase());

export const loginBody = z.object({
  username,
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof loginBody>;

export const otpRequestBody = z.object({
  phone: ghanaPhone,
});
export type OtpRequestBody = z.infer<typeof otpRequestBody>;

export const otpVerifyBody = z.object({
  phone: ghanaPhone,
  code: z.string().regex(/^\d{6}$/, 'Code is 6 digits'),
});
export type OtpVerifyBody = z.infer<typeof otpVerifyBody>;

export const refreshBody = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshBody = z.infer<typeof refreshBody>;

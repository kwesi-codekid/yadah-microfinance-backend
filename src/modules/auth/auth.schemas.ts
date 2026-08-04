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

export const passwordField = z.string().min(8).max(128);

export const changePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordField,
});
export type ChangePasswordBody = z.infer<typeof changePasswordBody>;

export const forgotPasswordBody = z.object({ phone: ghanaPhone });
export type ForgotPasswordBody = z.infer<typeof forgotPasswordBody>;

export const resetPasswordBody = z.object({
  phone: ghanaPhone,
  code: z.string().regex(/^\d{6}$/, 'Code is 6 digits'),
  newPassword: passwordField,
});
export type ResetPasswordBody = z.infer<typeof resetPasswordBody>;

// Response shapes (documentation only — services build these in code).

export const publicUserResponse = z
  .object({
    id: z.string(),
    name: z.string(),
    username: z.string(),
    phone: z.string(),
    email: z.string().optional(),
    role: z.enum(['admin', 'manager', 'collector']),
  })
  .meta({ id: 'PublicUser' });

export const authTokensResponse = z
  .object({
    accessToken: z.string().describe('JWT, ~15 min lifetime. Send as `Authorization: Bearer`.'),
    refreshToken: z.string().describe('Opaque, single-use — rotated on every refresh.'),
  })
  .meta({ id: 'AuthTokens' });

import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import {
  authTokensResponse,
  changePasswordBody,
  forgotPasswordBody,
  loginBody,
  otpRequestBody,
  otpVerifyBody,
  publicUserResponse,
  refreshBody,
  resetPasswordBody,
} from './auth.schemas.js';

const loginResult = z.object({ user: publicUserResponse, tokens: authTokensResponse });

export const authPaths: ZodOpenApiPathsObject = {
  '/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Login with username and password',
      requestBody: jsonBody(loginBody),
      responses: {
        '200': jsonResponse('Authenticated', loginResult),
        '401': errorResponse('INVALID_CREDENTIALS — username or password incorrect'),
      },
    },
  },
  '/auth/otp/request': {
    post: {
      tags: ['Auth'],
      summary: 'Request a login OTP by phone',
      description:
        'Sends a 6-digit code by SMS (and email when the account has one). ' +
        'Response is identical whether or not the phone is registered. ' +
        'Code expires in 5 minutes; max 5 verify attempts; 60s resend cooldown.',
      requestBody: jsonBody(otpRequestBody),
      responses: {
        '200': jsonResponse('Code sent (or silently skipped)', z.object({ message: z.string() })),
        '429': errorResponse('OTP_COOLDOWN — wait before requesting another code'),
      },
    },
  },
  '/auth/otp/verify': {
    post: {
      tags: ['Auth'],
      summary: 'Login by verifying a phone OTP',
      requestBody: jsonBody(otpVerifyBody),
      responses: {
        '200': jsonResponse('Authenticated', loginResult),
        '401': errorResponse('INVALID_OTP — code incorrect, expired, or attempts exhausted'),
      },
    },
  },
  '/auth/refresh': {
    post: {
      tags: ['Auth'],
      summary: 'Rotate the refresh token',
      description:
        'Returns a new access + refresh token pair. The presented refresh token is ' +
        'invalidated; reusing an old one revokes the whole session.',
      requestBody: jsonBody(refreshBody),
      responses: {
        '200': jsonResponse('New token pair', z.object({ tokens: authTokensResponse })),
        '401': errorResponse('INVALID_REFRESH_TOKEN'),
      },
    },
  },
  '/auth/logout': {
    post: {
      tags: ['Auth'],
      summary: 'Logout (revoke the refresh session)',
      requestBody: jsonBody(refreshBody),
      responses: {
        '204': { description: 'Session revoked' },
      },
    },
  },
  '/auth/password/change': {
    post: {
      tags: ['Auth'],
      summary: 'Change own password (authenticated)',
      description:
        'Requires the current password. All OTHER sessions are revoked; the session ' +
        'making the change survives.',
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody(changePasswordBody),
      responses: {
        '204': { description: 'Password changed' },
        '401': errorResponse('INVALID_CREDENTIALS — current password wrong'),
      },
    },
  },
  '/auth/password/forgot': {
    post: {
      tags: ['Auth'],
      summary: 'Request a password-reset OTP by phone',
      description: 'Same cooldown/attempt limits as the login OTP; never leaks account existence.',
      requestBody: jsonBody(forgotPasswordBody),
      responses: {
        '200': jsonResponse('Code sent (or silently skipped)', z.object({ message: z.string() })),
        '429': errorResponse('OTP_COOLDOWN'),
      },
    },
  },
  '/auth/password/reset': {
    post: {
      tags: ['Auth'],
      summary: 'Reset password with a phone OTP',
      description: 'Verifies the single-use code, sets the new password, revokes ALL sessions.',
      requestBody: jsonBody(resetPasswordBody),
      responses: {
        '204': { description: 'Password reset' },
        '401': errorResponse('INVALID_OTP'),
      },
    },
  },
  '/auth/me': {
    get: {
      tags: ['Auth'],
      summary: 'Current authenticated user',
      security: [{ bearerAuth: [] }],
      responses: {
        '200': jsonResponse('The caller', z.object({ user: publicUserResponse })),
        '401': errorResponse('UNAUTHORIZED — missing or invalid Bearer token'),
      },
    },
  },
};

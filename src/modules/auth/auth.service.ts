import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { sendEmail, otpEmailHtml } from '../../lib/email.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { accraMonthKey } from '../../lib/time.js';
import { AuthOtpModel } from '../../models/auth-otp.model.js';
import { SmsLogModel, UserModel, type User } from '../../models/index.js';
import type { Role } from '../../models/shared.js';
import type { HydratedDocument } from 'mongoose';

export const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_SESSIONS_PER_USER = 5;
export const BCRYPT_COST = 12;

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

export interface AccessTokenPayload {
  sub: string; // user id
  role: Role;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface PublicUser {
  id: string;
  name: string;
  username: string;
  phone: string;
  email?: string;
  role: Role;
}

function toPublicUser(user: User): PublicUser {
  return {
    id: user._id.toHexString(),
    name: user.name,
    username: user.username,
    phone: user.phone,
    ...(user.email !== undefined ? { email: user.email } : {}),
    role: user.role,
  };
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Opaque refresh token: <userId>.<familyId>.<secret> */
function buildRefreshToken(userId: string, familyId: string, secret: string): string {
  return `${userId}.${familyId}.${secret}`;
}

function parseRefreshToken(token: string): { userId: string; familyId: string; secret: string } {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new AppError('INVALID_REFRESH_TOKEN', 'Malformed refresh token', 401);
  }
  const [userId, familyId, secret] = parts as [string, string, string];
  return { userId, familyId, secret };
}

function signAccessToken(user: User): string {
  const payload: AccessTokenPayload = { sub: user._id.toHexString(), role: user.role };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
  } catch {
    throw new AppError('INVALID_TOKEN', 'Access token is invalid or expired', 401);
  }
}

/** Creates a refresh session on the user and returns both tokens. */
async function issueSession(user: HydratedDocument<User>): Promise<AuthTokens> {
  const familyId = randomUUID();
  const secret = randomBytes(48).toString('base64url');
  const now = new Date();

  // Newest sessions win; cap concurrent sessions per user.
  user.refreshSessions = [
    {
      familyId,
      tokenHash: hashSecret(secret),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      createdAt: now,
    },
    ...user.refreshSessions.filter((s) => s.expiresAt > now),
  ].slice(0, MAX_SESSIONS_PER_USER);
  await user.save();

  return {
    accessToken: signAccessToken(user),
    refreshToken: buildRefreshToken(user._id.toHexString(), familyId, secret),
  };
}

// ---------------------------------------------------------------- password login

export async function login(
  usernameInput: string,
  password: string,
): Promise<{ user: PublicUser; tokens: AuthTokens }> {
  const user = await UserModel.findOne({ username: usernameInput });
  // Compare against a dummy hash on unknown username so response timing is uniform.
  const hash = user?.passwordHash ?? '$2b$12$C6UzMDM.H6dfI/f/IKcEeO7ZUbFMKxHNGDvUkROuZDx6cChQR/oW6';
  const passwordOk = await bcrypt.compare(password, hash);
  if (!user || !passwordOk || user.status !== 'active') {
    throw new AppError('INVALID_CREDENTIALS', 'Username or password is incorrect', 401);
  }
  return { user: toPublicUser(user), tokens: await issueSession(user) };
}

// ---------------------------------------------------------------- OTP login

/**
 * Sends a 6-digit code by SMS (queued — the gateway worker is task 4.1) and,
 * when the user has an email, by email too. Response is identical whether or
 * not the phone exists, so account existence is not leaked.
 */
export async function requestOtp(phone: string): Promise<void> {
  const user = await UserModel.findOne({ phone, status: 'active' });
  if (!user) return;

  const existing = await AuthOtpModel.findOne({ userId: user._id });
  if (existing && Date.now() - existing.lastSentAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
    throw new AppError('OTP_COOLDOWN', 'Please wait a minute before requesting another code', 429);
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const now = new Date();
  await AuthOtpModel.updateOne(
    { userId: user._id },
    {
      $set: {
        phone,
        codeHash: hashSecret(code),
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        attempts: 0,
        lastSentAt: now,
      },
    },
    { upsert: true },
  );

  // SMS: enqueue for the retry worker (fire-and-forget by design).
  await SmsLogModel.create({
    to: phone,
    template: 'login-otp',
    message: `Your Yadah login code is ${code}. It expires in 5 minutes. Never share it.`,
    status: 'queued',
    monthKey: accraMonthKey(now),
    relatedEntityType: 'user',
    relatedEntityId: user._id,
  });

  // Email copy when available — also fire-and-forget.
  if (user.email !== undefined) {
    await sendEmail(user.email, `${code} is your Yadah login code`, otpEmailHtml(code, user.name));
  }

  if (env.NODE_ENV === 'development') {
    logger.info({ phone }, `dev-only OTP: ${code}`);
  }
}

export async function verifyOtp(
  phone: string,
  code: string,
): Promise<{ user: PublicUser; tokens: AuthTokens }> {
  const invalid = new AppError('INVALID_OTP', 'Code is incorrect or expired', 401);

  const user = await UserModel.findOne({ phone, status: 'active' });
  if (!user) throw invalid;

  const otp = await AuthOtpModel.findOne({ userId: user._id });
  if (!otp) throw invalid;
  if (otp.expiresAt <= new Date()) throw invalid;

  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    await AuthOtpModel.deleteOne({ _id: otp._id });
    throw invalid;
  }

  if (otp.codeHash !== hashSecret(code)) {
    await AuthOtpModel.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } });
    throw invalid;
  }

  await AuthOtpModel.deleteOne({ _id: otp._id }); // single use
  return { user: toPublicUser(user), tokens: await issueSession(user) };
}

// ---------------------------------------------------------------- refresh / logout / me

export async function refresh(refreshToken: string): Promise<AuthTokens> {
  const { userId, familyId, secret } = parseRefreshToken(refreshToken);
  const invalid = new AppError('INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired', 401);

  const user = await UserModel.findById(userId);
  if (user?.status !== 'active') throw invalid;

  const session = user.refreshSessions.find((s) => s.familyId === familyId);
  if (!session) throw invalid;
  if (session.expiresAt <= new Date()) throw invalid;

  if (session.tokenHash !== hashSecret(secret)) {
    // Family exists but the secret is stale: this token was already rotated
    // away, so someone is replaying an old (possibly stolen) token. Kill the
    // whole family so neither party can continue with it.
    user.refreshSessions = user.refreshSessions.filter((s) => s.familyId !== familyId);
    await user.save();
    logger.warn({ userId, familyId }, 'refresh token reuse detected — session family revoked');
    throw invalid;
  }

  // Rotate: same family, new secret, fresh expiry.
  const newSecret = randomBytes(48).toString('base64url');
  session.tokenHash = hashSecret(newSecret);
  session.expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await user.save();

  return {
    accessToken: signAccessToken(user),
    refreshToken: buildRefreshToken(userId, familyId, newSecret),
  };
}

export async function logout(refreshToken: string): Promise<void> {
  const { userId, familyId } = parseRefreshToken(refreshToken);
  await UserModel.updateOne({ _id: userId }, { $pull: { refreshSessions: { familyId } } });
}

export async function getMe(userId: string): Promise<PublicUser> {
  const user = await UserModel.findById(userId);
  if (!user) throw new AppError('NOT_FOUND', 'User no longer exists', 404);
  return toPublicUser(user);
}

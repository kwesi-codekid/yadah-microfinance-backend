import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { enqueueSms } from '../../lib/sms.js';
import { CustomerModel, PortalOtpModel, PortalSessionModel } from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';

/**
 * Customer portal authentication: phone + one-time code, no stored credential.
 *
 * Any ACTIVE customer can log in on the phone number already on their record —
 * there is no separate enrolment step (client decision 2026-08-27). Possession
 * of the registered handset is the whole credential, which is why the code is
 * short-lived, attempt-capped and rate-limited below.
 */

export const PORTAL_ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_SESSIONS_PER_CUSTOMER = 5;

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * Portal tokens are signed with a key DERIVED from the staff secret rather
 * than the secret itself, so a portal token cannot verify as a staff token
 * even if a future refactor drops the `typ` check. Derivation keeps this to
 * one configured secret — there is no second env var to forget on deploy.
 */
const PORTAL_JWT_SECRET = createHmac('sha256', env.JWT_ACCESS_SECRET)
  .update('yadah:customer-portal:v1')
  .digest('hex');

export interface CustomerTokenPayload {
  /** Customer id. */
  sub: string;
  typ: 'customer';
  /** Refresh-session family this token belongs to. */
  fam: string;
}

export interface PortalTokens {
  accessToken: string;
  refreshToken: string;
}

export interface PortalProfile {
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  photoUrl?: string;
  status: string;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Opaque refresh token: <customerId>.<familyId>.<secret> */
function buildRefreshToken(customerId: string, familyId: string, secret: string): string {
  return `${customerId}.${familyId}.${secret}`;
}

function parseRefreshToken(token: string): {
  customerId: string;
  familyId: string;
  secret: string;
} {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new AppError('INVALID_REFRESH_TOKEN', 'Malformed refresh token', 401);
  }
  const [customerId, familyId, secret] = parts as [string, string, string];
  return { customerId, familyId, secret };
}

function signAccessToken(customerId: string, familyId: string): string {
  const payload: CustomerTokenPayload = { sub: customerId, typ: 'customer', fam: familyId };
  return jwt.sign(payload, PORTAL_JWT_SECRET, { expiresIn: PORTAL_ACCESS_TOKEN_TTL });
}

export function verifyCustomerToken(token: string): CustomerTokenPayload {
  let payload: CustomerTokenPayload;
  try {
    payload = jwt.verify(token, PORTAL_JWT_SECRET) as CustomerTokenPayload;
  } catch {
    throw new AppError('INVALID_TOKEN', 'Access token is invalid or expired', 401);
  }
  // jwt.verify returns whatever was signed, so the cast above is a promise, not
  // a fact — check the audience claim actually present on the decoded payload.
  if ((payload as { typ?: unknown }).typ !== 'customer') {
    throw new AppError('INVALID_TOKEN', 'This token is not valid for the customer portal', 401);
  }
  return payload;
}

function toPortalProfile(c: {
  _id: Types.ObjectId;
  fullName: string;
  phone: string;
  email?: string;
  photoUrl?: string;
  status: string;
}): PortalProfile {
  return {
    id: c._id.toHexString(),
    fullName: c.fullName,
    phone: c.phone,
    ...(c.email !== undefined ? { email: c.email } : {}),
    ...(c.photoUrl !== undefined ? { photoUrl: c.photoUrl } : {}),
    status: c.status,
  };
}

async function issueSession(customerId: Types.ObjectId): Promise<PortalTokens> {
  const familyId = randomUUID();
  const secret = randomBytes(48).toString('base64url');
  const now = new Date();

  await PortalSessionModel.create({
    customerId,
    familyId,
    tokenHash: hashSecret(secret),
    expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
  });

  // Newest sessions win; cap concurrent handsets per customer.
  const stale = await PortalSessionModel.find({ customerId })
    .sort({ createdAt: -1 })
    .skip(MAX_SESSIONS_PER_CUSTOMER)
    .select({ _id: 1 });
  if (stale.length > 0) {
    await PortalSessionModel.deleteMany({ _id: { $in: stale.map((s) => s._id) } });
  }

  return {
    accessToken: signAccessToken(customerId.toHexString(), familyId),
    refreshToken: buildRefreshToken(customerId.toHexString(), familyId, secret),
  };
}

/**
 * Send a login code to a registered customer phone.
 *
 * Returns silently when the number belongs to nobody, so the endpoint cannot
 * be used to discover which numbers are customers.
 */
export async function requestOtp(phone: string): Promise<void> {
  const customer = await CustomerModel.findOne({ phone, status: 'active', ...NOT_TRASHED });
  if (!customer) return;

  const existing = await PortalOtpModel.findOne({ customerId: customer._id });
  if (existing && Date.now() - existing.lastSentAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
    throw new AppError('OTP_COOLDOWN', 'Please wait a minute before requesting another code', 429);
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const now = new Date();
  await PortalOtpModel.updateOne(
    { customerId: customer._id },
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

  await enqueueSms({
    to: phone,
    template: 'portal-login-otp',
    message: `Your Yadah login code is ${code}. It expires in 5 minutes. Never share it.`,
    relatedEntityType: 'customer',
    relatedEntityId: customer._id,
  });
}

export async function verifyOtp(
  phone: string,
  code: string,
): Promise<{ tokens: PortalTokens; customer: PortalProfile }> {
  // One error for every failure mode: a wrong code and an unknown number must
  // be indistinguishable, or the endpoint enumerates customers.
  const invalid = new AppError('INVALID_OTP', 'That code is incorrect or has expired', 401);

  const customer = await CustomerModel.findOne({ phone, status: 'active', ...NOT_TRASHED });
  if (!customer) throw invalid;

  const otp = await PortalOtpModel.findOne({ customerId: customer._id });
  if (!otp || otp.expiresAt <= new Date()) throw invalid;

  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    throw new AppError('OTP_LOCKED', 'Too many attempts — request a new code', 429);
  }

  if (otp.codeHash !== hashSecret(code)) {
    await PortalOtpModel.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } });
    throw invalid;
  }

  // Single use: the code dies with the login it authorised.
  await PortalOtpModel.deleteOne({ _id: otp._id });

  return {
    tokens: await issueSession(customer._id),
    customer: toPortalProfile(customer),
  };
}

export async function refresh(refreshToken: string): Promise<PortalTokens> {
  const { customerId, familyId, secret } = parseRefreshToken(refreshToken);
  const invalid = new AppError('INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired', 401);

  const customer = await CustomerModel.findOne({
    _id: customerId,
    status: 'active',
    ...NOT_TRASHED,
  });
  if (!customer) throw invalid;

  const session = await PortalSessionModel.findOne({ familyId, customerId });
  if (!session || session.expiresAt <= new Date()) throw invalid;

  if (session.tokenHash !== hashSecret(secret)) {
    // The family exists but this secret is stale, so the token was already
    // rotated away — someone is replaying an old one. Kill the family.
    await PortalSessionModel.deleteOne({ _id: session._id });
    logger.warn({ customerId, familyId }, 'portal refresh token reuse — session family revoked');
    throw invalid;
  }

  const newSecret = randomBytes(48).toString('base64url');
  await PortalSessionModel.updateOne(
    { _id: session._id },
    {
      $set: {
        tokenHash: hashSecret(newSecret),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    },
  );

  return {
    accessToken: signAccessToken(customerId, familyId),
    refreshToken: buildRefreshToken(customerId, familyId, newSecret),
  };
}

export async function logout(refreshToken: string): Promise<void> {
  const { customerId, familyId } = parseRefreshToken(refreshToken);
  await PortalSessionModel.deleteOne({ familyId, customerId });
}

export async function getProfile(customerId: string): Promise<PortalProfile> {
  const customer = await CustomerModel.findOne({ _id: customerId, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer no longer exists', 404);
  return toPortalProfile(customer);
}

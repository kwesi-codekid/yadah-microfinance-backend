import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import type { Request, Response } from 'express';
import { AppError } from '../lib/errors.js';
import type { AccessTokenPayload } from '../modules/auth/auth.service.js';
import { requireRole } from './rbac.js';

const asAdmin: AccessTokenPayload = { sub: new Types.ObjectId().toHexString(), role: 'admin' };
const asCollector: AccessTokenPayload = {
  sub: new Types.ObjectId().toHexString(),
  role: 'collector',
};

function runMiddleware(auth: AccessTokenPayload, ...roles: Parameters<typeof requireRole>) {
  const mw = requireRole(...roles);
  let passed: unknown = 'not-called';
  mw({ auth } as unknown as Request, {} as Response, (err?: unknown) => {
    passed = err;
  });
  return passed;
}

describe('requireRole', () => {
  it('passes a listed role through', () => {
    expect(runMiddleware(asAdmin, 'admin', 'manager')).toBeUndefined();
  });

  it('rejects an unlisted role with FORBIDDEN 403', () => {
    const err = runMiddleware(asCollector, 'admin', 'manager');
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(403);
    expect((err as AppError).code).toBe('FORBIDDEN');
  });

  it('allows collectors where listed', () => {
    expect(runMiddleware(asCollector, 'admin', 'manager', 'collector')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import type { Request, Response } from 'express';
import { AppError } from '../lib/errors.js';
import type { AccessTokenPayload } from '../modules/auth/auth.service.js';
import { assertCanActOnCustomer, customerScopeFilter, requireRole } from './rbac.js';

const collectorId = new Types.ObjectId();
const otherCollectorId = new Types.ObjectId();

const asAdmin: AccessTokenPayload = { sub: new Types.ObjectId().toHexString(), role: 'admin' };
const asCollector: AccessTokenPayload = { sub: collectorId.toHexString(), role: 'collector' };

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
});

describe('customerScopeFilter', () => {
  it('is unrestricted for admin and manager', () => {
    expect(customerScopeFilter(asAdmin)).toEqual({});
    expect(customerScopeFilter({ ...asAdmin, role: 'manager' })).toEqual({});
  });

  it('pins collectors to their own customers', () => {
    expect(customerScopeFilter(asCollector)).toEqual({ assignedCollectorId: collectorId });
  });
});

describe('assertCanActOnCustomer', () => {
  it('lets office roles act on anyone', () => {
    expect(() => {
      assertCanActOnCustomer(asAdmin, { assignedCollectorId: otherCollectorId });
    }).not.toThrow();
  });

  it('lets a collector act on an assigned customer', () => {
    expect(() => {
      assertCanActOnCustomer(asCollector, { assignedCollectorId: collectorId });
    }).not.toThrow();
  });

  it('blocks a collector on someone else’s customer', () => {
    expect(() => {
      assertCanActOnCustomer(asCollector, { assignedCollectorId: otherCollectorId });
    }).toThrow(AppError);
  });

  it('blocks a collector on an unassigned customer', () => {
    expect(() => {
      assertCanActOnCustomer(asCollector, {});
    }).toThrow(AppError);
  });
});

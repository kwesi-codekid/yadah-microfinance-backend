import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The portal's single most important property: a customer token must never be
 * accepted by a staff endpoint.
 *
 * It matters because staff routes decide access from `role` alone, and
 * `isScoped()` narrows queries only for collectors — so a customer token that
 * slipped through `requireAuth` would be treated as UNSCOPED office staff and
 * could read every customer's money. Two independent defences are asserted
 * here: different signing keys, and an explicit audience claim.
 *
 * Env is set before importing the modules under test, because both read their
 * secret at module load.
 */

const SECRET = 'test-jwt-access-secret-for-token-isolation';

let verifyAccessToken: (t: string) => unknown;
let verifyCustomerToken: (t: string) => unknown;
let portalSecret: string;

beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET = SECRET;
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret';
  process.env.MONGO_URI ??= 'mongodb://127.0.0.1:27017/yadah-test';
  process.env.NODE_ENV ??= 'test';

  ({ verifyAccessToken } = await import('../auth/auth.service.js'));
  ({ verifyCustomerToken } = await import('./portal-auth.service.js'));

  // Mirrors the derivation in portal-auth.service.ts.
  portalSecret = createHmac('sha256', SECRET).update('yadah:customer-portal:v1').digest('hex');
});

describe('staff and portal tokens are different currencies', () => {
  it('rejects a portal token at a staff endpoint', () => {
    const portalToken = jwt.sign({ sub: 'cust1', typ: 'customer', fam: 'f1' }, portalSecret, {
      expiresIn: '15m',
    });
    expect(() => verifyAccessToken(portalToken)).toThrow();
  });

  it('rejects a staff token at the portal', () => {
    const staffToken = jwt.sign({ sub: 'user1', role: 'admin', typ: 'staff' }, SECRET, {
      expiresIn: '15m',
    });
    expect(() => verifyCustomerToken(staffToken)).toThrow();
  });

  it('still rejects a customer-typed token even if it were signed with the staff key', () => {
    // The belt to the key separation's braces: if a future refactor ever signed
    // portal tokens with the staff secret, the audience claim still stops it.
    const forged = jwt.sign({ sub: 'cust1', typ: 'customer', fam: 'f1' }, SECRET, {
      expiresIn: '15m',
    });
    expect(() => verifyAccessToken(forged)).toThrow(/not valid for staff/i);
  });

  it('rejects a token with no audience claim at the portal', () => {
    // A staff token minted before the portal existed carries no `typ` at all.
    const legacy = jwt.sign({ sub: 'user1', role: 'manager' }, portalSecret, { expiresIn: '15m' });
    expect(() => verifyCustomerToken(legacy)).toThrow(/not valid for the customer portal/i);
  });

  it('accepts each token at its own door', () => {
    const staffToken = jwt.sign({ sub: 'user1', role: 'collector', typ: 'staff' }, SECRET, {
      expiresIn: '15m',
    });
    const portalToken = jwt.sign({ sub: 'cust1', typ: 'customer', fam: 'f1' }, portalSecret, {
      expiresIn: '15m',
    });

    expect(verifyAccessToken(staffToken)).toMatchObject({ sub: 'user1', role: 'collector' });
    expect(verifyCustomerToken(portalToken)).toMatchObject({ sub: 'cust1', typ: 'customer' });
  });

  it('treats a legacy staff token with no typ as staff', () => {
    // Tokens already in circulation when this shipped must keep working.
    const legacy = jwt.sign({ sub: 'user1', role: 'admin' }, SECRET, { expiresIn: '15m' });
    expect(verifyAccessToken(legacy)).toMatchObject({ sub: 'user1', role: 'admin' });
  });

  it('derives a portal key that is not the staff secret', () => {
    expect(portalSecret).not.toBe(SECRET);
    expect(portalSecret).toHaveLength(64);
  });
});

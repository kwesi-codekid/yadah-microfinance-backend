import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { AccessTokenPayload } from '../modules/auth/auth.service.js';

/**
 * The guard rails on backdating, with the config mocked so both sides of the
 * switch can be exercised. The behaviour when it is ON — where a transaction
 * lands, and what that does to a savings running balance — needs a database
 * and lives in tests/integration/backdating.test.ts.
 */

const config = vi.hoisted(() => ({ allow: true }));
vi.mock('../config/env.js', () => ({
  env: {
    get ALLOW_BACKDATED_ENTRY() {
      return config.allow;
    },
  },
}));

const { resolveOccurredAt } = await import('./backdating.js');

function actor(role: AccessTokenPayload['role']): AccessTokenPayload {
  return { sub: new Types.ObjectId().toHexString(), role };
}

const officer = actor('admin');

/** An Accra day a given number of days before today. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

describe('resolving the day a transaction happened', () => {
  it('is now when no day is named, whatever the switch says', () => {
    const before = Date.now();
    config.allow = false;
    const at = resolveOccurredAt(officer, undefined);
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
    expect(at.getTime()).toBeLessThanOrEqual(Date.now());
    config.allow = true;
  });

  it('refuses a named day while the switch is off', () => {
    config.allow = false;
    expect(() => resolveOccurredAt(officer, daysAgo(3))).toThrow(
      expect.objectContaining({ code: 'BACKDATING_DISABLED', status: 422 }),
    );
    config.allow = true;
  });

  it('keeps the named day and carries the current time of day', () => {
    const day = daysAgo(5);
    const at = resolveOccurredAt(officer, day);
    expect(at.toISOString().slice(0, 10)).toBe(day);
    // The clock time is now's, which is what keeps several entries made
    // minutes apart in the order they were typed.
    expect(at.toISOString().slice(11, 16)).toBe(new Date().toISOString().slice(11, 16));
  });

  it('refuses a collector, whose day is the one being reconciled', () => {
    expect(() => resolveOccurredAt(actor('collector'), daysAgo(1))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
    );
    // The office may.
    expect(() => resolveOccurredAt(actor('manager'), daysAgo(1))).not.toThrow();
    expect(() => resolveOccurredAt(actor('teller'), daysAgo(1))).not.toThrow();
  });

  it('refuses tomorrow', () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(() => resolveOccurredAt(officer, tomorrow)).toThrow(
      expect.objectContaining({ code: 'DATE_IN_FUTURE', status: 422 }),
    );
  });

  it('accepts today', () => {
    expect(() => resolveOccurredAt(officer, daysAgo(0))).not.toThrow();
  });

  it('refuses a year so far back it is a typo', () => {
    expect(() => resolveOccurredAt(officer, '2019-06-01')).toThrow(
      expect.objectContaining({ code: 'DATE_TOO_OLD', status: 422 }),
    );
  });

  it('refuses a date that passes the pattern but is not a real day', () => {
    expect(() => resolveOccurredAt(officer, '2026-02-31')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR', status: 400 }),
    );
  });
});

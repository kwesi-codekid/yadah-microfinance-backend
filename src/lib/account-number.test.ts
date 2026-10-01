import { describe, expect, it } from 'vitest';
import {
  accountNumberPattern,
  accountPeriodKey,
  counterKey,
  formatAccountNumber,
  LEGACY_SAVINGS_PATTERN,
  LEGACY_SUSU_PATTERN,
  parseAccountNumber,
} from './account-number.js';

describe('accountPeriodKey', () => {
  it('is the two-digit year and month of the date', () => {
    expect(accountPeriodKey(new Date('2026-08-27T10:00:00.000Z'))).toBe('2608');
    expect(accountPeriodKey(new Date('2026-01-01T00:00:00.000Z'))).toBe('2601');
    expect(accountPeriodKey(new Date('2026-12-31T23:59:59.000Z'))).toBe('2612');
  });

  it('rolls at the UTC month boundary, which is also the Accra one', () => {
    // Ghana is UTC+0 year-round, so there is no offset to straddle.
    expect(accountPeriodKey(new Date('2026-08-31T23:59:59.999Z'))).toBe('2608');
    expect(accountPeriodKey(new Date('2026-09-01T00:00:00.000Z'))).toBe('2609');
  });
});

describe('formatAccountNumber', () => {
  it('is prefix + period + a four-digit sequence', () => {
    expect(formatAccountNumber('SU', '2608', 1)).toBe('SU26080001');
    expect(formatAccountNumber('SV', '2608', 142)).toBe('SV26080142');
    expect(formatAccountNumber('LN', '2612', 9999)).toBe('LN26129999');
  });

  it('gives every product its own prefix at the same sequence', () => {
    const numbers = (['SU', 'SV', 'LN', 'HP'] as const).map((p) =>
      formatAccountNumber(p, '2608', 7),
    );
    expect(numbers).toEqual(['SU26080007', 'SV26080007', 'LN26080007', 'HP26080007']);
    expect(new Set(numbers).size).toBe(4);
  });

  it('produces numbers that match the pattern for their prefix, and no other', () => {
    const susu = formatAccountNumber('SU', '2608', 42);
    expect(accountNumberPattern('SU').test(susu)).toBe(true);
    expect(accountNumberPattern('SV').test(susu)).toBe(false);
  });

  it('carries no suffix of any kind', () => {
    // The cycle-month suffix went with the per-cycle books: a customer holds
    // one susu account, so their number is the whole of it.
    expect(accountNumberPattern('SU').test('SU26090005')).toBe(true);
    expect(accountNumberPattern('SU').test('SU26090005-SEP')).toBe(false);
  });
});

describe('legacy numbers', () => {
  it('never collide with the new format — old ones are all digits', () => {
    const legacySusu = '482913';
    const legacySavings = '4829130000';
    expect(LEGACY_SUSU_PATTERN.test(legacySusu)).toBe(true);
    expect(LEGACY_SAVINGS_PATTERN.test(legacySavings)).toBe(true);
    // A prefixed number can never be mistaken for a legacy one, which is what
    // lets both shapes live in the same unique index while grandfathered.
    expect(LEGACY_SUSU_PATTERN.test('SU26080001')).toBe(false);
    expect(LEGACY_SAVINGS_PATTERN.test('SV26080001')).toBe(false);
  });

  it('are still accepted by the model regexes', () => {
    // Built the way the models build them, rather than hand-copied: a restated
    // guess drifts silently.
    const susuField = new RegExp(
      `(?:${accountNumberPattern('SU').source})|(?:${LEGACY_SUSU_PATTERN.source})`,
    );
    const savingsField = new RegExp(
      `(?:${accountNumberPattern('SV').source})|(?:${LEGACY_SAVINGS_PATTERN.source})`,
    );
    expect(susuField.test('482913')).toBe(true);
    expect(susuField.test('SU26080001')).toBe(true);
    expect(savingsField.test('4829130000')).toBe(true);
    expect(savingsField.test('SV26080001')).toBe(true);
    // Wrong prefix for the product is rejected.
    expect(susuField.test('SV26080001')).toBe(false);
    // A legacy number with the old cycle-month suffix is no longer a number.
    expect(susuField.test('482913-SEP')).toBe(false);
  });
});

describe('counterKey', () => {
  it('scopes the sequence to one product, for life — never to a month', () => {
    // A number that went back to 0001 each month read to customers as
    // starting over (client decision, 1 Oct 2026).
    expect(counterKey('SU')).toBe('SU');
    expect(counterKey('SV')).not.toBe(counterKey('SU'));
  });
});

describe('the sequence past 9,999', () => {
  it('grows to five digits rather than stopping', () => {
    expect(formatAccountNumber('SV', '2810', 10_000)).toBe('SV281010000');
    expect(accountNumberPattern('SV').test('SV281010000')).toBe(true);
    // Fewer than four sequence digits was never a number.
    expect(accountNumberPattern('SV').test('SV2810123')).toBe(false);
  });
});

describe('parseAccountNumber', () => {
  it('reads the month and sequence back out of a current-format number', () => {
    expect(parseAccountNumber('SV26090360')).toEqual({ prefix: 'SV', period: '2609', seq: 360 });
    expect(parseAccountNumber('SV281010000')).toEqual({
      prefix: 'SV',
      period: '2810',
      seq: 10_000,
    });
  });

  it('is null for a legacy number', () => {
    expect(parseAccountNumber('482913')).toBeNull();
    expect(parseAccountNumber('4829130000')).toBeNull();
  });
});

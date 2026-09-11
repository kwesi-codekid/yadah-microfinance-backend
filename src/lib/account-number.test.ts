import { describe, expect, it } from 'vitest';
import {
  accountNumberPattern,
  bareAccountNumber,
  CYCLE_MONTHS,
  cycleMonthFrom,
  cycleMonthOf,
  accountPeriodKey,
  counterKey,
  formatAccountNumber,
  LEGACY_SAVINGS_PATTERN,
  LEGACY_SUSU_PATTERN,
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
    const susuField = /^(SU\d{8}|\d{6})$/;
    const savingsField = /^(SV\d{8}|\d{10})$/;
    expect(susuField.test('482913')).toBe(true);
    expect(susuField.test('SU26080001')).toBe(true);
    expect(savingsField.test('4829130000')).toBe(true);
    expect(savingsField.test('SV26080001')).toBe(true);
    // Wrong prefix for the product is rejected.
    expect(susuField.test('SV26080001')).toBe(false);
  });
});

describe('counterKey', () => {
  it('scopes the sequence to one product in one month', () => {
    expect(counterKey('SU', '2608')).toBe('SU-2608');
    // Different product or different month means a different, independent counter.
    expect(counterKey('SV', '2608')).not.toBe(counterKey('SU', '2608'));
    expect(counterKey('SU', '2609')).not.toBe(counterKey('SU', '2608'));
  });
});

describe('cycle months', () => {
  it('names the month a date falls in', () => {
    expect(cycleMonthOf(new Date('2026-09-11T00:00:00.000Z'))).toBe('SEP');
    expect(cycleMonthOf(new Date('2026-01-01T00:00:00.000Z'))).toBe('JAN');
    expect(cycleMonthOf(new Date('2026-12-31T23:59:59.000Z'))).toBe('DEC');
  });

  it('covers the calendar exactly once', () => {
    expect(CYCLE_MONTHS).toHaveLength(12);
    expect(new Set(CYCLE_MONTHS).size).toBe(12);
  });
});

describe('susu cycle-month suffix', () => {
  it('appends the chosen month', () => {
    expect(formatAccountNumber('SU', '2609', 5, 'SEP')).toBe('SU26090005-SEP');
  });

  it('lets the cycle month differ from the issue month', () => {
    // Opened on 28 August for a cycle the customer calls September.
    expect(formatAccountNumber('SU', '2608', 12, 'SEP')).toBe('SU26080012-SEP');
  });

  it('refuses a cycle month on any other product', () => {
    expect(() => formatAccountNumber('SV', '2609', 5, 'SEP')).toThrow();
    expect(() => formatAccountNumber('LN', '2609', 5, 'SEP')).toThrow();
  });

  it('validates suffixed and unsuffixed susu numbers alike', () => {
    expect(accountNumberPattern('SU').test('SU26090005-SEP')).toBe(true);
    expect(accountNumberPattern('SU').test('SU26090005')).toBe(true);
    expect(accountNumberPattern('SU').test('SU26090005-SEPT')).toBe(false);
    expect(accountNumberPattern('SU').test('SU26090005-XYZ')).toBe(false);
    expect(accountNumberPattern('SV').test('SV26090005-SEP')).toBe(false);
  });

  it('reads the number back apart', () => {
    expect(bareAccountNumber('SU26090005-SEP')).toBe('SU26090005');
    expect(bareAccountNumber('SU26090005')).toBe('SU26090005');
    expect(bareAccountNumber('123456')).toBe('123456');
    expect(cycleMonthFrom('SU26090005-SEP')).toBe('SEP');
    expect(cycleMonthFrom('SU26090005')).toBeUndefined();
    expect(cycleMonthFrom('SU26090005-NOPE')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import {
  accountNumberPattern,
  accountRef,
  bareAccountNumber,
  CYCLE_MONTHS,
  cycleMonthFrom,
  cycleMonthOf,
  accountPeriodKey,
  counterKey,
  formatAccountNumber,
  LEGACY_SAVINGS_PATTERN,
  LEGACY_SUSU_PATTERN,
  SUSU_STEM_PATTERN,
  withCycleMonth,
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
    // Built the way the models build them, rather than hand-copied: a restated
    // guess drifts silently, and this one already had — it predated the cycle
    // month and would have kept passing through any change to the real rule.
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
  });

  it('accepts a grandfathered susu number wearing a cycle month', () => {
    // A legacy number becomes its owner's stem as it stands, and every stem
    // takes a month. Without this the first carry-forward off an old book
    // throws a validation error inside the money transaction.
    const susuField = new RegExp(
      `(?:${accountNumberPattern('SU').source})|(?:${LEGACY_SUSU_PATTERN.source})`,
    );
    expect(susuField.test('482913-SEP')).toBe(true);
    expect(susuField.test('482913-SEPT')).toBe(false);
    expect(susuField.test('482913-SEP-OCT')).toBe(false);
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

/**
 * One number per customer, for life, with their books separated by month
 * inside it (client decision, 12 Sep 2026). These are the pure half of that
 * rule — the half that can be checked without a database.
 */
describe('the customer susu number', () => {
  const STEM = 'SU26090009';

  it('gives two books opened in one month the identical string', () => {
    // The whole of what the branch asked for: their second September book is
    // not a different account number, it is the same one.
    expect(withCycleMonth(STEM, 'SEP')).toBe('SU26090009-SEP');
    expect(withCycleMonth(STEM, 'SEP')).toBe(withCycleMonth(STEM, 'SEP'));
  });

  it('changes only the month when the customer opens a later book', () => {
    const sep = withCycleMonth(STEM, 'SEP');
    const oct = withCycleMonth(STEM, 'OCT');
    expect(sep).toBe('SU26090009-SEP');
    expect(oct).toBe('SU26090009-OCT');
    expect(bareAccountNumber(sep)).toBe(bareAccountNumber(oct));
    expect(cycleMonthFrom(sep)).not.toBe(cycleMonthFrom(oct));
  });

  it('makes exactly twelve strings out of one stem', () => {
    const family = CYCLE_MONTHS.map((m) => withCycleMonth(STEM, m));
    expect(new Set(family).size).toBe(12);
    expect(new Set(family.map(bareAccountNumber)).size).toBe(1);
  });

  it('never grows a second month onto a number that has one', () => {
    // Callers pass whatever they are holding — an account number as often as a
    // stem — so re-suffixing has to replace, not append.
    expect(withCycleMonth('SU26090009-SEP', 'OCT')).toBe('SU26090009-OCT');
    expect(accountNumberPattern('SU').test('SU26090009-SEP-OCT')).toBe(false);
  });

  it('keeps the month off when there is none to put on', () => {
    expect(withCycleMonth(STEM)).toBe(STEM);
    expect(withCycleMonth('SU26090009-SEP')).toBe(STEM);
  });

  it('suffixes a grandfathered stem as readily as a current one', () => {
    // Their oldest customers keep the number in the passbook they are holding.
    expect(withCycleMonth('482913', 'SEP')).toBe('482913-SEP');
    expect(bareAccountNumber('482913-SEP')).toBe('482913');
  });

  it('tells a stem apart from a whole number', () => {
    expect(SUSU_STEM_PATTERN.test(STEM)).toBe(true);
    expect(SUSU_STEM_PATTERN.test('SU26090009-SEP')).toBe(false);
    expect(SUSU_STEM_PATTERN.test('482913')).toBe(false);
  });

  it('freezes the issue month into the stem, whatever month the book is', () => {
    // The stem records when the CUSTOMER joined, not when this book opened, so
    // an August-issued number wearing -SEP is correct and stays that way.
    const august = formatAccountNumber('SU', '2608', 12);
    expect(withCycleMonth(august, 'SEP')).toBe('SU26080012-SEP');
  });
});

describe('accountRef', () => {
  const OPENED = new Date('2026-09-12T13:45:01.000Z');

  it('is the opening second plus a tail of the id', () => {
    expect(accountRef('68c3f1a2b4d5e6f7a8b9a3f9', OPENED)).toBe('260912134501-a3f9');
  });

  it('separates two books opened in the same second', () => {
    // Which is the case that matters: a payment overflowing into a second book
    // creates both inside one transaction, and a seed loop creates dozens.
    const a = accountRef('aaaaaaaaaaaaaaaaaaaa1111', OPENED);
    const b = accountRef('aaaaaaaaaaaaaaaaaaaa2222', OPENED);
    expect(a).not.toBe(b);
    expect(a.slice(0, 12)).toBe(b.slice(0, 12));
  });

  it('looks nothing like an account number', () => {
    // Deliberate: the two sit in adjacent columns, and two strings of the same
    // shape differing by one digit would be worse than no reference at all.
    const ref = accountRef('68c3f1a2b4d5e6f7a8b9c0a3', OPENED);
    expect(accountNumberPattern('SU').test(ref)).toBe(false);
    expect(LEGACY_SUSU_PATTERN.test(ref)).toBe(false);
  });
});

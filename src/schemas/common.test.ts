import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { clearable, ghanaPhone, normalizeGhanaPhone } from './common.js';

describe('normalizeGhanaPhone', () => {
  const sameNumber: [string, string][] = [
    ['0241234567', '0241234567'],
    ['+233241234567', '0241234567'],
    ['233241234567', '0241234567'],
    ['+233 24 123 4567', '0241234567'],
    ['024 123 4567', '0241234567'],
    ['024-123-4567', '0241234567'],
    ['(024) 123-4567', '0241234567'],
    // Some people write the country code AND keep the trunk zero.
    ['+2330241234567', '0241234567'],
  ];

  it.each(sameNumber)('%s → %s', (input, expected) => {
    expect(normalizeGhanaPhone(input)).toBe(expected);
  });

  it('does not mistake a local 023x number for the 233 country code', () => {
    expect(normalizeGhanaPhone('0231234567')).toBe('0231234567');
  });
});

describe('ghanaPhone', () => {
  it('stores every accepted format as the same local number', () => {
    for (const input of ['0241234567', '+233241234567', '233 24 123 4567', '024-123-4567']) {
      expect(ghanaPhone.parse(input)).toBe('0241234567');
    }
  });

  it('accepts every live mobile prefix', () => {
    for (const prefix of ['020', '023', '024', '026', '027', '050', '054', '055', '056', '057']) {
      expect(ghanaPhone.safeParse(`${prefix}1234567`).success).toBe(true);
    }
  });

  it('rejects landlines — this field is what SMS is sent to', () => {
    expect(ghanaPhone.safeParse('0302123456').success).toBe(false);
  });

  it('rejects wrong lengths and non-numbers', () => {
    for (const bad of ['024123456', '02412345678', '0241234abc', '', '1234567890']) {
      expect(ghanaPhone.safeParse(bad).success).toBe(false);
    }
  });
});

describe('clearable', () => {
  const schema = clearable(z.string().min(2)).optional();

  it('treats a blank string as an explicit clear', () => {
    expect(schema.parse('')).toBeNull();
  });

  it('treats null as an explicit clear', () => {
    expect(schema.parse(null)).toBeNull();
  });

  it('leaves an absent field absent — distinct from cleared', () => {
    expect(schema.parse(undefined)).toBeUndefined();
  });

  it('still validates a real value', () => {
    expect(schema.parse('ok')).toBe('ok');
    expect(schema.safeParse('x').success).toBe(false);
  });
});

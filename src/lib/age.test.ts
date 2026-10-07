import { describe, expect, it } from 'vitest';
import { adultBornBy, ageOn, isMinor } from './age.js';

const born = (day: string) => new Date(`${day}T00:00:00.000Z`);

describe('ageOn', () => {
  it('counts a birthday that has not come yet this year as not yet', () => {
    expect(ageOn(born('2008-10-06'), '2026-10-05')).toBe(17);
    expect(ageOn(born('2008-10-05'), '2026-10-05')).toBe(18);
    expect(ageOn(born('2008-10-04'), '2026-10-05')).toBe(18);
  });

  it('turns a 29 February birthday over on 1 March in a common year', () => {
    expect(ageOn(born('2008-02-29'), '2026-02-28')).toBe(17);
    expect(ageOn(born('2008-02-29'), '2026-03-01')).toBe(18);
  });
});

describe('isMinor', () => {
  it('reads no date of birth as an adult', () => {
    expect(isMinor(undefined)).toBe(false);
    expect(isMinor(null)).toBe(false);
  });

  it('is under 18 up to the day before the 18th birthday', () => {
    expect(isMinor(born('2008-10-06'), '2026-10-05')).toBe(true);
    expect(isMinor(born('2008-10-05'), '2026-10-05')).toBe(false);
  });
});

describe('adultBornBy', () => {
  it('draws the same line as isMinor', () => {
    for (const day of ['2026-10-05', '2028-02-29', '2026-03-01', '2026-01-01']) {
      const cut = adultBornBy(day);
      expect(isMinor(cut, day)).toBe(false);
      expect(isMinor(new Date(cut.getTime() + 1), day)).toBe(true);
    }
  });
});

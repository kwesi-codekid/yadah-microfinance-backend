import { describe, expect, it } from 'vitest';
import { bucketRanges, percentOf, sameSpanLastMonth } from './financials.service.js';

describe('percentOf', () => {
  it('rounds to one decimal', () => {
    expect(percentOf(1, 3)).toBe(33.3);
    expect(percentOf(50_000, 40_000)).toBe(125);
  });

  it('is null when the whole is zero — no deposits means no liquidity ratio, not infinity', () => {
    expect(percentOf(10_000, 0)).toBeNull();
    expect(percentOf(0, 0)).toBeNull();
  });

  it('is zero, not null, when nothing is in arrears on a live book', () => {
    expect(percentOf(0, 90_000)).toBe(0);
  });
});

describe('sameSpanLastMonth', () => {
  it('runs from the 1st of last month to the same day of month', () => {
    expect(sameSpanLastMonth('2026-10-24')).toEqual({ from: '2026-09-01', to: '2026-09-24' });
  });

  it('clamps to the end of a shorter month', () => {
    expect(sameSpanLastMonth('2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(sameSpanLastMonth('2028-03-30')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('wraps January back to December of the previous year', () => {
    expect(sameSpanLastMonth('2027-01-15')).toEqual({ from: '2026-12-01', to: '2026-12-15' });
  });
});

describe('bucketRanges', () => {
  it('gives one span per day for daily buckets', () => {
    expect(bucketRanges('2026-10-01', '2026-10-03', 'day')).toEqual([
      { key: '2026-10-01', from: '2026-10-01', to: '2026-10-01' },
      { key: '2026-10-02', from: '2026-10-02', to: '2026-10-02' },
      { key: '2026-10-03', from: '2026-10-03', to: '2026-10-03' },
    ]);
  });

  it('clamps partial first and last months to the range asked for', () => {
    expect(bucketRanges('2026-09-15', '2026-11-10', 'month')).toEqual([
      { key: '2026-09', from: '2026-09-15', to: '2026-09-30' },
      { key: '2026-10', from: '2026-10-01', to: '2026-10-31' },
      { key: '2026-11', from: '2026-11-01', to: '2026-11-10' },
    ]);
  });

  it('starts weeks on Monday and leaves no day uncovered', () => {
    // 2026-10-21 is a Wednesday; the next week starts Monday 26th.
    const ranges = bucketRanges('2026-10-21', '2026-10-28', 'week');
    expect(ranges.map((r) => [r.from, r.to])).toEqual([
      ['2026-10-21', '2026-10-25'],
      ['2026-10-26', '2026-10-28'],
    ]);
  });
});

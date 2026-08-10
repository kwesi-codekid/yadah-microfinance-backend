import { describe, expect, it } from 'vitest';
import { createdAtFilter, dayWindow } from './time.js';

describe('dayWindow', () => {
  it('converts an inclusive Accra-day range to a UTC window', () => {
    const { start, end } = dayWindow('2026-08-01', '2026-08-03');
    expect(start?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(end?.toISOString()).toBe('2026-08-04T00:00:00.000Z'); // exclusive end
  });

  it('leaves open ends open — no default window', () => {
    expect(dayWindow()).toEqual({});
    expect(dayWindow('2026-08-01').end).toBeUndefined();
    expect(dayWindow(undefined, '2026-08-03').start).toBeUndefined();
  });
});

describe('createdAtFilter', () => {
  it('returns null when no range is given', () => {
    expect(createdAtFilter()).toBeNull();
  });

  it('builds a half-open Mongo filter', () => {
    const filter = createdAtFilter('2026-08-01', '2026-08-01');
    expect(filter).toEqual({
      $gte: new Date('2026-08-01T00:00:00.000Z'),
      $lt: new Date('2026-08-02T00:00:00.000Z'),
    });
  });

  it('supports one-sided ranges', () => {
    expect(createdAtFilter('2026-08-01')).toEqual({ $gte: new Date('2026-08-01T00:00:00.000Z') });
    expect(createdAtFilter(undefined, '2026-08-01')).toEqual({
      $lt: new Date('2026-08-02T00:00:00.000Z'),
    });
  });
});

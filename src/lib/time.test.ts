import { describe, expect, it } from 'vitest';
import { accraDay, createdAtFilter, dayWindow, rangeToWindow } from './time.js';

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

describe('rangeToWindow', () => {
  it('resolves both ends of an explicit range', () => {
    const w = rangeToWindow('2026-08-01', '2026-08-03');
    expect(w.from).toBe('2026-08-01');
    expect(w.to).toBe('2026-08-03');
    expect(w.start.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-08-04T00:00:00.000Z'); // exclusive end
  });

  it('measures a missing start back from the END of the range, not from today', () => {
    // The bug this guards: a report asked for a window ending last March used
    // to come back starting 30 days before *today*, so `from` fell after `to`
    // and the period was empty — or, worse, quietly enormous.
    const w = rangeToWindow(undefined, '2026-03-31');
    expect(w.from).toBe('2026-03-01');
    expect(w.to).toBe('2026-03-31');
    expect(w.start.getTime()).toBeLessThan(w.end.getTime());
  });

  it('ends today when no end is given', () => {
    expect(rangeToWindow().to).toBe(accraDay());
  });

  it('keeps a single day a single day', () => {
    const w = rangeToWindow('2026-08-01', '2026-08-01');
    expect(w.end.getTime() - w.start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

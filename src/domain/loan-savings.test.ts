import { describe, expect, it } from 'vitest';
import {
  amountDueByMonthEnd,
  deductionAmount,
  deductionMonth,
  monthEndExclusive,
  previousMonth,
} from './loan-savings.js';

const day = (d: string): Date => new Date(`${d}T00:00:00.000Z`);

describe('deductionMonth', () => {
  it('is the current month on its last day', () => {
    expect(deductionMonth('2026-10-31')).toBe('2026-10');
    expect(deductionMonth('2026-02-28')).toBe('2026-02');
    expect(deductionMonth('2028-02-29')).toBe('2028-02');
    expect(deductionMonth('2026-12-31')).toBe('2026-12');
  });

  it('catches up on the month just ended during the first three days', () => {
    expect(deductionMonth('2026-11-01')).toBe('2026-10');
    expect(deductionMonth('2026-11-03')).toBe('2026-10');
    expect(deductionMonth('2027-01-02')).toBe('2026-12');
  });

  it('is nothing in the middle of a month', () => {
    expect(deductionMonth('2026-11-04')).toBeNull();
    expect(deductionMonth('2026-10-30')).toBeNull();
    expect(deductionMonth('2028-02-28')).toBeNull(); // a leap year's 28th is not its end
  });
});

describe('month arithmetic', () => {
  it('steps back across a year', () => {
    expect(previousMonth('2027-01')).toBe('2026-12');
    expect(previousMonth('2026-10')).toBe('2026-09');
  });

  it('ends a month at the first instant of the next', () => {
    expect(monthEndExclusive('2026-10').toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(monthEndExclusive('2026-12').toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('amountDueByMonthEnd', () => {
  const loan = { totalDue: 120_000, totalRepaid: 0, dueDate: day('2027-01-15') };
  const schedule = [
    { dueDate: day('2026-11-15'), amountDue: 40_000, amountPaid: 0 },
    { dueDate: day('2026-12-15'), amountDue: 40_000, amountPaid: 0 },
    { dueDate: day('2027-01-15'), amountDue: 40_000, amountPaid: 0 },
  ];

  it('asks for nothing before the first instalment falls due', () => {
    expect(amountDueByMonthEnd(loan, schedule, monthEndExclusive('2026-10'))).toBe(0);
  });

  it("asks for the month's instalment", () => {
    expect(amountDueByMonthEnd(loan, schedule, monthEndExclusive('2026-11'))).toBe(40_000);
  });

  it('asks only for what is unpaid on it', () => {
    const partly = schedule.map((l, i) => (i === 0 ? { ...l, amountPaid: 15_000 } : l));
    expect(amountDueByMonthEnd(loan, partly, monthEndExclusive('2026-11'))).toBe(25_000);
  });

  it('asks for nothing when the month was paid in cash', () => {
    const paid = schedule.map((l, i) => (i === 0 ? { ...l, amountPaid: 40_000 } : l));
    expect(amountDueByMonthEnd(loan, paid, monthEndExclusive('2026-11'))).toBe(0);
  });

  it('catches up arrears from earlier months', () => {
    expect(amountDueByMonthEnd(loan, schedule, monthEndExclusive('2026-12'))).toBe(80_000);
  });

  it('asks for everything left once the loan itself falls due — escalation included', () => {
    const escalated = { totalDue: 130_000, totalRepaid: 80_000, dueDate: day('2027-01-15') };
    const paidTwo = schedule.map((l, i) => (i < 2 ? { ...l, amountPaid: 40_000 } : l));
    expect(amountDueByMonthEnd(escalated, paidTwo, monthEndExclusive('2027-01'))).toBe(50_000);
  });

  it('never asks for more than the loan still owes', () => {
    const nearlyDone = { totalDue: 120_000, totalRepaid: 110_000, dueDate: day('2027-01-15') };
    expect(amountDueByMonthEnd(nearlyDone, schedule, monthEndExclusive('2026-12'))).toBe(10_000);
  });
});

describe('deductionAmount', () => {
  it('takes what is due when the account holds enough', () => {
    expect(deductionAmount(40_000, 100_000)).toBe(40_000);
  });

  it('takes what is there when it holds less — a part payment', () => {
    expect(deductionAmount(40_000, 25_000)).toBe(25_000);
  });

  it('takes nothing when nothing is due or nothing is there', () => {
    expect(deductionAmount(0, 25_000)).toBe(0);
    expect(deductionAmount(40_000, 0)).toBe(0);
  });
});

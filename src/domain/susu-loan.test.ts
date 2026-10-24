import { describe, expect, it } from 'vitest';
import { amountDueBy, deductionAmount, endOfDay } from './susu-loan.js';
import { buildSchedule } from './loans.js';

const day = (d: string): Date => new Date(`${d}T00:00:00.000Z`);
const at = (d: string, time = '12:00'): Date => new Date(`${d}T${time}:00.000Z`);

describe('endOfDay', () => {
  it('is the first instant of the next day', () => {
    expect(endOfDay(at('2026-10-23', '00:00')).toISOString()).toBe('2026-10-24T00:00:00.000Z');
    expect(endOfDay(at('2026-12-31', '23:59')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('amountDueBy', () => {
  // Out on 15 Oct afternoon: instalments fall on 15 Nov, 15 Dec, 15 Jan.
  const loan = { totalDue: 120_000, totalRepaid: 0, dueDate: at('2027-01-15', '14:00') };
  const schedule = buildSchedule(120_000, 3, at('2026-10-15', '14:00')).map((l) => ({
    ...l,
    amountPaid: 0,
  }));

  it('asks for nothing on the day the loan goes out, or before its first date', () => {
    expect(amountDueBy(loan, schedule, at('2026-10-15', '15:00'))).toBe(0);
    expect(amountDueBy(loan, schedule, at('2026-11-14', '23:00'))).toBe(0);
  });

  it("asks for the instalment from the morning of the loan's monthly date", () => {
    expect(amountDueBy(loan, schedule, at('2026-11-15', '00:30'))).toBe(40_000);
  });

  it('keeps asking for what a short month left unpaid, any day after', () => {
    const partly = schedule.map((l, i) => (i === 0 ? { ...l, amountPaid: 15_000 } : l));
    const loanPartly = { ...loan, totalRepaid: 15_000 };
    expect(amountDueBy(loanPartly, partly, at('2026-11-20'))).toBe(25_000);
  });

  it('asks for nothing between dates once the month is covered', () => {
    const paid = schedule.map((l, i) => (i === 0 ? { ...l, amountPaid: 40_000 } : l));
    expect(amountDueBy({ ...loan, totalRepaid: 40_000 }, paid, at('2026-11-20'))).toBe(0);
    expect(amountDueBy({ ...loan, totalRepaid: 40_000 }, paid, at('2026-12-15'))).toBe(40_000);
  });

  it('catches up every month already gone — an old paper loan', () => {
    expect(amountDueBy(loan, schedule, at('2027-01-10'))).toBe(80_000);
  });

  it('counts payments on totals, whichever month they were meant for', () => {
    // 50 000 paid back on paper; 80 000 has fallen due → 30 000 still owed.
    const paper = schedule.map((l, i) =>
      i === 0 ? { ...l, amountPaid: 40_000 } : i === 1 ? { ...l, amountPaid: 10_000 } : l,
    );
    expect(amountDueBy({ ...loan, totalRepaid: 50_000 }, paper, at('2027-01-10'))).toBe(30_000);
  });

  it('asks for nothing when paper repayments already cover what is due', () => {
    const ahead = schedule.map((l, i) => (i < 2 ? { ...l, amountPaid: 40_000 } : l));
    expect(amountDueBy({ ...loan, totalRepaid: 80_000 }, ahead, at('2027-01-10'))).toBe(0);
  });

  it('asks for everything left once the loan itself falls due — escalation included', () => {
    const escalated = { totalDue: 130_000, totalRepaid: 80_000, dueDate: loan.dueDate };
    const paidTwo = schedule.map((l, i) => (i < 2 ? { ...l, amountPaid: 40_000 } : l));
    expect(amountDueBy(escalated, paidTwo, at('2027-01-15', '08:00'))).toBe(50_000);
  });

  it('never asks for more than the loan still owes', () => {
    const nearlyDone = { ...loan, totalRepaid: 110_000 };
    expect(amountDueBy(nearlyDone, schedule, at('2026-12-20'))).toBe(10_000);
  });

  it('falls on the last day of a short month for a loan out on the 31st', () => {
    const jan = buildSchedule(90_000, 3, day('2027-01-31')).map((l) => ({ ...l, amountPaid: 0 }));
    const jLoan = { totalDue: 90_000, totalRepaid: 0, dueDate: day('2027-04-30') };
    expect(amountDueBy(jLoan, jan, at('2027-02-27'))).toBe(0);
    expect(amountDueBy(jLoan, jan, at('2027-02-28'))).toBe(30_000);
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

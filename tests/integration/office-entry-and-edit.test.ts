import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { accraDay } from '../../src/lib/time.js';
import {
  AuditLogModel,
  CommissionModel,
  LoanModel,
  LoanScheduleModel,
  RepaymentModel,
} from '../../src/models/index.js';
import { collectorDay } from '../../src/modules/collectors/collectors.service.js';
import { editLoan } from '../../src/modules/loans/loan-edit.service.js';
import * as loans from '../../src/modules/loans/loans.service.js';
import { recordPaperLoan } from '../../src/modules/loans/paper-loans.service.js';
import { expectedForDay } from '../../src/modules/reconciliation/reconciliation.service.js';
import { listTransactions } from '../../src/modules/reports/transactions.service.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import type { AccessTokenPayload } from '../../src/modules/auth/auth.service.js';
import {
  asOfficer,
  makeCollector,
  makeCustomer,
  makeGuarantor,
  makeTeller,
  setupDb,
  teardownDb,
} from './helpers.js';

/**
 * Client decisions of 4 Nov 2026. The office attendant enters what collectors
 * bring back: the money is filed under the collector, the attendant is kept as
 * whoever typed it. And loans can be fully edited.
 */

let guarantor: Types.ObjectId;
let collector: AccessTokenPayload;
let teller: AccessTokenPayload;
const officer = asOfficer();

beforeAll(async () => {
  await setupDb();
  guarantor = await makeGuarantor();
  collector = await makeCollector('Round Collector');
  teller = await makeTeller('Office Attendant');
});
afterAll(teardownDb);

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

async function activeLoan(customerId: Types.ObjectId, principal = 100_000, months: 3 | 6 | 12 = 3) {
  const applied = await loans.applyForLoan(officer, customerId, principal, months, guarantor);
  const id = new Types.ObjectId(applied.id);
  await loans.approveLoan(officer, id);
  return id;
}

async function openBook(customerId: Types.ObjectId) {
  const { account } = await savings.openAccount(officer, customerId, 50_000, randomUUID(), 'cash');
  return new Types.ObjectId(account.id);
}

describe('entering for a collector', () => {
  const collectorOid = () => new Types.ObjectId(collector.sub);

  it('files a savings deposit under the collector and keeps who typed it', async () => {
    const customer = await makeCustomer(true);
    const { account } = await savings.openAccount(teller, customer, 50_000, randomUUID(), 'cash');
    const { txn } = await savings.deposit(
      teller,
      new Types.ObjectId(account.id),
      5_000,
      randomUUID(),
      'cash',
      undefined,
      undefined,
      collectorOid(),
    );
    expect(txn.recordedById).toBe(collector.sub);
    expect(txn.enteredById).toBe(teller.sub);
    const audit = await AuditLogModel.findOne({
      action: 'savings.deposit.record',
      entityId: new Types.ObjectId(account.id),
    }).sort({ _id: -1 });
    expect(audit?.actorId.toHexString()).toBe(teller.sub);
  });

  it('files a susu deposit under the collector, dated the day before, without the switch', async () => {
    const customer = await makeCustomer(true);
    const { account } = await susu.openAccount(teller, customer, 1_000);
    const { deposit } = await susu.recordDeposit(
      teller,
      new Types.ObjectId(account.id),
      1_000,
      randomUUID(),
      'cash',
      undefined,
      daysAgo(1),
      undefined,
      collectorOid(),
    );
    expect(deposit.collectorId).toBe(collector.sub);
    expect(deposit.enteredById).toBe(teller.sub);
    expect(accraDay(new Date(deposit.createdAt))).toBe(daysAgo(1));
  });

  it('counts loan cash in the collector day, only when entered for them', async () => {
    const customer = await makeCustomer(true);
    const fresh = await makeCollector('Second Collector');
    const freshId = new Types.ObjectId(fresh.sub);
    const before = await expectedForDay(freshId, accraDay());
    expect(before.total).toBe(0);

    const loanId = await activeLoan(customer);
    await loans.repayCash(
      teller,
      loanId,
      1_000,
      randomUUID(),
      'cash',
      undefined,
      undefined,
      freshId,
    );
    // The attendant's own desk money, for nobody: stays out of the count.
    await loans.repayCash(teller, loanId, 4_000, randomUUID(), 'cash');

    const expected = await expectedForDay(freshId, accraDay());
    expect(expected).toMatchObject({ loans: 1_000, total: 1_000, entries: 1 });
    const day = await collectorDay(officer, undefined, freshId);
    expect(day.cashTotal).toBe(1_000);
    expect(day.entries.map((e) => e.product)).toEqual(['loan']);
    expect((await expectedForDay(new Types.ObjectId(teller.sub), accraDay())).loans).toBe(0);
  });

  it('dates an entry within the week for a teller, without the backdating switch', async () => {
    const customer = await makeCustomer(true);
    const book = await openBook(customer);
    const { txn } = await savings.deposit(
      teller,
      book,
      1_500,
      randomUUID(),
      'cash',
      undefined,
      daysAgo(1),
      collectorOid(),
    );
    expect(accraDay(new Date(txn.createdAt))).toBe(daysAgo(1));

    await expect(
      savings.deposit(
        teller,
        book,
        1_500,
        randomUUID(),
        'cash',
        undefined,
        daysAgo(8),
        collectorOid(),
      ),
    ).rejects.toMatchObject({ code: 'DATE_TOO_OLD' });
  });

  it('refuses anyone who is not an active collector, and a collector naming another', async () => {
    const customer = await makeCustomer(true);
    const book = await openBook(customer);
    await expect(
      savings.deposit(
        officer,
        book,
        1_000,
        randomUUID(),
        'cash',
        undefined,
        undefined,
        new Types.ObjectId(teller.sub),
      ),
    ).rejects.toMatchObject({ code: 'COLLECTOR_NOT_FOUND' });

    const other = await makeCollector('Other Collector');
    await expect(
      savings.deposit(
        collector,
        book,
        1_000,
        randomUUID(),
        'cash',
        undefined,
        undefined,
        new Types.ObjectId(other.sub),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('shows the row to both people on the transactions feed', async () => {
    const customer = await makeCustomer(true);
    const fresh = await makeCollector('Feed Collector');
    const typist = await makeTeller('Feed Attendant');
    const loanId = await activeLoan(customer);
    await loans.repayCash(
      typist,
      loanId,
      1_000,
      randomUUID(),
      'cash',
      undefined,
      undefined,
      new Types.ObjectId(fresh.sub),
    );
    const query = { page: 1, limit: 20, customerId: customer } as Parameters<
      typeof listTransactions
    >[0];
    for (const staff of [fresh.sub, typist.sub]) {
      const feed = await listTransactions({ ...query, recordedById: new Types.ObjectId(staff) });
      const row = feed.items.find((r) => r.type === 'loan-repayment');
      expect(row?.recordedByName).toBe('Feed Collector');
      expect(row?.enteredByName).toBe('Feed Attendant');
    }
  });
});

describe('editing a loan', () => {
  it('rewrites a pending application without touching the books', async () => {
    const customer = await makeCustomer(true);
    const applied = await loans.applyForLoan(officer, customer, 100_000, 3, guarantor);
    const edited = await editLoan(officer, new Types.ObjectId(applied.id), {
      principal: 200_000,
      durationMonths: 6,
      processingFee: 5_000,
      reason: 'Agreed a bigger amount',
    });
    expect(edited).toMatchObject({
      principal: 200_000,
      durationMonths: 6,
      ratePercent: 20,
      totalDue: 240_000,
      status: 'pending',
    });
    expect(
      await CommissionModel.countDocuments({ accountId: new Types.ObjectId(applied.id) }),
    ).toBe(0);
  });

  it('rebuilds totals, schedule and repayment allocation on an active loan', async () => {
    const customer = await makeCustomer(true);
    const id = await activeLoan(customer);
    await loans.repayCash(officer, id, 50_000, randomUUID(), 'cash');

    const edited = await editLoan(officer, id, {
      principal: 150_000,
      durationMonths: 6,
      ratePercent: 20,
      reason: 'Typed the wrong amount',
    });
    expect(edited).toMatchObject({
      principal: 150_000,
      totalDue: 180_000,
      totalRepaid: 50_000,
      remaining: 130_000,
      status: 'active',
    });
    // The field the model marks immutable really did change in the database.
    expect((await LoanModel.findById(id))?.principal).toBe(150_000);

    const lines = await LoanScheduleModel.find({ loanId: id }).sort({ installmentNumber: 1 });
    expect(lines).toHaveLength(6);
    expect(lines.reduce((s, l) => s + l.amountDue, 0)).toBe(180_000);
    expect(lines.reduce((s, l) => s + l.amountPaid, 0)).toBe(50_000);
    expect(lines[0]).toMatchObject({ amountDue: 30_000, amountPaid: 30_000, status: 'paid' });
    expect(lines[1]).toMatchObject({ amountPaid: 20_000, status: 'partial' });
    expect(await RepaymentModel.countDocuments({ loanId: id })).toBe(1);

    const audit = await AuditLogModel.findOne({ action: 'loan.edit', entityId: id });
    expect(audit).toMatchObject({ amountBefore: 110_000, amountAfter: 180_000 });
  });

  it('refuses to go below what has been repaid', async () => {
    const customer = await makeCustomer(true);
    const id = await activeLoan(customer, 200_000);
    await loans.repayCash(officer, id, 150_000, randomUUID(), 'cash');
    await expect(
      editLoan(officer, id, { principal: 100_000, reason: 'Too low' }),
    ).rejects.toMatchObject({ code: 'BELOW_REPAID' });
    expect((await LoanModel.findById(id))?.principal).toBe(200_000);
  });

  it('settles a loan the edit brings down to what was paid, and reopens it going back up', async () => {
    const customer = await makeCustomer(true);
    const id = await activeLoan(customer, 200_000);
    await loans.repayCash(officer, id, 110_000, randomUUID(), 'cash');

    const settled = await editLoan(officer, id, { principal: 100_000, reason: 'Was 1,000' });
    expect(settled).toMatchObject({ status: 'repaid', totalDue: 110_000, remaining: 0 });

    const reopened = await editLoan(officer, id, { principal: 200_000, reason: 'It was 2,000' });
    expect(reopened).toMatchObject({ status: 'active', remaining: 110_000 });
    expect(reopened.closedAt).toBeUndefined();
  });

  it('moves the processing fee with the edit', async () => {
    const customer = await makeCustomer(true);
    const applied = await loans.applyForLoan(
      officer,
      customer,
      100_000,
      3,
      guarantor,
      undefined,
      undefined,
      {
        processingFee: 2_000,
      },
    );
    const id = new Types.ObjectId(applied.id);
    await loans.approveLoan(officer, id);

    await editLoan(officer, id, { processingFee: 3_500, reason: 'Fee was higher' });
    const fees = await CommissionModel.find({ source: 'loan-fee', accountId: id });
    expect(fees.map((f) => f.amount)).toEqual([3_500]);

    await editLoan(officer, id, { processingFee: 0, reason: 'No fee after all' });
    expect(await CommissionModel.countDocuments({ source: 'loan-fee', accountId: id })).toBe(0);
    expect((await LoanModel.findById(id))?.processingFee).toBeUndefined();
  });

  it('keeps an edited rate from being overruled by the escalation clock', async () => {
    const customer = await makeCustomer(true);
    const paper = await recordPaperLoan(officer, {
      customerId: customer,
      principal: 100_000,
      durationMonths: 3,
      ratePercent: 20,
      disbursedOn: daysAgo(300),
      guarantors: [],
      repayments: [],
    });
    const id = new Types.ObjectId(paper.id);
    await editLoan(officer, id, { ratePercent: 10, reason: 'Paper said 10%' });
    const { escalationActionFor } = await import('../../src/domain/loans.js');
    const loan = await LoanModel.findById(id);
    const start = loan?.escalationFrom ?? loan?.disbursedAt;
    expect(start).toBeDefined();
    expect(escalationActionFor(10, start as Date, new Date())).toBeNull();
  });

  it('moves a loan to another customer only before any repayment', async () => {
    const [first, second, third] = await Promise.all([
      makeCustomer(true),
      makeCustomer(true),
      makeCustomer(true),
    ]);
    const id = await activeLoan(first);
    const moved = await editLoan(officer, id, { customerId: second, reason: 'Wrong customer' });
    expect(moved.customerId).toBe(second.toHexString());
    const line = await LoanScheduleModel.findOne({ loanId: id });
    expect(line?.customerId.toHexString()).toBe(second.toHexString());

    await loans.repayCash(officer, id, 1_000, randomUUID(), 'cash');
    await expect(
      editLoan(officer, id, { customerId: third, reason: 'Wrong again' }),
    ).rejects.toMatchObject({ code: 'LOAN_HAS_REPAYMENTS' });
  });
});

describe('over the API', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1`;
  });
  afterAll(() => {
    server.close();
  });

  const call = (actor: AccessTokenPayload, method: string, path: string, json: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${signAccessToken(actor)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(json),
    });

  it('keeps every edit from the counter and collectors', async () => {
    const customer = await makeCustomer(true);
    const id = await activeLoan(customer);
    for (const actor of [teller, collector]) {
      const res = await call(actor, 'PATCH', `/loans/${id.toHexString()}`, {
        principal: 150_000,
        reason: 'Not mine to do',
      });
      expect(res.status).toBe(403);
    }
    expect((await LoanModel.findById(id))?.principal).toBe(100_000);
  });

  it('takes a collector from the counter over the API', async () => {
    const customer = await makeCustomer(true);
    const id = await activeLoan(customer);
    const res = await call(teller, 'POST', `/loans/${id.toHexString()}/repayments`, {
      amount: 1_000,
      idempotencyKey: randomUUID(),
      channel: 'cash',
      collectorId: collector.sub,
    });
    expect(res.status).toBe(201);

    const edited = await call(officer, 'PATCH', `/loans/${id.toHexString()}`, {
      principal: 150_000,
      reason: 'Over the wire',
    });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { loan: { principal: number } }).loan.principal).toBe(150_000);
  });

  it('refuses a teller dating an entry nobody collected', async () => {
    const customer = await makeCustomer(true);
    const id = await activeLoan(customer);
    const res = await call(teller, 'POST', `/loans/${id.toHexString()}/repayments`, {
      amount: 1_000,
      idempotencyKey: randomUUID(),
      channel: 'cash',
      paidOn: daysAgo(1),
    });
    expect(res.status).toBe(403);
  });
});

function signAccessToken(actor: AccessTokenPayload): string {
  return jwt.sign(
    { sub: actor.sub, role: actor.role, fam: new Types.ObjectId().toHexString(), typ: 'staff' },
    env.JWT_ACCESS_SECRET,
    { expiresIn: '5m' },
  );
}

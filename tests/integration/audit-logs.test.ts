import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit } from '../../src/lib/audit.js';
import { runWithRequestContext } from '../../src/lib/request-context.js';
import { AuditLogModel, CustomerModel, UserModel } from '../../src/models/index.js';
import { listAuditLogsQuery } from '../../src/modules/audit-logs/audit-logs.schemas.js';
import {
  listAuditLogs,
  toAuditExportRow,
} from '../../src/modules/audit-logs/audit-logs.service.js';
import { makeCustomer, makeTeller, setupDb, teardownDb } from './helpers.js';

/**
 * Reading the trail. The writers are exercised by every other suite — each
 * money move asserts its own entry — so what is checked here is the reading:
 * that the filters narrow the way the docs say, and that ids come back as
 * names where a name exists.
 */

let teller: { sub: string };
let tellerName: string;
let customerId: Types.ObjectId;
let customerName: string;

/** Parse the way the route does, so defaults and coercions are the real ones. */
function query(params: Record<string, string> = {}) {
  return listAuditLogsQuery.parse(params);
}

beforeAll(async () => {
  await setupDb();
  teller = await makeTeller('Efua Mensah');
  tellerName = (await UserModel.findById(teller.sub))?.name ?? '';
  customerId = await makeCustomer();
  customerName = (await CustomerModel.findById(customerId))?.fullName ?? '';

  // Three entries by the teller, one by nobody the books know.
  await audit({
    actorId: teller.sub,
    action: 'customer.update',
    entityType: 'customer',
    entityId: customerId,
    before: { phone: '0241110001' },
    after: { phone: '0241110002' },
  });
  await audit({
    actorId: teller.sub,
    action: 'susu.deposit.record',
    entityType: 'susu-account',
    entityId: new Types.ObjectId(),
    amountBefore: 1000,
    amountAfter: 2000,
    after: { seq: '2' },
    requestId: 'req-1',
  });
  await audit({
    actorId: teller.sub,
    action: 'susu.account.close',
    entityType: 'susu-account',
    entityId: new Types.ObjectId(),
    amountBefore: 2000,
    amountAfter: 1900,
  });
  await audit({
    actorId: new Types.ObjectId(),
    action: 'user.disable',
    entityType: 'user',
    entityId: new Types.ObjectId(teller.sub),
    after: { status: 'disabled' },
  });
});
afterAll(teardownDb);

describe('reading the trail', () => {
  it('lists newest first with names joined where the record has one', async () => {
    const list = await listAuditLogs(query());
    expect(list.total).toBe(4);
    expect(list.items.map((i) => i.action)).toEqual([
      'user.disable',
      'susu.account.close',
      'susu.deposit.record',
      'customer.update',
    ]);

    const update = list.items.find((i) => i.action === 'customer.update');
    expect(update).toMatchObject({
      actorName: tellerName,
      actorRole: 'teller',
      entityLabel: customerName,
      before: { phone: '0241110001' },
      after: { phone: '0241110002' },
    });

    // The one written by an account nobody can find still lists — the trail
    // never drops an entry — but carries no name.
    const disabled = list.items.find((i) => i.action === 'user.disable');
    expect(disabled?.actorName).toBeUndefined();
    // The record it touched is a user, so that side is named.
    expect(disabled?.entityLabel).toBe(tellerName);
  });

  it('narrows by action prefix, whole or in part', async () => {
    expect((await listAuditLogs(query({ action: 'susu' }))).total).toBe(2);
    expect((await listAuditLogs(query({ action: 'susu.deposit' }))).total).toBe(1);
    expect((await listAuditLogs(query({ action: 'susu.deposit.record' }))).total).toBe(1);
    // A prefix stops at a dot: `su` is not the start of `susu`.
    expect((await listAuditLogs(query({ action: 'su' }))).total).toBe(0);
    // Several prefixes reach the union.
    expect((await listAuditLogs(query({ action: 'customer,user' }))).total).toBe(2);
  });

  it('narrows by who, and by which record', async () => {
    expect((await listAuditLogs(query({ actorId: teller.sub }))).total).toBe(3);
    const one = await listAuditLogs(
      query({ entityType: 'customer', entityId: customerId.toHexString() }),
    );
    expect(one.total).toBe(1);
    expect(one.items[0]?.action).toBe('customer.update');
  });

  it('narrows by Accra day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    expect((await listAuditLogs(query({ from: today, to: today }))).total).toBe(4);
    expect((await listAuditLogs(query({ to: '2000-01-01' }))).total).toBe(0);
  });

  it('pages', async () => {
    const page = await listAuditLogs(query({ page: '2', limit: '3' }));
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(4);
  });

  it('refuses a malformed action or an inverted range', () => {
    expect(listAuditLogsQuery.safeParse({ action: 'Susu.Deposit' }).success).toBe(false);
    expect(listAuditLogsQuery.safeParse({ action: 'susu;drop' }).success).toBe(false);
    expect(listAuditLogsQuery.safeParse({ from: '2026-09-02', to: '2026-09-01' }).success).toBe(
      false,
    );
  });

  it('flattens an entry for the spreadsheet', async () => {
    const list = await listAuditLogs(query({ action: 'susu.deposit.record' }));
    const row = toAuditExportRow(list.items[0]!);
    expect(row).toMatchObject({
      actor: tellerName,
      actorRole: 'teller',
      action: 'susu.deposit.record',
      entityType: 'susu-account',
      amountBefore: 1000,
      amountAfter: 2000,
      after: '{"seq":"2"}',
      before: '',
      requestId: 'req-1',
    });
  });

  it('never grows the trail by being read', async () => {
    const before = await AuditLogModel.countDocuments();
    await listAuditLogs(query());
    expect(await AuditLogModel.countDocuments()).toBe(before);
  });

  it('records where a change came from, off the request, without the caller saying so', async () => {
    const context = {
      requestId: 'req-ctx',
      method: 'PATCH',
      path: '/api/v1/susu/accounts/abc/deposits/def',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/128.0',
    };
    await runWithRequestContext(context, () =>
      audit({
        actorId: teller.sub,
        action: 'susu.deposit.update',
        entityType: 'susu-deposit',
        entityId: new Types.ObjectId(),
        amountBefore: 2000,
        amountAfter: 4000,
      }),
    );
    const [entry] = (await listAuditLogs(query({ action: 'susu.deposit.update' }))).items;
    expect(entry).toMatchObject(context);

    // The entries written with no request around them carry none of it.
    const [bare] = (await listAuditLogs(query({ action: 'customer.update' }))).items;
    expect(bare?.method).toBeUndefined();
    expect(bare?.userAgent).toBeUndefined();

    // A caller that names its own request id keeps it over the context's.
    await runWithRequestContext(context, () =>
      audit({
        actorId: teller.sub,
        action: 'susu.deposit.trash',
        entityType: 'susu-deposit',
        entityId: new Types.ObjectId(),
        requestId: 'req-named',
      }),
    );
    const [named] = (await listAuditLogs(query({ action: 'susu.deposit.trash' }))).items;
    expect(named?.requestId).toBe('req-named');
    expect(named?.method).toBe('PATCH');

    const row = toAuditExportRow(entry!);
    expect(row).toMatchObject({
      endpoint: 'PATCH /api/v1/susu/accounts/abc/deposits/def',
      device: context.userAgent,
    });
  });
});

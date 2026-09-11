import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HpDamageModel, HpItemModel } from '../../src/models/index.js';
import * as damages from '../../src/modules/hire-purchase/hp-damages.service.js';
import * as hp from '../../src/modules/hire-purchase/hp.service.js';
import { asOfficer, makeTeller, setupDb, teardownDb } from './helpers.js';

/**
 * Damaged stock: the counter reports, the office decides.
 *
 * Nothing leaves the shelf until somebody with authority approves it, the
 * reporter may never approve their own report, and the cost is struck once —
 * at approval — so a later price edit cannot restate a closed month.
 */

const officer = asOfficer();
let teller: Awaited<ReturnType<typeof makeTeller>>;

beforeAll(async () => {
  await setupDb();
  teller = await makeTeller('Damage Reporter');
});
afterAll(teardownDb);

async function makeItem(name: string, quantity = 10, costPrice = 10_000) {
  return hp.createItem(officer, {
    name,
    quantityInStock: quantity,
    costPrice,
    sellingPrice: costPrice * 2,
  });
}

async function report(itemId: string, quantity = 2) {
  return damages.reportDamage(teller, {
    itemId: new Types.ObjectId(itemId),
    quantity,
    cause: 'in-shop',
    description: 'Knocked off the shelf while restocking',
  });
}

describe('reporting a damage', () => {
  it('does not touch the shelf until it is approved', async () => {
    const item = await makeItem('Kettle');
    const damage = await report(item.id, 3);

    expect(damage.status).toBe('pending');
    expect(damage.costValue).toBeUndefined();
    // The whole point: a mistaken report costs nothing but a rejection.
    const stored = await HpItemModel.findById(item.id);
    expect(stored?.quantityInStock).toBe(10);
  });

  it('refuses more than is on the shelf', async () => {
    const item = await makeItem('Blender', 2);
    await expect(report(item.id, 5)).rejects.toMatchObject({
      code: 'OUT_OF_STOCK',
      details: { quantityInStock: 2 },
    });
  });

  it('refuses a damage that has not happened yet', async () => {
    const item = await makeItem('Iron');
    await expect(
      damages.reportDamage(teller, {
        itemId: new Types.ObjectId(item.id),
        quantity: 1,
        cause: 'other',
        description: 'Will break tomorrow',
        occurredOn: '2099-01-01',
      }),
    ).rejects.toMatchObject({ code: 'FUTURE_DATE' });
  });

  it('keeps the item name as it was, even after a rename', async () => {
    const item = await makeItem('Old Name');
    const damage = await report(item.id, 1);
    await hp.updateItem(officer, new Types.ObjectId(item.id), { name: 'New Name' });

    const stored = await damages.getDamage(new Types.ObjectId(damage.id));
    expect(stored.itemName).toBe('Old Name');
  });
});

describe('deciding a damage', () => {
  it('takes the stock off the shelf and strikes the loss at approval', async () => {
    const item = await makeItem('Microwave', 10, 25_000);
    const damage = await report(item.id, 2);

    const approved = await damages.approveDamage(officer, new Types.ObjectId(damage.id));
    expect(approved.status).toBe('approved');
    expect(approved.unitCost).toBe(25_000);
    expect(approved.costValue).toBe(50_000);

    const stored = await HpItemModel.findById(item.id);
    expect(stored?.quantityInStock).toBe(8);
  });

  it('will not let the reporter approve their own report', async () => {
    const item = await makeItem('Fan');
    const damage = await damages.reportDamage(officer, {
      itemId: new Types.ObjectId(item.id),
      quantity: 1,
      cause: 'in-shop',
      description: 'Dropped it myself',
    });

    await expect(
      damages.approveDamage(officer, new Types.ObjectId(damage.id)),
    ).rejects.toMatchObject({ code: 'SELF_APPROVAL' });

    // Still on the shelf.
    expect((await HpItemModel.findById(item.id))?.quantityInStock).toBe(10);
  });

  it('holds the cost even when the item is repriced afterwards', async () => {
    const item = await makeItem('Television', 5, 100_000);
    const damage = await report(item.id, 1);
    const approved = await damages.approveDamage(officer, new Types.ObjectId(damage.id));
    expect(approved.costValue).toBe(100_000);

    // A later price rise must not restate a loss already booked.
    await hp.updateItem(officer, new Types.ObjectId(item.id), {
      costPrice: 180_000,
      sellingPrice: 260_000,
    });
    const after = await damages.getDamage(new Types.ObjectId(damage.id));
    expect(after.costValue).toBe(100_000);
    expect(after.unitCost).toBe(100_000);
  });

  it('refuses approval when the shelf has fallen below the reported quantity', async () => {
    const item = await makeItem('Radio', 3);
    const damage = await report(item.id, 3);
    // Two were sold between the report and the decision.
    await hp.adjustStock(officer, new Types.ObjectId(item.id), -2, 'sold');

    await expect(
      damages.approveDamage(officer, new Types.ObjectId(damage.id)),
    ).rejects.toMatchObject({ code: 'OUT_OF_STOCK' });
    expect((await HpItemModel.findById(item.id))?.quantityInStock).toBe(1);
  });

  it('leaves the shelf alone on a rejection, and says why', async () => {
    const item = await makeItem('Speaker');
    const damage = await report(item.id, 2);

    const rejected = await damages.rejectDamage(officer, new Types.ObjectId(damage.id), {
      reason: 'It was repaired — put it back',
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toBe('It was repaired — put it back');
    expect(rejected.costValue).toBeUndefined();
    expect((await HpItemModel.findById(item.id))?.quantityInStock).toBe(10);
  });

  it('decides once and only once', async () => {
    const item = await makeItem('Cooker');
    const damage = await report(item.id, 1);
    await damages.approveDamage(officer, new Types.ObjectId(damage.id));

    await expect(
      damages.approveDamage(officer, new Types.ObjectId(damage.id)),
    ).rejects.toMatchObject({ code: 'ALREADY_REVIEWED' });
    await expect(
      damages.rejectDamage(officer, new Types.ObjectId(damage.id), { reason: 'changed my mind' }),
    ).rejects.toMatchObject({ code: 'ALREADY_REVIEWED' });
    // And the stock moved exactly once.
    expect((await HpItemModel.findById(item.id))?.quantityInStock).toBe(9);
  });

  it('refuses to correct a report after it has been decided', async () => {
    const item = await makeItem('Toaster');
    const damage = await report(item.id, 1);
    await damages.approveDamage(officer, new Types.ObjectId(damage.id));

    await expect(
      damages.updateDamage(teller, new Types.ObjectId(damage.id), { quantity: 5 }),
    ).rejects.toMatchObject({ code: 'ALREADY_REVIEWED' });
  });
});

describe('the damage register', () => {
  it('counts only approved reports as a loss', async () => {
    await HpDamageModel.deleteMany({});
    const item = await makeItem('Generator', 10, 50_000);

    const approved = await report(item.id, 1);
    await damages.approveDamage(officer, new Types.ObjectId(approved.id));
    await report(item.id, 2); // left pending
    const rejected = await report(item.id, 3);
    await damages.rejectDamage(officer, new Types.ObjectId(rejected.id), { reason: 'miscounted' });

    const list = await damages.listDamages({ page: 1, limit: 25, format: 'json' });
    expect(list.total).toBe(3);
    expect(list.pendingCount).toBe(1);
    // Only the approved one is money the shop has lost.
    expect(list.totalCostValue).toBe(50_000);
  });

  it('summarises what was lost by cause', async () => {
    await HpDamageModel.deleteMany({});
    const item = await makeItem('Freezer', 20, 30_000);

    const a = await damages.reportDamage(teller, {
      itemId: new Types.ObjectId(item.id),
      quantity: 2,
      cause: 'delivery',
      description: 'Arrived dented',
    });
    const b = await damages.reportDamage(teller, {
      itemId: new Types.ObjectId(item.id),
      quantity: 1,
      cause: 'missing',
      description: 'Not on the shelf at stock-take',
    });
    await damages.approveDamage(officer, new Types.ObjectId(a.id));
    await damages.approveDamage(officer, new Types.ObjectId(b.id));

    const summary = await damages.damageSummary();
    expect(summary.totalQuantity).toBe(3);
    expect(summary.totalCostValue).toBe(90_000);
    const delivery = summary.byCause.find((c) => c.cause === 'delivery');
    expect(delivery).toEqual({ cause: 'delivery', count: 1, quantity: 2, costValue: 60_000 });
  });

  it('keeps an approved write-off on the record', async () => {
    const item = await makeItem('Pressing Iron');
    const damage = await report(item.id, 1);
    await damages.approveDamage(officer, new Types.ObjectId(damage.id));

    await expect(
      damages.trashDamage(officer, new Types.ObjectId(damage.id), 'tidying up'),
    ).rejects.toMatchObject({ code: 'CANNOT_TRASH' });
  });

  it('bins and restores a report that was never approved', async () => {
    const item = await makeItem('Stabiliser');
    const damage = await report(item.id, 1);

    const binned = await damages.trashDamage(officer, new Types.ObjectId(damage.id), 'duplicate');
    expect(binned.deletedAt).toBeInstanceOf(Date);
    expect(
      (await damages.listDamages({ page: 1, limit: 25, format: 'json' })).items,
    ).not.toContainEqual(expect.objectContaining({ id: damage.id }));

    const trash = await damages.listDamageTrash({ page: 1, limit: 25 });
    expect(trash.items.map((d) => d.id)).toContain(damage.id);

    const restored = await damages.restoreDamage(officer, new Types.ObjectId(damage.id));
    expect(restored.status).toBe('pending');
  });
});

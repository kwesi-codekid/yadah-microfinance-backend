import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HpItemModel, HpPriceChangeModel } from '../../src/models/index.js';
import * as pricing from '../../src/modules/hire-purchase/hp-pricing.service.js';
import * as hp from '../../src/modules/hire-purchase/hp.service.js';
import { asOfficer, setupDb, teardownDb } from './helpers.js';

/**
 * Restocking at a different invoice price.
 *
 * The shelf carries one cost and one selling price — the latest — so a
 * delivery invoiced at a new figure moves it. What the history is for is the
 * part that used to vanish: which delivery moved it, from what, and on whose
 * invoice.
 */

const officer = asOfficer();

beforeAll(setupDb);
afterAll(teardownDb);

async function makeItem(name: string, costPrice = 50_000, sellingPrice = 80_000) {
  return hp.createItem(officer, { name, quantityInStock: 4, costPrice, sellingPrice });
}

describe('booking a delivery', () => {
  it('adds the quantity and leaves the price alone when the invoice agrees', async () => {
    const item = await makeItem('Standing Fan');
    const result = await pricing.receiveStock(officer, new Types.ObjectId(item.id), {
      quantity: 6,
      unitCost: 50_000,
    });

    expect(result.item.quantityInStock).toBe(10);
    expect(result.item.costPrice).toBe(50_000);
    // Nothing moved, so there is nothing to explain.
    expect(result.changes).toEqual([]);
  });

  it('moves the cost when the invoice disagrees, and says which delivery did it', async () => {
    const item = await makeItem('Chest Freezer', 100_000, 160_000);
    const result = await pricing.receiveStock(officer, new Types.ObjectId(item.id), {
      quantity: 3,
      unitCost: 125_000,
      supplier: 'Accra Cold Chain Ltd',
      invoiceRef: 'INV-4471',
      receivedOn: '2026-09-02',
    });

    expect(result.item.quantityInStock).toBe(7);
    expect(result.item.costPrice).toBe(125_000);

    const change = result.changes.find((c) => c.kind === 'cost');
    expect(change).toMatchObject({
      previous: 100_000,
      current: 125_000,
      delta: 25_000,
      quantityReceived: 3,
      supplier: 'Accra Cold Chain Ltd',
      invoiceRef: 'INV-4471',
      receivedOn: '2026-09-02',
    });
    // The officer in these tests is a token without a staff row, so the name
    // is legitimately absent; the id is what the record is keyed on.
    expect(change?.changedById).toBe(officer.sub);
  });

  it('reprices the shelf in the same breath when asked', async () => {
    const item = await makeItem('Blender', 20_000, 32_000);
    const result = await pricing.receiveStock(officer, new Types.ObjectId(item.id), {
      quantity: 5,
      unitCost: 26_000,
      sellingPrice: 42_000,
      note: 'Supplier raised prices this quarter',
    });

    expect(result.item.costPrice).toBe(26_000);
    expect(result.item.sellingPrice).toBe(42_000);
    expect(result.changes.map((c) => c.kind).sort()).toEqual(['cost', 'selling']);
    expect(result.changes.every((c) => c.reason === 'Supplier raised prices this quarter')).toBe(
      true,
    );
  });

  it('refuses a delivery that would leave the shop selling below cost', async () => {
    const item = await makeItem('Rice Cooker', 30_000, 40_000);
    await expect(
      pricing.receiveStock(officer, new Types.ObjectId(item.id), {
        quantity: 2,
        unitCost: 55_000, // above the current selling price
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PRICING' });

    // Nothing moved: not the stock, not the price.
    const stored = await HpItemModel.findById(item.id);
    expect(stored?.quantityInStock).toBe(4);
    expect(stored?.costPrice).toBe(30_000);
  });
});

describe('the price history', () => {
  it('records a move made from the item itself', async () => {
    const item = await makeItem('Water Dispenser', 40_000, 60_000);
    await hp.updateItem(officer, new Types.ObjectId(item.id), { sellingPrice: 70_000 });

    const history = await pricing.listPriceChanges(new Types.ObjectId(item.id), {
      page: 1,
      limit: 25,
    });
    expect(history.total).toBe(1);
    expect(history.items[0]).toMatchObject({
      kind: 'selling',
      previous: 60_000,
      current: 70_000,
      delta: 10_000,
      reason: 'Edited on the item',
    });
  });

  it('writes nothing when an edit leaves the prices where they were', async () => {
    const item = await makeItem('Pressing Iron', 15_000, 25_000);
    await hp.updateItem(officer, new Types.ObjectId(item.id), {
      name: 'Pressing Iron (Large)',
      sellingPrice: 25_000,
    });

    // A history full of "GHS 250 → GHS 250" is a history nobody reads.
    expect(await HpPriceChangeModel.countDocuments({ itemId: item.id })).toBe(0);
  });

  it('keeps every move, newest first, and filters by which price moved', async () => {
    const item = await makeItem('Deep Freezer', 100_000, 150_000);
    const id = new Types.ObjectId(item.id);
    await pricing.receiveStock(officer, id, { quantity: 1, unitCost: 110_000 });
    await pricing.receiveStock(officer, id, { quantity: 1, unitCost: 120_000 });
    await hp.updateItem(officer, id, { sellingPrice: 190_000 });

    const all = await pricing.listPriceChanges(id, { page: 1, limit: 25 });
    expect(all.total).toBe(3);
    expect(all.items[0]?.kind).toBe('selling'); // newest first

    const costOnly = await pricing.listPriceChanges(id, { page: 1, limit: 25, kind: 'cost' });
    expect(costOnly.total).toBe(2);
    expect(costOnly.items.map((c) => c.current)).toEqual([120_000, 110_000]);
  });

  it('shows the trail a valuation change can be read back from', async () => {
    // The problem this exists for: the shelf is valued at the latest cost, so
    // a delivery silently revalues everything already on it. The row is what
    // makes that visible afterwards.
    const item = await makeItem('Solar Lamp', 5_000, 9_000);
    const id = new Types.ObjectId(item.id);
    await pricing.receiveStock(officer, id, {
      quantity: 100,
      unitCost: 7_500,
      invoiceRef: 'INV-9001',
    });

    const stored = await HpItemModel.findById(id);
    expect(stored?.quantityInStock).toBe(104);
    expect((stored?.quantityInStock ?? 0) * (stored?.costPrice ?? 0)).toBe(104 * 7_500);

    const [change] = (await pricing.listPriceChanges(id, { page: 1, limit: 1, kind: 'cost' }))
      .items;
    expect(change?.previous).toBe(5_000);
    expect(change?.current).toBe(7_500);
    expect(change?.invoiceRef).toBe('INV-9001');
  });
});

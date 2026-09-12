import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { HpItemModel, HpSaleModel } from '../../src/models/index.js';
import * as hp from '../../src/modules/hire-purchase/hp.service.js';
import { commissionEarned } from '../../src/modules/reports/reports.service.js';
import { listTransactions } from '../../src/modules/reports/transactions.service.js';
import { accraDay } from '../../src/lib/time.js';
import { asOfficer, makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();
const today = accraDay();

let itemSeq = 0;
async function makeItem(
  quantityInStock = 10,
  sellingPrice = 5_000,
  costPrice = 3_000,
): Promise<Types.ObjectId> {
  itemSeq += 1;
  const item = await hp.createItem(officer, {
    name: `Test Item ${String(itemSeq)}`,
    quantityInStock,
    costPrice,
    sellingPrice,
    condition: 'new',
  });
  return new Types.ObjectId(item.id);
}

async function stockOf(itemId: Types.ObjectId): Promise<number> {
  const item = await HpItemModel.findById(itemId);
  return item?.quantityInStock ?? -1;
}

/**
 * Outright counter sales (client request 2026-08-21): people who buy a
 * product and pay for it there and then, with no hire-purchase agreement.
 */
describe('recording an outright sale', () => {
  it('sells to a walk-in with no registered customer', async () => {
    const itemId = await makeItem(10, 5_000, 3_000);

    const { sale, replayed } = await hp.recordSale(officer, {
      buyerName: 'Kwame Asare',
      lines: [{ itemId, quantity: 2 }],
      idempotencyKey: randomUUID(),
      channel: 'cash',
    });

    expect(replayed).toBe(false);
    expect(sale.customerId).toBeNull(); // the whole point — no registration needed
    expect(sale.buyerName).toBe('Kwame Asare');
    expect(sale.total).toBe(10_000);
    expect(sale.listedTotal).toBe(10_000); // nothing was bargained

    expect(sale.lines).toHaveLength(1);
    expect(await stockOf(itemId)).toBe(8);
  });

  it('takes the name from the customer record when one is given', async () => {
    const customerId = await makeCustomer();
    const itemId = await makeItem();

    const { sale } = await hp.recordSale(officer, {
      customerId,
      buyerName: 'Ignore Me',
      lines: [{ itemId, quantity: 1 }],
      idempotencyKey: randomUUID(),
      channel: 'cash',
    });

    expect(sale.customerId).toBe(customerId.toHexString());
    expect(sale.buyerName).not.toBe('Ignore Me');
    expect(sale.buyerName).toContain('Test Customer');
  });

  it('sells a multi-item basket in one go', async () => {
    const kettle = await makeItem(5, 4_000, 2_500);
    const iron = await makeItem(5, 6_000, 4_000);

    const { sale } = await hp.recordSale(officer, {
      buyerName: 'Adjoa Boateng',
      lines: [
        { itemId: kettle, quantity: 2 },
        { itemId: iron, quantity: 1 },
      ],
      idempotencyKey: randomUUID(),
      channel: 'cash',
    });

    expect(sale.lines).toHaveLength(2);
    expect(sale.total).toBe(14_000); // 2×4,000 + 6,000
    expect(await stockOf(kettle)).toBe(3);
    expect(await stockOf(iron)).toBe(4);
  });

  // The price is settled at the counter, and the settled price IS the sale:
  // a television listed at 5,000 and given for 4,500 is a 4,500 sale, not
  // 5,000 with 500 taken off. The shelf figure is kept to compare against.
  it('sells below the shelf price at the price agreed', async () => {
    const itemId = await makeItem(5, 5_000, 3_000);

    const { sale } = await hp.recordSale(officer, {
      buyerName: 'Yaw Darko',
      lines: [{ itemId, quantity: 1, unitPrice: 4_500 }],
      idempotencyKey: randomUUID(),
      channel: 'cash',
    });

    expect(sale.total).toBe(4_500);
    expect(sale.listedTotal).toBe(5_000);
    expect(sale.lines[0]?.listPrice).toBe(5_000);
    expect(sale.lines[0]?.unitPrice).toBe(4_500);
  });

  // The other direction, which the old derived discount could not survive:
  // `subtotal − total` went negative and failed the model's `min: 0`, so a
  // counter that bargained upwards got a 500 instead of a sale.
  it('sells above the shelf price when that is what was agreed', async () => {
    const itemId = await makeItem(5, 5_000, 3_000);

    const { sale } = await hp.recordSale(officer, {
      buyerName: 'Akosua Mensah',
      lines: [{ itemId, quantity: 2, unitPrice: 6_500 }],
      idempotencyKey: randomUUID(),
      channel: 'cash',
    });

    expect(sale.total).toBe(13_000);
    expect(sale.listedTotal).toBe(10_000);
    expect(sale.lines[0]?.unitPrice).toBe(6_500);
    // Revenue and the margin follow the price charged, not the shelf price.
    const stored = await HpSaleModel.findById(new Types.ObjectId(sale.id));
    expect(stored?.total).toBe(13_000);
    expect(stored?.profit).toBe(13_000 - 6_000);
  });

  it('keeps cost and profit off the customer-facing shape', async () => {
    const itemId = await makeItem(5, 5_000, 3_000);
    const { sale } = await hp.recordSale(officer, {
      buyerName: 'Nana Owusu',
      lines: [{ itemId, quantity: 1 }],
      idempotencyKey: randomUUID(),
      channel: 'cash',
    });

    const asRecord = sale as unknown as Record<string, unknown>;
    expect(asRecord.totalCost).toBeUndefined();
    expect(asRecord.profit).toBeUndefined();
    expect(asRecord.lines).toBeDefined();
    for (const line of sale.lines as unknown as Record<string, unknown>[]) {
      expect(line.unitCost).toBeUndefined();
    }

    // Stored, though — the office needs the margin.
    const stored = await HpSaleModel.findById(sale.id);
    expect(stored?.profit).toBe(2_000);
  });

  it('refuses to oversell and writes nothing when it does', async () => {
    const itemId = await makeItem(3);

    await expect(
      hp.recordSale(officer, {
        buyerName: 'Too Greedy',
        lines: [{ itemId, quantity: 4 }],
        idempotencyKey: randomUUID(),
        channel: 'cash',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK', status: 422 });

    expect(await stockOf(itemId)).toBe(3);
    expect(await HpSaleModel.countDocuments({ 'lines.itemId': itemId })).toBe(0);
  });

  it('rolls the whole basket back when one line cannot be filled', async () => {
    const plenty = await makeItem(10);
    const scarce = await makeItem(1);

    await expect(
      hp.recordSale(officer, {
        buyerName: 'Mixed Basket',
        lines: [
          { itemId: plenty, quantity: 2 },
          { itemId: scarce, quantity: 5 },
        ],
        idempotencyKey: randomUUID(),
        channel: 'cash',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    // The first line must not have been quietly taken out of stock.
    expect(await stockOf(plenty)).toBe(10);
    expect(await stockOf(scarce)).toBe(1);
  });

  it('refuses a discontinued item', async () => {
    const itemId = await makeItem(5);
    await hp.updateItem(officer, itemId, { status: 'discontinued' });

    await expect(
      hp.recordSale(officer, {
        buyerName: 'Late Buyer',
        lines: [{ itemId, quantity: 1 }],
        idempotencyKey: randomUUID(),
        channel: 'cash',
      }),
    ).rejects.toMatchObject({ code: 'ITEM_DISCONTINUED', status: 422 });
  });

  it('replays a retried request without selling twice', async () => {
    const itemId = await makeItem(10);
    const key = randomUUID();
    const lines = [{ itemId, quantity: 2 }];

    const first = await hp.recordSale(officer, {
      buyerName: 'Retry Buyer',
      lines,
      idempotencyKey: key,
      channel: 'cash',
    });
    const replay = await hp.recordSale(officer, {
      buyerName: 'Retry Buyer',
      lines,
      idempotencyKey: key,
      channel: 'cash',
    });

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.sale.id).toBe(first.sale.id);
    expect(await stockOf(itemId)).toBe(8); // not 6
  });
});

describe('voiding a sale', () => {
  it('returns the stock and stops it counting, keeping the row', async () => {
    const itemId = await makeItem(10);
    const { sale } = await hp.recordSale(officer, {
      buyerName: 'Mis-rung Sale',
      lines: [{ itemId, quantity: 3 }],
      idempotencyKey: randomUUID(),
      channel: 'cash',
    });
    expect(await stockOf(itemId)).toBe(7);

    const voided = await hp.voidSale(officer, new Types.ObjectId(sale.id), 'Rung up twice');
    expect(voided.status).toBe('voided');
    expect(voided.voidReason).toBe('Rung up twice');
    expect(await stockOf(itemId)).toBe(10);

    // The row survives — a ledger annotates rather than forgets.
    expect(await HpSaleModel.findById(sale.id)).not.toBeNull();
  });

  it('refuses to void twice', async () => {
    const itemId = await makeItem(10);
    const { sale } = await hp.recordSale(officer, {
      buyerName: 'Double Void',
      lines: [{ itemId, quantity: 1 }],
      idempotencyKey: randomUUID(),
      channel: 'cash',
    });
    const id = new Types.ObjectId(sale.id);
    await hp.voidSale(officer, id, 'first');
    await expect(hp.voidSale(officer, id, 'second')).rejects.toMatchObject({
      code: 'ALREADY_VOIDED',
      status: 409,
    });
    expect(await stockOf(itemId)).toBe(10); // restocked once, not twice
  });
});

describe('sales in the wider reporting', () => {
  it('shows up in the unified transactions feed, walk-ins included', async () => {
    const itemId = await makeItem(10, 7_000, 4_000);
    const { sale } = await hp.recordSale(officer, {
      buyerName: 'Feed Buyer',
      lines: [{ itemId, quantity: 1 }],
      idempotencyKey: randomUUID(),
      channel: 'cash',
    });

    const feed = await listTransactions({
      page: 1,
      limit: 100,
      from: today,
      to: today,
      format: 'json',
    });
    const row = feed.items.find((r) => r.ref.id === sale.id);
    expect(row).toBeDefined();
    expect(row?.type).toBe('hp-sale');
    expect(row?.module).toBe('hire-purchase');
    expect(row?.direction).toBe('in');
    expect(row?.amount).toBe(7_000);
    expect(row?.customerName).toBe('Walk-in customer');
  });

  it('drops out of the feed once voided', async () => {
    const itemId = await makeItem(10);
    const { sale } = await hp.recordSale(officer, {
      buyerName: 'Vanishing Sale',
      lines: [{ itemId, quantity: 1 }],
      idempotencyKey: randomUUID(),
      channel: 'cash',
    });
    await hp.voidSale(officer, new Types.ObjectId(sale.id), 'error');

    const feed = await listTransactions({
      page: 1,
      limit: 100,
      from: today,
      to: today,
      format: 'json',
    });
    expect(feed.items.find((r) => r.ref.id === sale.id)).toBeUndefined();
  });

  it('counts the margin as revenue, excluding voided sales', async () => {
    const before = await commissionEarned(today, today);

    const itemId = await makeItem(10, 10_000, 6_000);
    await hp.recordSale(officer, {
      buyerName: 'Margin Buyer',
      lines: [{ itemId, quantity: 1 }],
      idempotencyKey: randomUUID(),
      channel: 'cash',
    });

    const after = await commissionEarned(today, today);
    expect(after.outrightSalesProfit.amount - before.outrightSalesProfit.amount).toBe(4_000);
    expect(after.totalRevenue - before.totalRevenue).toBe(4_000);

    // A voided sale adds nothing.
    const { sale: voidable } = await hp.recordSale(officer, {
      buyerName: 'Voided Margin',
      lines: [{ itemId, quantity: 1 }],
      idempotencyKey: randomUUID(),
      channel: 'cash',
    });
    await hp.voidSale(officer, new Types.ObjectId(voidable.id), 'mistake');

    const final = await commissionEarned(today, today);
    expect(final.outrightSalesProfit.amount).toBe(after.outrightSalesProfit.amount);
  });

  it('summarises revenue and profit across the whole filter', async () => {
    const itemId = await makeItem(20, 2_000, 1_000);
    for (let i = 0; i < 3; i += 1) {
      await hp.recordSale(officer, {
        buyerName: `Bulk Buyer ${String(i)}`,
        lines: [{ itemId, quantity: 1 }],
        idempotencyKey: randomUUID(),
        channel: 'cash',
      });
    }

    const list = await hp.listSales({
      page: 1,
      limit: 2,
      search: 'Bulk Buyer',
      format: 'json',
    });
    expect(list.items).toHaveLength(2); // page size
    expect(list.total).toBe(3);
    expect(list.totals.salesCount).toBe(3); // totals span the filter, not the page
    expect(list.totals.revenue).toBe(6_000);
    expect(list.totals.profit).toBe(3_000);
  });

  it('filters walk-ins from registered-customer sales', async () => {
    const customerId = await makeCustomer();
    const itemId = await makeItem(20, 1_000, 500);
    await hp.recordSale(officer, {
      customerId,
      lines: [{ itemId, quantity: 1 }],
      idempotencyKey: randomUUID(),
      channel: 'cash',
    });
    await hp.recordSale(officer, {
      buyerName: 'Anonymous Walk-in',
      lines: [{ itemId, quantity: 1 }],
      idempotencyKey: randomUUID(),
      channel: 'cash',
    });

    const walkIns = await hp.listSales({ page: 1, limit: 100, walkInOnly: true, format: 'json' });
    expect(walkIns.items.every((s) => s.customerId === null)).toBe(true);

    const forCustomer = await hp.listSales({ page: 1, limit: 100, customerId, format: 'json' });
    expect(forCustomer.items.every((s) => s.customerId === customerId.toHexString())).toBe(true);
    expect(forCustomer.total).toBe(1);
  });
});

describe('the sales receipt', () => {
  it('renders a real PDF for a walk-in basket', async () => {
    const a = await makeItem(10, 3_000, 1_500);
    const b = await makeItem(10, 4_000, 2_000);
    const { sale } = await hp.recordSale(officer, {
      buyerName: 'Receipt Buyer',
      buyerPhone: '0241234567',
      lines: [
        { itemId: a, quantity: 2 },
        { itemId: b, quantity: 1, unitPrice: 3_500 },
      ],
      idempotencyKey: randomUUID(),
      channel: 'cash',
    });

    const { buffer, filename } = await hp.saleReceipt(new Types.ObjectId(sale.id));
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(filename).toContain(sale.receiptNo);
  });
});

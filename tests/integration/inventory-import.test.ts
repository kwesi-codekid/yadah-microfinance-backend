import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HpItemModel } from '../../src/models/index.js';
import { toXlsxBuffer } from '../../src/lib/excel.js';
import * as imports from '../../src/modules/hire-purchase/hp.import.js';
import * as labels from '../../src/modules/hire-purchase/hp-labels.service.js';
import * as hp from '../../src/modules/hire-purchase/hp.service.js';
import { asOfficer, makeTeller, setupDb, teardownDb } from './helpers.js';

/**
 * Stocking the shelf from a spreadsheet. The preview must never write, prices
 * arrive in cedis and are kept in pesewas, and the faults a person cannot see
 * on their own sheet — the same item twice, one already stocked, a brand
 * nobody has added — are named before anything goes in.
 */

const officer = asOfficer();
const brandIds = new Map<string, string>();

async function setup(): Promise<void> {
  await setupDb();
  for (const name of ['Binatone', 'Nasco', 'Midea', 'Hisense', 'Samsung']) {
    const b = await labels.createLabel(officer, 'brand', { name });
    brandIds.set(name, b.id);
  }
  for (const name of ['Fan', 'Small appliance', 'Freezer', 'Fridge', 'Cooker', 'TV']) {
    await labels.createLabel(officer, 'category', { name });
  }
}
beforeAll(setup);
afterAll(teardownDb);

/**
 * A sheet as a supplier or the branch would save it, with the template's
 * headings. A cell with a thousands comma is quoted, as Excel would.
 */
function csv(
  rows: string[][],
  header = 'Item,Brand,Category,Condition,Quantity,Cost price,Selling price',
) {
  const body = rows.map((r) => r.map((c) => (c.includes(',') ? `"${c}"` : c)).join(',')).join('\n');
  return {
    buffer: Buffer.from(`${header}\n${body}\n`, 'utf8'),
    mimetype: 'text/csv',
    originalname: 'stock.csv',
  };
}

function issuesFor(preview: imports.ImportPreview, row: number): string[] {
  return (preview.rows.find((r) => r.row === row)?.issues ?? []).map(
    (i) => `${String(i.field)}: ${i.message}`,
  );
}

function rowsFrom(preview: imports.ImportPreview) {
  return preview.rows.map((r) => ({ row: r.row, values: r.values }));
}

describe('reading the sheet', () => {
  it('places loosely-written headings and names the ones it cannot', async () => {
    const preview = await imports.previewImportFile({
      buffer: Buffer.from(
        'PRODUCT NAME,make,qty,cost,price,Colour\nRice cooker,Binatone,3,150,220,red\n',
        'utf8',
      ),
      mimetype: 'text/csv',
      originalname: 'odd.csv',
    });
    expect(preview.unknownHeaders).toEqual(['Colour']);
    expect(preview.rows[0]?.values).toMatchObject({
      name: 'Rice cooker',
      brand: 'Binatone',
      quantityInStock: '3',
      costPrice: '150',
      sellingPrice: '220',
    });
    expect(preview.rows[0]?.brandId).toBe(brandIds.get('Binatone'));
    expect(preview.rows[0]?.issues).toEqual([]);
  });

  it('names a brand or category nobody has added, and offers the lists to pick from', async () => {
    const preview = await imports.previewImportFile(
      csv([['Blender 1.5L', 'Kenwood', 'Blender', 'new', '2', '200', '300']]),
    );
    expect(issuesFor(preview, 2)).toEqual([
      'brand: No brand called "Kenwood" — add it, or pick one',
      'category: No category called "Blender" — add it, or pick one',
    ]);
    expect(preview.rows[0]?.brandId).toBe('');
    expect(preview.brands.map((b) => b.name)).toContain('Nasco');
    expect(preview.categories.map((c) => c.name)).toContain('Cooker');
  });

  it('reads an xlsx workbook and keeps its numbers as numbers', async () => {
    const buffer = await toXlsxBuffer([
      { Item: 'Standing fan', Quantity: 6, 'Cost price': 180, 'Selling price': 260 },
    ]);
    const preview = await imports.previewImportFile({
      buffer,
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      originalname: 'stock.xlsx',
    });
    expect(preview.rows[0]?.values.quantityInStock).toBe('6');
    expect(preview.counts).toEqual({ total: 1, ready: 1, blocked: 0 });
  });
});

describe('checking the rows', () => {
  it('flags what is wrong, in the sheet’s own words, without writing anything', async () => {
    const before = await HpItemModel.countDocuments();
    const preview = await imports.previewImportFile(
      csv([
        ['', 'Nasco', 'Fridge', 'new', '2', '2800', '3500'],
        ['Chest freezer', 'Nasco', 'Freezer', 'refurbished', 'two', '2,000', '1,800'],
        ['Blender', '', '', '', '5', 'abc', '120'],
      ]),
    );
    expect(await HpItemModel.countDocuments()).toBe(before);

    expect(issuesFor(preview, 2)).toEqual(['name: An item needs a name']);
    expect(issuesFor(preview, 3)).toEqual(
      expect.arrayContaining([
        'condition: New or used',
        'quantityInStock: A whole number of units, like 4',
        expect.stringContaining('sellingPrice: Below the cost price'),
      ]),
    );
    expect(issuesFor(preview, 4)).toEqual(['costPrice: An amount in cedis, like 2800 or 2,800.50']);
    expect(preview.counts).toEqual({ total: 3, ready: 0, blocked: 3 });
  });

  it('flags the second row that describes the same item', async () => {
    const preview = await imports.previewImportFile(
      csv([
        ['Gas cooker 4-burner', 'Nasco', 'Cooker', 'new', '2', '900', '1200'],
        ['gas cooker 4 burner', 'NASCO', 'Cooker', 'new', '1', '900', '1200'],
      ]),
    );
    expect(issuesFor(preview, 2)).toEqual([]);
    expect(issuesFor(preview, 3)).toEqual(['name: Same item as row 2']);
  });

  it('flags an item that is already on the shelf', async () => {
    await hp.createItem(officer, {
      name: 'Microwave 20L',
      brandId: new Types.ObjectId(brandIds.get('Samsung')),
      quantityInStock: 1,
      costPrice: 40_000,
      sellingPrice: 55_000,
    });
    const preview = await imports.previewImportFile(
      csv([['microwave 20l', 'samsung', '', '', '3', '400', '550']]),
    );
    expect(issuesFor(preview, 2)[0]).toContain('Already on the shelf');
  });
});

describe('stocking the accepted rows', () => {
  it('adds the good rows in pesewas and returns the bad ones with their reason', async () => {
    const teller = await makeTeller('Stock Teller');
    const preview = await imports.previewImportFile(
      csv([
        ['Television 43 inch', 'Hisense', 'TV', 'new', '2', '1,850.50', '2,600'],
        ['Iron', 'Binatone', 'Small appliance', 'new', '', '60', '95'],
      ]),
    );

    const result = await imports.importItems(teller, rowsFrom(preview));
    expect(result.counts).toMatchObject({ total: 2, created: 1, failed: 1 });
    expect(result.created[0]?.name).toBe('Television 43 inch');
    expect(result.failed[0]?.row).toBe(3);

    const saved = await HpItemModel.findOne({ name: 'Television 43 inch' });
    expect(saved).toMatchObject({
      condition: 'new',
      quantityInStock: 2,
      costPrice: 185_050,
      sellingPrice: 260_000,
    });
    expect(saved?.brandId?.toHexString()).toBe(brandIds.get('Hisense'));
    expect(saved?.categoryId).toBeDefined();
    expect(saved?.createdById.toHexString()).toBe(teller.sub);
    expect(await HpItemModel.findOne({ name: 'Iron' })).toBeNull();
  });

  it('re-checks on submit, so an item stocked since the preview still fails', async () => {
    const preview = await imports.previewImportFile(
      csv([['Kettle 1.7L', 'Nasco', '', '', '4', '70', '110']]),
    );
    expect(preview.counts.ready).toBe(1);

    await hp.createItem(officer, {
      name: 'Kettle 1.7L',
      brandId: new Types.ObjectId(brandIds.get('Nasco')),
      quantityInStock: 1,
      costPrice: 7_000,
      sellingPrice: 11_000,
    });

    const result = await imports.importItems(officer, rowsFrom(preview));
    expect(result.counts).toMatchObject({ created: 0, failed: 1 });
    expect(result.failed[0]?.issues[0]?.message).toContain('Already on the shelf');
    expect(await HpItemModel.countDocuments({ name: 'Kettle 1.7L' })).toBe(1);
  });
});

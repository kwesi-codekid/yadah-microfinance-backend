import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HpItemModel } from '../../src/models/index.js';
import * as labels from '../../src/modules/hire-purchase/hp-labels.service.js';
import * as hp from '../../src/modules/hire-purchase/hp.service.js';
import { asOfficer, setupDb, teardownDb } from './helpers.js';

/**
 * Brands and categories as managed lists. One name is one label whatever the
 * capitals, a rename reaches every item filed under it, and a label with items
 * still under it cannot be deleted from beneath them.
 */

const officer = asOfficer();

beforeAll(setupDb);
afterAll(teardownDb);

async function makeItem(name: string, extra: { brandId?: string; categoryId?: string } = {}) {
  return hp.createItem(officer, {
    name,
    quantityInStock: 1,
    costPrice: 10_000,
    sellingPrice: 15_000,
    ...(extra.brandId ? { brandId: new Types.ObjectId(extra.brandId) } : {}),
    ...(extra.categoryId ? { categoryId: new Types.ObjectId(extra.categoryId) } : {}),
  });
}

describe('one name, one label', () => {
  it('refuses a second brand that differs only in case or spacing', async () => {
    const nasco = await labels.createLabel(officer, 'brand', { name: 'Nasco' });
    await expect(labels.createLabel(officer, 'brand', { name: 'NASCO' })).rejects.toMatchObject({
      code: 'LABEL_TAKEN',
      details: { id: nasco.id },
    });
    await expect(labels.createLabel(officer, 'brand', { name: 'nasco ' })).rejects.toMatchObject({
      code: 'LABEL_TAKEN',
    });
    // The same name is fine as a category — the lists are separate.
    const asCategory = await labels.createLabel(officer, 'category', { name: 'Nasco' });
    expect(asCategory.kind).toBe('category');
  });

  it('counts the items filed under each label, and finds them by it', async () => {
    const fridge = await labels.createLabel(officer, 'category', {
      name: 'Fridge',
      description: 'Anything that keeps food cold',
    });
    const midea = await labels.createLabel(officer, 'brand', { name: 'Midea' });
    await makeItem('Fridge 300L', { brandId: midea.id, categoryId: fridge.id });
    await makeItem('Freezer 200L', { brandId: midea.id });

    const listed = await labels.listLabels('brand', { page: 1, limit: 50 });
    expect(listed.items.find((l) => l.id === midea.id)?.itemCount).toBe(2);
    expect((await labels.getLabel('category', new Types.ObjectId(fridge.id))).itemCount).toBe(1);

    const byBrand = await hp.listItems({
      page: 1,
      limit: 20,
      brandId: new Types.ObjectId(midea.id),
      format: 'json',
      inStockOnly: false,
    });
    expect(byBrand.items.map((i) => i.name).sort()).toEqual(['Freezer 200L', 'Fridge 300L']);
    expect(byBrand.items[0]?.brand).toEqual({ id: midea.id, name: 'Midea' });

    // Searching by the brand's name finds the items too.
    const searched = await hp.listItems({
      page: 1,
      limit: 20,
      search: 'midea',
      format: 'json',
      inStockOnly: false,
    });
    expect(searched.items.length).toBe(2);
  });

  it('refuses an item filed under a label that does not exist', async () => {
    await expect(
      makeItem('Ghost', { brandId: new Types.ObjectId().toHexString() }),
    ).rejects.toMatchObject({ code: 'LABEL_NOT_FOUND' });
  });
});

describe('renaming and removing', () => {
  it('renames in one place and every item reads the new name', async () => {
    const brand = await labels.createLabel(officer, 'brand', { name: 'Binatone' });
    const item = await makeItem('Rice cooker', { brandId: brand.id });
    expect(item.brand?.name).toBe('Binatone');

    await labels.updateLabel(officer, 'brand', new Types.ObjectId(brand.id), {
      name: 'Binatone Ghana',
      description: 'The local distributor',
    });
    const after = await hp.listItems({
      page: 1,
      limit: 20,
      search: 'Rice cooker',
      format: 'json',
      inStockOnly: false,
    });
    expect(after.items.find((i) => i.id === item.id)?.brand?.name).toBe('Binatone Ghana');

    // Clearing the description with null.
    const cleared = await labels.updateLabel(officer, 'brand', new Types.ObjectId(brand.id), {
      description: null,
    });
    expect(cleared.description).toBeUndefined();
  });

  it('will not delete a label from under its items, and does once they are moved', async () => {
    const brand = await labels.createLabel(officer, 'brand', { name: 'Hisense' });
    const item = await makeItem('Television', { brandId: brand.id });
    await expect(
      labels.deleteLabel(officer, 'brand', new Types.ObjectId(brand.id)),
    ).rejects.toMatchObject({ code: 'LABEL_IN_USE', details: { itemCount: 1 } });

    await hp.updateItem(officer, new Types.ObjectId(item.id), { brandId: null });
    const doc = await HpItemModel.findById(item.id);
    expect(doc?.brandId).toBeUndefined();

    await labels.deleteLabel(officer, 'brand', new Types.ObjectId(brand.id));
    await expect(labels.getLabel('brand', new Types.ObjectId(brand.id))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

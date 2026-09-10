import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerModel, UserModel } from '../../src/models/index.js';
import { toXlsxBuffer } from '../../src/lib/excel.js';
import * as imports from '../../src/modules/customers/customers.import.js';
import { asOfficer, makeCollector, setupDb, teardownDb } from './helpers.js';

/**
 * Bulk registration from a spreadsheet. The preview must never write, and it
 * must catch what the office would otherwise only discover on submit — a
 * phone already on the books, the same number twice in one sheet, a collector
 * nobody employs.
 */

const officer = asOfficer();
let collectorName: string;

async function setup(): Promise<void> {
  await setupDb();
  const collector = await makeCollector('Kofi Owusu');
  const user = await UserModel.findById(collector.sub);
  collectorName = user?.name ?? 'Kofi Owusu';
}
beforeAll(setup);
afterAll(teardownDb);

/** A sheet as the office would save it, with the template's own headings. */
function csv(rows: string[][]): { buffer: Buffer; mimetype: string; originalname: string } {
  const header = 'Full name,Phone,Collector,Date of birth,Gender,ID type,ID number';
  const body = rows.map((r) => r.join(',')).join('\n');
  return {
    buffer: Buffer.from(`${header}\n${body}\n`, 'utf8'),
    mimetype: 'text/csv',
    originalname: 'customers.csv',
  };
}

function issuesFor(preview: imports.ImportPreview, row: number): string[] {
  return (preview.rows.find((r) => r.row === row)?.issues ?? []).map(
    (i) => `${i.field}: ${i.message}`,
  );
}

describe('reading the sheet', () => {
  it('matches headings whatever their spacing and case, and names the ones it cannot place', async () => {
    const file = {
      buffer: Buffer.from(
        'FULL   NAME,mobile,Assigned Collector,Favourite colour\nAma Mensah,0241110001,Kofi Owusu,blue\n',
        'utf8',
      ),
      mimetype: 'text/csv',
      originalname: 'odd-headings.csv',
    };
    const preview = await imports.previewImportFile(file);
    expect(preview.unknownHeaders).toEqual(['Favourite colour']);
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]?.values.fullName).toBe('Ama Mensah');
    expect(preview.rows[0]?.issues).toEqual([]);
  });

  it('reads an xlsx workbook as readily as a csv', async () => {
    const buffer = await toXlsxBuffer([
      {
        'Full name': 'Yaa Asante',
        Phone: '0241110002',
        Collector: collectorName,
        'Date of birth': '1992-03-04',
      },
    ]);
    const preview = await imports.previewImportFile({
      buffer,
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      originalname: 'customers.xlsx',
    });
    expect(preview.counts).toMatchObject({ total: 1, ready: 1, blocked: 0 });
    expect(preview.rows[0]?.values.phone).toBe('0241110002');
  });

  it('keeps a quoted comma inside one cell', async () => {
    const file = {
      buffer: Buffer.from(
        'Full name,Phone,Collector,Residential address\nAma Mensah,0241110003,Kofi Owusu,"Market Road, Esiama"\n',
        'utf8',
      ),
      mimetype: 'text/csv',
      originalname: 'quoted.csv',
    };
    const preview = await imports.previewImportFile(file);
    expect(preview.rows[0]?.values.residentialAddress).toBe('Market Road, Esiama');
  });

  it('refuses a sheet whose headings match nothing', async () => {
    await expect(
      imports.previewImportFile({
        buffer: Buffer.from('one,two\n1,2\n', 'utf8'),
        mimetype: 'text/csv',
        originalname: 'wrong.csv',
      }),
    ).rejects.toMatchObject({ code: 'NO_KNOWN_COLUMNS' });
  });
});

describe('checking the rows', () => {
  it('flags what is wrong without writing anything', async () => {
    const before = await CustomerModel.countDocuments();
    const preview = await imports.previewImportFile(
      csv([
        [
          'Ama Mensah',
          '0241112221',
          collectorName,
          '1990-04-12',
          'female',
          'ghana-card',
          'GHA-111111111-1',
        ],
        ['', '0241112222', collectorName, '', '', '', ''],
        ['Kojo Bad Phone', '0000', collectorName, '', '', '', ''],
        ['Esi Nobody', '0241112224', 'Someone Else', '', '', '', ''],
        ['Yaw Badcard', '0241112225', collectorName, '', '', 'ghana-card', 'NOT-A-CARD'],
      ]),
    );

    expect(await CustomerModel.countDocuments()).toBe(before);
    expect(issuesFor(preview, 2)).toEqual([]);
    expect(issuesFor(preview, 3).join(' ')).toMatch(/fullName/);
    expect(issuesFor(preview, 4).join(' ')).toMatch(/phone/);
    expect(issuesFor(preview, 5).join(' ')).toMatch(/No active collector called "Someone Else"/);
    expect(issuesFor(preview, 6).join(' ')).toMatch(/idNumber.*Ghana Card/);
    expect(preview.counts).toMatchObject({ total: 5, ready: 1, blocked: 4 });
  });

  it('flags the second row carrying a number the sheet already used', async () => {
    const preview = await imports.previewImportFile(
      csv([
        ['First Claim', '0241113331', collectorName, '', '', '', ''],
        ['Second Claim', '0241113331', collectorName, '', '', '', ''],
      ]),
    );
    expect(issuesFor(preview, 2)).toEqual([]);
    expect(issuesFor(preview, 3)).toEqual(['phone: Same phone as row 2']);
  });

  it('flags a phone that is already on a customer', async () => {
    await CustomerModel.create({
      fullName: 'Already Here',
      phone: '0241114441',
      registeredById: new Types.ObjectId(),
      status: 'active',
    });
    const preview = await imports.previewImportFile(
      csv([['New Person', '0241114441', collectorName, '', '', '', '']]),
    );
    expect(issuesFor(preview, 2)).toEqual(['phone: A customer already has this phone number']);
  });

  it('offers the collectors a row can be moved to', async () => {
    const preview = await imports.previewImportFile(
      csv([['Ama Mensah', '0241115551', collectorName, '', '', '', '']]),
    );
    expect(preview.collectors.map((c) => c.name)).toContain(collectorName);
    expect(preview.rows[0]?.assignedCollectorId).toBe(preview.collectors[0]?.id);
  });
});

describe('registering the accepted rows', () => {
  /** The shape the preview hands back to the office, and gets back corrected. */
  function rowsFrom(preview: imports.ImportPreview) {
    return preview.rows.map((r) => ({ row: r.row, values: r.values }));
  }

  it('creates the good rows and returns the bad ones with their reason', async () => {
    const preview = await imports.previewImportFile(
      csv([
        ['Good One', '0241116661', collectorName, '1990-04-12', 'female', '', ''],
        ['Bad Collector', '0241116662', 'Nobody At All', '', '', '', ''],
      ]),
    );

    const result = await imports.importCustomers(officer, rowsFrom(preview));
    expect(result.counts).toMatchObject({ total: 2, created: 1, failed: 1 });
    expect(result.created[0]?.fullName).toBe('GOOD ONE');
    expect(result.failed[0]?.row).toBe(3);

    const saved = await CustomerModel.findOne({ phone: '0241116661' });
    expect(saved?.assignedCollectorId).toBeTruthy();
    // No column can carry a photo, so an imported customer arrives without one.
    expect(saved?.photoUrl).toBeUndefined();
    expect(await CustomerModel.findOne({ phone: '0241116662' })).toBeNull();
  });

  it('stores the whole record a full row describes', async () => {
    const file = {
      buffer: Buffer.from(
        [
          'Full name,Phone,Collector,Date of birth,Gender,Marital status,Occupation,Residential address,Secondary phone,ID type,ID number,Next of kin name,Next of kin phone',
          `Full Record,0241117771,${collectorName},12/04/1990,Female,Married,Trader,"Market Road, Esiama",0551117771,Ghana Card,GHA-222222222-2,Kin Person,0209117771`,
        ].join('\n'),
        'utf8',
      ),
      mimetype: 'text/csv',
      originalname: 'full.csv',
    };
    const preview = await imports.previewImportFile(file);
    expect(preview.rows[0]?.issues).toEqual([]);

    await imports.importCustomers(officer, rowsFrom(preview));
    const saved = await CustomerModel.findOne({ phone: '0241117771' });
    expect(saved).toMatchObject({
      fullName: 'FULL RECORD',
      gender: 'female',
      maritalStatus: 'married',
      occupation: 'TRADER',
      residentialAddress: 'MARKET ROAD, ESIAMA',
      altPhone: '0551117771',
    });
    // Written 12/04/1990, meaning the twelfth of April.
    expect(saved?.dateOfBirth?.toISOString().slice(0, 10)).toBe('1990-04-12');
    expect(saved?.identification).toMatchObject({
      idType: 'ghana-card',
      idNumber: 'GHA-222222222-2',
    });
    expect(saved?.nextOfKin).toMatchObject({ fullName: 'KIN PERSON', phone: '0209117771' });
  });

  it('re-checks on submit, so a number taken since the preview still fails', async () => {
    const preview = await imports.previewImportFile(
      csv([['Race Loser', '0241118881', collectorName, '', '', '', '']]),
    );
    expect(preview.rows[0]?.issues).toEqual([]);

    // Somebody else registers that number while the preview sits open.
    await CustomerModel.create({
      fullName: 'Race Winner',
      phone: '0241118881',
      registeredById: new Types.ObjectId(),
      status: 'active',
    });

    const result = await imports.importCustomers(officer, rowsFrom(preview));
    expect(result.counts).toMatchObject({ created: 0, failed: 1 });
    expect(result.failed[0]?.issues[0]?.field).toBe('phone');
  });
});

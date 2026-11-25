import type { Types } from 'mongoose';
import { rangeToWindow } from '../../lib/time.js';
import {
  RepaymentModel,
  SavingsTxnModel,
  SusuDepositModel,
  UserModel,
} from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';

export interface EnteredForCollector {
  collectorId: string;
  collectorName: string;
  /** How many entries this person typed in for the collector. */
  count: number;
  /** Everything typed in for them, pesewas, whatever the channel. */
  amount: number;
  /** The cash part — what the collector should have handed over. */
  cash: number;
  susu: number;
  savings: number;
  loans: number;
}

export interface EnteredForCollectors {
  from: string;
  to: string;
  staffId: string;
  collectors: EnteredForCollector[];
  total: { count: number; amount: number; cash: number };
}

interface Group {
  _id: { collector: Types.ObjectId; channel: string | null };
  count: number;
  amount: number;
}

/** Entries grouped by the collector they are filed under, and by channel. */
function byCollector(field: 'collectorId' | 'recordedById') {
  return {
    $group: {
      _id: {
        collector: field === 'collectorId' ? '$collectorId' : '$recordedById',
        channel: '$channel',
      },
      count: { $sum: 1 },
      amount: { $sum: '$amount' },
    },
  };
}

/**
 * What one member of staff typed in for collectors over a range, collector by
 * collector (client request, 25 Nov 2026): at the end of the day the attendant
 * sees their own cash on the ledger, and here what they entered for each
 * collector. The money is filed under the collector — it is not in the
 * attendant's own ledger totals, and it is counted once here.
 */
export async function enteredForCollectors(
  enteredById: Types.ObjectId,
  from?: string,
  to?: string,
): Promise<EnteredForCollectors> {
  const window = rangeToWindow(from, to);
  const createdAt = { $gte: window.start, $lt: window.end };

  const [susu, savings, loans] = await Promise.all([
    SusuDepositModel.aggregate<Group>([
      { $match: { enteredById, createdAt, ...NOT_TRASHED } },
      byCollector('collectorId'),
    ]),
    SavingsTxnModel.aggregate<Group>([
      { $match: { enteredById, type: 'deposit', createdAt, ...NOT_TRASHED } },
      byCollector('recordedById'),
    ]),
    RepaymentModel.aggregate<Group>([
      { $match: { enteredById, source: 'cash', createdAt, ...NOT_TRASHED } },
      byCollector('recordedById'),
    ]),
  ]);

  const rows = new Map<string, EnteredForCollector>();
  const add = (groups: Group[], product: 'susu' | 'savings' | 'loans'): void => {
    for (const g of groups) {
      const id = g._id.collector.toHexString();
      let row = rows.get(id);
      if (!row) {
        row = {
          collectorId: id,
          collectorName: '',
          count: 0,
          amount: 0,
          cash: 0,
          susu: 0,
          savings: 0,
          loans: 0,
        };
        rows.set(id, row);
      }
      row.count += g.count;
      row.amount += g.amount;
      row[product] += g.amount;
      if ((g._id.channel ?? 'cash') === 'cash') row.cash += g.amount;
    }
  };
  add(susu, 'susu');
  add(savings, 'savings');
  add(loans, 'loans');

  const users = await UserModel.find({ _id: { $in: [...rows.keys()] } }, { name: 1 });
  for (const u of users) {
    const row = rows.get(u._id.toHexString());
    if (row) row.collectorName = u.name;
  }
  const collectors = [...rows.values()]
    .map((r) => ({ ...r, collectorName: r.collectorName || 'Former staff' }))
    .sort((a, b) => b.amount - a.amount);

  return {
    from: window.from,
    to: window.to,
    staffId: enteredById.toHexString(),
    collectors,
    total: {
      count: collectors.reduce((n, r) => n + r.count, 0),
      amount: collectors.reduce((n, r) => n + r.amount, 0),
      cash: collectors.reduce((n, r) => n + r.cash, 0),
    },
  };
}

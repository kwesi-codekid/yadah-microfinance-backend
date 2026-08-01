/**
 * Demo dataset (WBS 7.5): realistic customers, susu cycles in progress,
 * savings with history, loans in every state. Idempotent-ish: run with
 * --wipe first to remove previously seeded demo data.
 *
 *   npx tsx src/scripts/seed-demo.ts --wipe   # remove old demo data
 *   npx tsx src/scripts/seed-demo.ts          # seed
 *
 * All demo customers use the 02090xxxxx phone range EXCEPT the VIP demo
 * customer (Esi Mensah) who carries the authorized test number so the live
 * SMS moment in the demo lands on a real phone in the room. Seeding writes
 * documents directly (no SMS is sent during seeding).
 */
import bcrypt from 'bcrypt';
import { connectDb, disconnectDb } from '../lib/db.js';
import {
  generateAccountNumber,
  SAVINGS_ACCOUNT_DIGITS,
  SUSU_ACCOUNT_DIGITS,
} from '../lib/account-number.js';
import { accraDay } from '../lib/time.js';
import { buildSchedule, computeInterest, addMonthsClamped } from '../domain/loans.js';
import { SUSU_CYCLE_DEPOSITS } from '../domain/susu.js';
import {
  AuditLogModel,
  CustomerModel,
  LoanModel,
  LoanScheduleModel,
  RepaymentModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SmsLogModel,
  SusuAccountModel,
  SusuDepositModel,
  UserModel,
  type Customer,
  type LoanSchedule,
  type SavingsTxn,
} from '../models/index.js';
import { BCRYPT_COST } from '../modules/auth/auth.service.js';

const DEMO_PREFIX = '02090';
const VIP_PHONE = '0594213496'; // authorized test number — the live SMS moment

const NAMES = [
  'Kofi Asante',
  'Ama Serwaa',
  'Kwame Boateng',
  'Akosua Agyemang',
  'Yaw Darko',
  'Abena Owusu',
  'Kwabena Mensah',
  'Efua Addo',
  'Kojo Antwi',
  'Adwoa Frimpong',
  'Kwesi Appiah',
  'Esi Badu',
  'Kwaku Oppong',
  'Akua Sarpong',
  'Yao Tetteh',
  'Aba Quartey',
  'Fiifi Arthur',
  'Araba Annan',
  'Ekow Hayford',
  'Efuwa Baiden',
  'Papa Kwarteng',
  'Maame Yeboah',
  'Nana Gyasi',
];

const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const pick = <T>(arr: T[], i: number): T => arr[i % arr.length] as T;

async function wipe(): Promise<void> {
  const demoCustomers = await CustomerModel.find({
    $or: [{ phone: { $regex: `^${DEMO_PREFIX}` } }, { phone: VIP_PHONE }],
  }).select('_id');
  const ids = demoCustomers.map((c) => c._id);
  await Promise.all([
    SusuDepositModel.deleteMany({ customerId: { $in: ids } }),
    SusuAccountModel.deleteMany({ customerId: { $in: ids } }),
    SavingsTxnModel.deleteMany({ customerId: { $in: ids } }),
    SavingsAccountModel.deleteMany({ customerId: { $in: ids } }),
    RepaymentModel.deleteMany({ customerId: { $in: ids } }),
    LoanScheduleModel.deleteMany({ customerId: { $in: ids } }),
    LoanModel.deleteMany({ customerId: { $in: ids } }),
    SmsLogModel.deleteMany({
      to: { $in: [VIP_PHONE, ...demoCustomers.map((c) => c._id.toHexString())] },
    }),
    AuditLogModel.deleteMany({ entityId: { $in: ids } }),
  ]);
  await CustomerModel.deleteMany({ _id: { $in: ids } });
  const users = await UserModel.deleteMany({ username: { $regex: '^demo\\.' } });
  console.log(
    `wiped ${String(ids.length)} demo customers and ${String(users.deletedCount)} demo users`,
  );
}

async function seed(): Promise<void> {
  // --- staff
  const passwordHash = await bcrypt.hash('demo-pass-2026', BCRYPT_COST);
  const [manager, col1, col2] = await UserModel.create([
    {
      name: 'Efua Manu',
      username: 'demo.manager',
      phone: `${DEMO_PREFIX}00001`,
      role: 'manager',
      passwordHash,
      status: 'active',
    },
    {
      name: 'Kwame Adjei',
      username: 'demo.kwame',
      phone: `${DEMO_PREFIX}00002`,
      role: 'collector',
      passwordHash,
      status: 'active',
    },
    {
      name: 'Abena Osei',
      username: 'demo.abena',
      phone: `${DEMO_PREFIX}00003`,
      role: 'collector',
      passwordHash,
      status: 'active',
    },
  ]);
  const collectors = [col1!._id, col2!._id];

  // --- customers (VIP first — the phone in the room)
  const vip = await CustomerModel.create({
    fullName: 'Esi Mensah',
    phone: VIP_PHONE,
    gender: 'female',
    nationality: 'Ghanaian',
    occupation: 'Market trader',
    residentialAddress: 'Esiama Main Market',
    ghanaPostGps: 'WR-123-4567',
    identification: { idType: 'ghana-card', idNumber: 'GHA-100000001-1' },
    registeredById: manager!._id,
    status: 'active',
  });

  const customerDocs: Partial<Customer>[] = NAMES.map((fullName, i) => ({
    fullName,
    phone: `${DEMO_PREFIX}1${String(i).padStart(4, '0')}`,
    gender: i % 2 === 0 ? 'male' : 'female',
    nationality: 'Ghanaian',
    occupation: pick(['Trader', 'Farmer', 'Seamstress', 'Driver', 'Shop owner'], i),
    ...(i < 8
      ? {
          identification: {
            idType: 'ghana-card' as const,
            idNumber: `GHA-2000000${String(10 + i)}-3`,
          },
        }
      : {}),
    registeredById: manager!._id,
    status: 'active',
  }));
  const customers = await CustomerModel.create(customerDocs);

  // --- susu accounts: VIP mid-cycle + 14 others at varied progress
  const dailies = [500, 1000, 2000, 5000];
  const susuTargets = [{ customer: vip, daily: 2000, progress: 20 }].concat(
    customers.slice(0, 14).map((c, i) => ({
      customer: c,
      daily: pick(dailies, i),
      progress: 3 + ((i * 5) % 26),
    })),
  );
  let susuDocs = 0;
  for (const target of susuTargets) {
    const openedAt = daysAgo(target.progress + 4);
    const [account] = await SusuAccountModel.create([
      {
        accountNumber: generateAccountNumber(SUSU_ACCOUNT_DIGITS),
        customerId: target.customer._id,
        dailyAmount: target.daily,
        depositsCount: target.progress,
        totalDeposited: target.daily * target.progress,
        status: target.progress >= SUSU_CYCLE_DEPOSITS ? 'completed' : 'active',
        openedById: manager!._id,
      },
    ]);
    await SusuAccountModel.updateOne(
      { _id: account!._id },
      { $set: { createdAt: openedAt } },
      { timestamps: false },
    );
    // History: mostly single days, one catch-up in the middle.
    let seq = 0;
    let day = target.progress + 3;
    while (seq < target.progress) {
      const chunk = seq === 5 ? Math.min(3, target.progress - seq) : 1;
      const created = await SusuDepositModel.create([
        {
          accountId: account!._id,
          customerId: target.customer._id,
          collectorId: pick(collectors, seq),
          amount: target.daily * chunk,
          daysCovered: chunk,
          seqStart: seq + 1,
          seqEnd: seq + chunk,
          channel: 'cash',
          idempotencyKey: `demo-${account!._id.toHexString()}-${String(seq)}`,
        },
      ]);
      await SusuDepositModel.updateOne(
        { _id: created[0]!._id },
        { $set: { createdAt: daysAgo(day) } },
        { timestamps: false },
      );
      seq += chunk;
      day -= chunk;
      susuDocs++;
    }
  }

  // --- savings: VIP + 9 others with a little history
  const savingsTargets = [{ customer: vip, balance: 150_000 }].concat(
    customers.slice(8, 17).map((c, i) => ({ customer: c, balance: 20_000 + i * 35_000 })),
  );
  for (const [i, target] of savingsTargets.entries()) {
    const [account] = await SavingsAccountModel.create([
      {
        accountNumber: generateAccountNumber(SAVINGS_ACCOUNT_DIGITS),
        customerId: target.customer._id,
        balance: target.balance,
        openedById: manager!._id,
      },
    ]);
    const openedDaysAgo = 40 + i;
    await SavingsAccountModel.updateOne(
      { _id: account!._id },
      { $set: { createdAt: daysAgo(openedDaysAgo) } },
      { timestamps: false },
    );
    // Two deposits and (for some) one withdrawal, balanceAfter chain consistent.
    const first = Math.floor(target.balance / 2);
    const withdrawal = i % 3 === 0 ? 5_000 : 0;
    const second = target.balance - first + (withdrawal > 0 ? withdrawal + 1_000 : 0);
    const txns = [
      { type: 'deposit', amount: first, balanceAfter: first, at: daysAgo(openedDaysAgo) },
      { type: 'deposit', amount: second, balanceAfter: first + second, at: daysAgo(20) },
      ...(withdrawal > 0
        ? [
            {
              type: 'withdrawal',
              amount: withdrawal,
              fee: 1_000,
              balanceAfter: first + second - withdrawal - 1_000,
              at: daysAgo(6),
            },
          ]
        : []),
    ];
    for (const t of txns) {
      const txnDoc: Partial<SavingsTxn> = {
        accountId: account!._id,
        customerId: target.customer._id,
        type: t.type as SavingsTxn['type'],
        amount: t.amount,
        ...(t.fee !== undefined ? { fee: t.fee } : {}),
        balanceAfter: t.balanceAfter,
        channel: 'cash',
        accraDay: accraDay(t.at),
        recordedById: pick(collectors, i),
      };
      const created = await SavingsTxnModel.create([txnDoc]);
      await SavingsTxnModel.updateOne(
        { _id: created[0]!._id },
        { $set: { createdAt: t.at } },
        { timestamps: false },
      );
    }
  }

  // --- loans: one in each state (customers 0..3 have ghana cards)
  const loanFixtures = [
    { customer: customers[0]!, state: 'pending' as const },
    { customer: customers[1]!, state: 'active' as const },
    { customer: customers[2]!, state: 'repaid' as const },
    { customer: customers[3]!, state: 'arrears' as const },
  ];
  for (const fixture of loanFixtures) {
    const principal = 500_000; // GHS 5,000 small loan
    const rate = 10;
    const interest = computeInterest(principal, rate);
    const totalDue = principal + interest;
    if (fixture.state === 'pending') {
      await LoanModel.create({
        customerId: fixture.customer._id,
        tier: 'small',
        principal,
        durationMonths: 3,
        ratePercent: rate,
        interestAmount: interest,
        totalDue,
        appliedAt: daysAgo(1),
      });
      continue;
    }
    const start =
      fixture.state === 'active'
        ? daysAgo(35)
        : fixture.state === 'repaid'
          ? daysAgo(150)
          : daysAgo(400);
    const dueDate = addMonthsClamped(start, 3);
    const escalatedInterest =
      fixture.state === 'arrears' ? computeInterest(principal, 30) : interest;
    const [loan] = await LoanModel.create([
      {
        customerId: fixture.customer._id,
        tier: 'small',
        principal,
        durationMonths: 3,
        ratePercent: fixture.state === 'arrears' ? 30 : rate,
        interestAmount: escalatedInterest,
        totalDue: principal + escalatedInterest,
        totalRepaid:
          fixture.state === 'repaid'
            ? totalDue
            : fixture.state === 'active'
              ? Math.floor(totalDue / 3)
              : 100_000,
        status: fixture.state,
        frozen: fixture.state === 'arrears',
        appliedAt: daysAgo(2) < start ? daysAgo(2) : start,
        approvedById: manager!._id,
        approvedAt: start,
        disbursedAt: start,
        dueDate,
        ...(fixture.state === 'repaid'
          ? { closedAt: addMonthsClamped(start, 3), repaidOnTime: true }
          : {}),
        ...(fixture.state === 'arrears' ? { escalatedAt: daysAgo(30) } : {}),
      },
    ]);
    const schedule = buildSchedule(loan!.totalDue, 3, start);
    const scheduleDocs: Partial<LoanSchedule>[] = schedule.map((line, idx) => ({
      loanId: loan!._id,
      customerId: fixture.customer._id,
      installmentNumber: line.installmentNumber,
      dueDate: line.dueDate,
      amountDue: line.amountDue,
      amountPaid:
        fixture.state === 'repaid'
          ? line.amountDue
          : idx === 0 && fixture.state !== 'arrears'
            ? line.amountDue
            : 0,
      status:
        fixture.state === 'repaid'
          ? 'paid'
          : idx === 0 && fixture.state !== 'arrears'
            ? 'paid'
            : 'pending',
    }));
    await LoanScheduleModel.create(scheduleDocs);
    const repaidAmount = loan!.totalRepaid;
    if (repaidAmount > 0) {
      await RepaymentModel.create({
        loanId: loan!._id,
        customerId: fixture.customer._id,
        amount: repaidAmount,
        source: 'cash',
        channel: 'cash',
        recordedById: manager!._id,
      });
    }
  }

  console.log('--- demo data seeded ---');
  console.log(`customers: ${String(customers.length + 1)} (VIP: Esi Mensah, ${VIP_PHONE})`);
  console.log(`susu accounts: ${String(susuTargets.length)} (${String(susuDocs)} deposit records)`);
  console.log(`savings accounts: ${String(savingsTargets.length)}`);
  console.log('loans: pending, active, repaid-on-time, arrears (one each)');
  console.log('staff logins (password: demo-pass-2026): demo.manager, demo.kwame, demo.abena');
}

const shouldWipe = process.argv.includes('--wipe');
await connectDb();
if (shouldWipe) {
  await wipe();
} else {
  await seed();
}
await disconnectDb();

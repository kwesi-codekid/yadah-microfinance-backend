/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-plus-operands, @typescript-eslint/restrict-template-expressions, no-useless-assignment */
/**
 * Full test dataset for local development: eight months of branch activity
 * across every module, replayed through the real HTTP API.
 *
 *   npm run seed:full -- --reset    wipe yadah-dev (keeps the admin), then seed
 *   npm run seed:full               seed an empty database
 *   npm run seed:full -- --verify   only re-run the checks against what is there
 *
 * Nothing is written straight to a money collection. Each day is replayed with
 * the clock set to that day (see seed-clock.ts), so validation, permissions,
 * transactions, commission, schedules, escalation and audit all run for real
 * and the ledgers agree because the application itself produced them. The two
 * exceptions are things that need an outside party: Paystack charges (only
 * pending/failed ones, which move no money) and the customer's own portal
 * request, which goes through the service without a phone in hand.
 *
 * Development database only, and it refuses anything else. All outside services
 * are off for this process, and every message left in the SMS log is closed at
 * the end, so adding an SMS key later cannot text these made-up numbers.
 */
import { realTime, resetClock, setClock } from './seed-clock.js';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { createApp } from '../app.js';
import { env } from '../config/env.js';
import { ensureChildPhoneRule } from '../lib/child-phones.js';
import { connectDb, disconnectDb } from '../lib/db.js';
import { runDebtRecoveryPass } from '../lib/debt-recovery.js';
import { runHpArrearsPass } from '../lib/hp-arrears.js';
import { runEscalationPass } from '../lib/loan-escalation.js';
import { logger } from '../lib/logger.js';
import {
  CustomerModel,
  HpAgreementModel,
  HpItemModel,
  HpPaymentModel,
  LoanModel,
  LoanScheduleModel,
  PaystackChargeModel,
  PortalOtpModel,
  RepaymentModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SmsLogModel,
  SusuAccountModel,
  UserModel,
} from '../models/index.js';
import { BCRYPT_COST } from '../modules/auth/auth.service.js';
import { submitRequest, rejectRequest } from '../modules/portal/payout-requests.service.js';
import { susuBalanceAsOf } from '../modules/susu/susu.service.js';

type J = Record<string, any>;
interface Actor {
  id: string;
  role: 'admin' | 'manager' | 'teller' | 'collector';
}

const START_DAYS_AGO = 240;
const DAY_MS = 86_400_000;
const STAFF_PASSWORD = 'Test@12345';
const IMG = 'https://res.cloudinary.com/demo/image/upload';
const GHS = (n: number): number => Math.round(n * 100);

// -------------------------------------------------------------- deterministic chance

let prngState = 20261104;
function chance(probability: number): boolean {
  prngState = (prngState + 0x6d2b79f5) | 0;
  let t = Math.imul(prngState ^ (prngState >>> 15), 1 | prngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296 < probability;
}

// -------------------------------------------------------------- clock

const todayMidnight = (): number => Math.floor(realTime() / DAY_MS) * DAY_MS;
function setDay(daysAgo: number, hour: number): void {
  // Today runs on the real clock: nothing may be stamped later than now.
  if (daysAgo === 0) resetClock();
  else setClock(todayMidnight() - daysAgo * DAY_MS + hour * 3_600_000);
}
const dayStr = (daysAgo: number): string =>
  new Date(todayMidnight() - daysAgo * DAY_MS).toISOString().slice(0, 10);
const isSunday = (daysAgo: number): boolean =>
  new Date(todayMidnight() - daysAgo * DAY_MS).getUTCDay() === 0;

// -------------------------------------------------------------- HTTP

let base = '';

function tokenFor(actor: Actor): string {
  return jwt.sign(
    { sub: actor.id, role: actor.role, fam: 'seed', typ: 'staff' },
    env.JWT_ACCESS_SECRET,
    { expiresIn: '15m' },
  );
}

async function raw(
  actor: Actor | null,
  method: string,
  path: string,
  body?: unknown,
  bearer?: string,
): Promise<{ status: number; data: any; contentType: string }> {
  const token = bearer ?? (actor ? tokenFor(actor) : undefined);
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const contentType = res.headers.get('content-type') ?? '';
  const data = contentType.includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data, contentType };
}

/** Anything but success stops the seed: a refused step means a wrong scenario. */
async function api(actor: Actor, method: string, path: string, body?: unknown): Promise<J> {
  const { status, data } = await raw(actor, method, path, body);
  if (status >= 300) {
    throw new Error(
      `${method} ${path} as ${actor.role} → ${String(status)}\n` +
        `body: ${JSON.stringify(body)}\nresponse: ${JSON.stringify(data)}`,
    );
  }
  return data as J;
}

const skipped = new Map<string, number>();
/**
 * For steps the business rules may legitimately refuse by then, such as a
 * savings balance the recovery worker has already swept. Only these refusals
 * are tolerated, and they are counted in the final report.
 */
async function attempt(
  actor: Actor,
  method: string,
  path: string,
  body: unknown,
  label: string,
): Promise<J | null> {
  const { status, data } = await raw(actor, method, path, body);
  if (status < 300) return data as J;
  if (status === 409 || status === 422) {
    const key = `${label}: ${String(data?.error?.code)}`;
    skipped.set(key, (skipped.get(key) ?? 0) + 1);
    return null;
  }
  throw new Error(`${method} ${path} → ${String(status)}: ${JSON.stringify(data)}`);
}

const key = (): string => `seed-${randomUUID()}`;

// -------------------------------------------------------------- reference data

const NAMES = [
  'Kofi Asante', 'Ama Serwaa', 'Kwame Boateng', 'Akosua Agyemang', 'Yaw Darko', 'Abena Owusu',
  'Kwabena Mensah', 'Efua Addo', 'Kojo Antwi', 'Adwoa Frimpong', 'Kwesi Appiah', 'Esi Badu',
  'Kwaku Oppong', 'Akua Sarpong', 'Yao Tetteh', 'Aba Quartey', 'Fiifi Arthur', 'Araba Annan',
  'Ekow Hayford', 'Efuwa Baiden', 'Papa Kwarteng', 'Maame Yeboah', 'Nana Gyasi', 'Afia Nyarko',
  'Kobina Eshun', 'Adjoa Ampofo', 'Selorm Agbeko', 'Dzifa Amegashie', 'Ibrahim Alhassan',
  'Fatima Iddrisu', 'Mawuli Dogbe', 'Sena Kpodo', 'Kwadwo Bonsu', 'Yaa Pokua', 'Nii Lamptey',
  'Naa Dede', 'Tetteh Ocloo', 'Akweley Laryea', 'Bright Ofori', 'Comfort Danso',
  'Emmanuel Sackey', 'Philomena Aidoo', 'Junior Asante', 'Blessing Serwaa', 'Gifty Ansah',
]; // prettier-ignore
const OCCUPATIONS = ['Trader', 'Farmer', 'Seamstress', 'Driver', 'Shop owner', 'Hairdresser', 'Fishmonger', 'Carpenter']; // prettier-ignore
const TOWNS = ['Esiama Main Market', 'Axim Road', 'Nkroful Junction', 'Takoradi Market Circle', 'Agona Nkwanta', 'Sekondi Ridge']; // prettier-ignore
const DAILY = [GHS(10), GHS(15), GHS(20), GHS(30), GHS(50)];

interface Cust {
  idx: number;
  id: string;
  phone: string;
  collector: Actor | null;
}
interface SusuAcct {
  id: string;
  cust: Cust;
  daily: number;
  planIds: string[];
  onRound: boolean;
}

const staff: Record<string, Actor> = {};
const custs: Cust[] = [];
const susu = new Map<number, SusuAcct>();
const savings = new Map<number, string>();
const loans: Record<string, string> = {};
const items: Record<string, string> = {};
const agreements: Record<string, string> = {};
const cash: Record<string, string> = {};
const lastDeposit = new Map<number, string>();

const collectors = (): Actor[] => [staff.collector1!, staff.collector2!, staff.collector3!];
const cashHandlers = (): Actor[] => [...collectors(), staff.teller!];

// -------------------------------------------------------------- reset

async function wipeAllButAdmin(): Promise<void> {
  const db = mongoose.connection.db;
  if (env.NODE_ENV !== 'development' || db?.databaseName !== 'yadah-dev') {
    throw new Error(`Refusing to wipe "${String(db?.databaseName)}" — yadah-dev only`);
  }
  for (const model of Object.values(mongoose.models)) {
    if (model === UserModel) await model.deleteMany({ username: { $ne: 'admin' } });
    else await model.deleteMany({});
  }
}

async function ensureAdmin(): Promise<void> {
  let admin = await UserModel.findOne({ username: 'admin' });
  admin ??= await UserModel.create({
    name: 'System Admin',
    username: 'admin',
    phone: '0594213496',
    passwordHash: await bcrypt.hash('admin-dev-password', BCRYPT_COST),
    role: 'admin',
    status: 'active',
  });
  staff.admin = { id: admin._id.toHexString(), role: 'admin' };
}

// -------------------------------------------------------------- builders

async function addStaff(name: string, username: string, phone: string, role: Actor['role']) {
  const { status, data } = await raw(staff.admin!, 'POST', '/users', {
    name,
    username,
    phone,
    role,
    password: STAFF_PASSWORD,
  });
  if (status >= 300) throw new Error(`user ${username}: ${JSON.stringify(data)}`);
  staff[username] = { id: (data.user ?? data).id, role };
}

async function addCustomer(
  idx: number,
  by: Actor,
  collector: Actor | null,
  opts: { docs?: boolean; dob?: string; phone?: string } = {},
): Promise<Cust> {
  const phone = opts.phone ?? `0209000${String(100 + idx)}`;
  const withDocs = opts.docs ?? true;
  const { customer } = await api(by, 'POST', '/customers', {
    fullName: NAMES[idx],
    phone,
    gender: idx % 2 === 0 ? 'male' : 'female',
    nationality: 'Ghanaian',
    maritalStatus: idx % 3 === 0 ? 'single' : 'married',
    dateOfBirth: opts.dob ?? `19${String(70 + (idx % 25))}-0${String(1 + (idx % 9))}-15`,
    occupation: OCCUPATIONS[idx % OCCUPATIONS.length],
    residentialAddress: TOWNS[idx % TOWNS.length],
    joinedOn: dayStr(START_DAYS_AGO),
    identification: withDocs
      ? { idType: 'ghana-card', idNumber: `GHA-7${String(10000000 + idx)}-${String(idx % 10)}` }
      : undefined,
    nextOfKin: {
      fullName: NAMES[(idx + 7) % NAMES.length]!,
      relationship: 'Sibling',
      phone: `0209001${String(100 + idx)}`,
    },
    photoUrl: `${IMG}/sample.jpg`,
    ...(withDocs
      ? { idDocumentFrontUrl: `${IMG}/sample.jpg`, idDocumentBackUrl: `${IMG}/sample.jpg` }
      : {}),
    ...(collector ? { assignedCollectorId: collector.id } : {}),
  });
  const cust = { idx, id: customer.id, phone, collector };
  custs[idx] = cust;
  return cust;
}

async function openSusu(idx: number, daily: number): Promise<void> {
  const cust = custs[idx]!;
  const res = await api(staff.teller!, 'POST', '/susu/accounts', {
    customerId: cust.id,
    dailyAmount: daily,
  });
  const account = res.account ?? res;
  susu.set(idx, {
    id: account.id,
    cust,
    daily,
    planIds: account.plans.map((p: J) => p.id),
    onRound: true,
  });
}

async function openSavings(idx: number, initial: number, type = 'standard'): Promise<void> {
  const res = await api(staff.teller!, 'POST', '/savings/accounts', {
    customerId: custs[idx]!.id,
    accountType: type,
    initialDeposit: initial,
    idempotencyKey: key(),
    channel: 'cash',
  });
  savings.set(idx, (res.account ?? res).id);
}

async function refreshPlans(a: SusuAcct): Promise<J> {
  const res = await api(staff.manager!, 'GET', `/susu/accounts/${a.id}`);
  const account = res.account ?? res;
  a.daily = account.dailyTotal;
  a.planIds = account.plans.filter((p: J) => p.status === 'active').map((p: J) => p.id);
  return account;
}

async function applyLoan(
  name: string,
  idx: number,
  principalGhs: number,
  months: 3 | 6 | 12,
  extra: J = {},
): Promise<string> {
  const { loan } = await api(staff.teller!, 'POST', '/loans/applications', {
    customerId: custs[idx]!.id,
    principal: GHS(principalGhs),
    durationMonths: months,
    signatureUrl: `${IMG}/sample.jpg`,
    ...(idx % 2 === 0
      ? { guarantorId: custs[idx + 1]!.id }
      : {
          guarantor: {
            fullName: NAMES[(idx + 11) % NAMES.length],
            phone: `0209002${String(100 + idx)}`,
          },
        }),
    ...extra,
  });
  loans[name] = loan.id;
  return loan.id;
}

async function approveLoan(name: string): Promise<void> {
  await api(staff.manager!, 'POST', `/loans/${loans[name]!}/approve`, {});
}

/** The next instalment, or whatever is left if that is less. */
async function repayInstalment(name: string, channel = 'cash', by?: Actor): Promise<J | null> {
  const id = loans[name]!;
  const doc = await LoanModel.findById(id);
  if (!doc) throw new Error(`loan ${name} missing`);
  const left = doc.totalDue - doc.totalRepaid;
  if (left <= 0) return null;
  const amount = Math.min(left, Math.ceil(doc.totalDue / doc.durationMonths));
  return api(by ?? staff.teller!, 'POST', `/loans/${id}/repayments`, {
    amount,
    idempotencyKey: key(),
    channel,
  });
}

async function repayAll(name: string): Promise<void> {
  const doc = await LoanModel.findById(loans[name]);
  if (!doc) throw new Error(`loan ${name} missing`);
  const left = doc.totalDue - doc.totalRepaid;
  if (left > 0) {
    await api(staff.teller!, 'POST', `/loans/${doc._id.toHexString()}/repayments`, {
      amount: left,
      idempotencyKey: key(),
      channel: 'cash',
    });
  }
}

async function createAgreement(
  name: string,
  idx: number,
  item: string,
  months: number,
  agreedGhs: number,
  by: Actor,
): Promise<J> {
  const { agreement } = await api(by, 'POST', '/hire-purchase/agreements', {
    customerId: custs[idx]!.id,
    itemId: items[item],
    durationMonths: months,
    agreedPrice: GHS(agreedGhs),
    signatureUrl: `${IMG}/sample.jpg`,
  });
  agreements[name] = agreement.id;
  return agreement;
}

async function hpDeposit(name: string, required: number): Promise<void> {
  await api(staff.teller!, 'POST', `/hire-purchase/agreements/${agreements[name]!}/deposit`, {
    amount: required,
    idempotencyKey: key(),
    channel: 'cash',
  });
}

async function hpPay(name: string, amount?: number): Promise<void> {
  const doc = await HpAgreementModel.findById(agreements[name]);
  if (!doc) throw new Error(`agreement ${name} missing`);
  const left = (doc.totalPayable ?? 0) - (doc.totalPaid - doc.depositRequired);
  const pay = Math.min(amount ?? left, left);
  if (pay > 0) {
    await api(
      staff.teller!,
      'POST',
      `/hire-purchase/agreements/${doc._id.toHexString()}/payments`,
      {
        amount: pay,
        idempotencyKey: key(),
        channel: 'cash',
      },
    );
  }
}

async function addExpense(
  by: Actor,
  category: string,
  description: string,
  amountGhs: number,
  daysAgo: number,
  payee: string,
): Promise<string> {
  const { expense } = await api(by, 'POST', '/expenses', {
    category,
    description,
    amount: GHS(amountGhs),
    payee,
    incurredOn: dayStr(daysAgo),
  });
  return expense.id;
}

async function paidExpense(
  category: string,
  description: string,
  amountGhs: number,
  daysAgo: number,
  payee: string,
): Promise<void> {
  const id = await addExpense(staff.manager!, category, description, amountGhs, daysAgo, payee);
  await api(staff.admin!, 'POST', `/expenses/${id}/approve`, {});
  await api(staff.admin!, 'POST', `/expenses/${id}/pay`, {
    cashAccountId: cash.main,
    paidOn: dayStr(daysAgo),
  });
}

// -------------------------------------------------------------- the calendar

const calendar = new Map<number, (() => Promise<void>)[]>();
function on(daysAgo: number, step: () => Promise<void>): void {
  calendar.set(daysAgo, [...(calendar.get(daysAgo) ?? []), step]);
}

function planCalendar(): void {
  // ---- the branch opens
  on(240, async () => {
    const a = staff.admin!;
    await addStaff('Efua Manu', 'manager', '0209000001', 'manager');
    await addStaff('Gifty Tawiah', 'teller', '0209000002', 'teller');
    await addStaff('Kwame Adjei', 'collector1', '0209000003', 'collector');
    await addStaff('Abena Osei', 'collector2', '0209000004', 'collector');
    await addStaff('Yaw Nkansah', 'collector3', '0209000005', 'collector');
    await addStaff('Isaac Former', 'former.staff', '0209000006', 'collector');

    const open = async (name: string, kind: string, channel: string, opening: number) =>
      (
        await api(a, 'POST', '/accounting/cash-accounts', {
          name,
          kind,
          channel,
          openingBalance: opening,
          openingDate: dayStr(241),
        })
      ).account?.id;
    cash.main = await open('Main Office Cash', 'cash-on-hand', 'cash', 0);
    cash.momo = await open('MoMo Merchant Wallet', 'momo', 'momo', 0);
    cash.paystack = await open('Paystack Settlement', 'paystack', 'paystack', 0);

    for (const [amount, account, note] of [
      [GHS(350_000), cash.main, 'Founders start-up capital'],
      [GHS(20_000), cash.momo, 'Float for the merchant wallet'],
    ] as const) {
      await api(a, 'POST', '/accounting/capital', {
        kind: 'contribution',
        amount,
        occurredOn: dayStr(240),
        cashAccountId: account,
        note,
      });
    }
    for (const [name, category, cost, life, serial] of [
      ['Collection motorbike', 'motorbike-vehicle', 18_000, 60, 'MB-7781'],
      ['Office laptop', 'computer-equipment', 6_500, 36, 'LT-1102'],
      ['Counter and shelving', 'furniture-fittings', 4_000, 60, 'FF-0041'],
      ['Old printer', 'computer-equipment', 1_200, 24, 'PR-0007'],
    ] as const) {
      const { asset } = await api(a, 'POST', '/accounting/fixed-assets', {
        name,
        category,
        cost: GHS(cost),
        acquiredOn: dayStr(240),
        usefulLifeMonths: life,
        salvageValue: GHS(cost * 0.1),
        cashAccountId: cash.main,
        serialNumber: serial,
      });
      if (name === 'Old printer') items.oldPrinterAsset = asset.id;
    }

    await api(a, 'PUT', '/hire-purchase/config', { interestRatePercent: 10 });
    const brand: J = {};
    const category: J = {};
    for (const n of ['Samsung', 'Hisense', 'TCL', 'Binatone']) {
      brand[n] = (await api(a, 'POST', '/hire-purchase/brands', { name: n })).label.id;
    }
    for (const n of ['Phones', 'Televisions', 'Refrigeration', 'Kitchen']) {
      category[n] = (await api(a, 'POST', '/hire-purchase/categories', { name: n })).label.id;
    }
    for (const [ref, name, b, c, stock, cost, sell] of [
      ['phone', 'Samsung Galaxy A15', 'Samsung', 'Phones', 25, 1_400, 1_800],
      ['phone2', 'Samsung Galaxy A05', 'Samsung', 'Phones', 18, 950, 1_250],
      ['tv', 'Hisense 43in Smart TV', 'Hisense', 'Televisions', 15, 2_600, 3_300],
      ['tv2', 'TCL 32in LED TV', 'TCL', 'Televisions', 12, 1_500, 1_950],
      ['fridge', 'Hisense 200L Fridge', 'Hisense', 'Refrigeration', 10, 3_400, 4_300],
      ['freezer', 'TCL 150L Chest Freezer', 'TCL', 'Refrigeration', 8, 2_900, 3_600],
      ['blender', 'Binatone Blender', 'Binatone', 'Kitchen', 30, 220, 320],
      ['cooker', 'Binatone Table Top Cooker', 'Binatone', 'Kitchen', 20, 380, 520],
      ['iron', 'Binatone Dry Iron', 'Binatone', 'Kitchen', 3, 90, 140],
      ['oldtv', 'Discontinued 24in TV', 'TCL', 'Televisions', 2, 700, 900],
    ] as const) {
      const { item } = await api(a, 'POST', '/hire-purchase/items', {
        name,
        brandId: brand[b],
        categoryId: category[c],
        description: `${name} — one year warranty`,
        imageUrl: `${IMG}/sample.jpg`,
        quantityInStock: stock,
        costPrice: GHS(cost),
        sellingPrice: GHS(sell),
        condition: 'new',
      });
      items[ref] = item.id;
    }
  });

  // ---- customers and accounts
  on(238, async () => {
    const col = collectors();
    for (let i = 0; i < 30; i++) await addCustomer(i, staff.manager!, col[i % 3]!);
    for (let i = 30; i < 38; i++) await addCustomer(i, staff.teller!, null);
    await addCustomer(38, staff.teller!, col[0]!, { docs: false });
    await addCustomer(39, staff.teller!, null);
    await addCustomer(40, staff.teller!, null);
    await addCustomer(44, staff.teller!, null); // registered, nothing opened yet
    // Children: one sharing the parent's number, one on their own.
    await addCustomer(41, staff.teller!, null, {
      dob: '2016-03-12',
      phone: custs[30]!.phone,
      docs: false,
    });
    await addCustomer(42, staff.teller!, null, { dob: '2019-08-02', docs: false });
    await addCustomer(43, staff.teller!, null, { dob: '2012-11-20', docs: false });
  });

  on(236, async () => {
    for (let i = 0; i < 24; i++) await openSusu(i, DAILY[i % DAILY.length]!);
    for (let i = 30; i < 34; i++) await openSusu(i, DAILY[i % DAILY.length]!);
    for (let i = 10; i < 28; i++) {
      await openSavings(i, GHS(100 + i * 10), i % 4 === 0 ? 'student' : 'standard');
    }
    for (let i = 34; i < 38; i++) await openSavings(i, GHS(300 + i));
    await openSavings(38, GHS(80));
    // No money to sweep: recovery cannot rescue these two, so they stay in arrears.
    await openSavings(28, GHS(30));
    await openSavings(29, GHS(30));
    await openSavings(39, GHS(60));
    await openSavings(43, GHS(40), 'student');
    // Fixed deposits a parent holds for a child: one matured, one still running.
    const fixed = async (idx: number, guardian: number, months: number, amount: number) => {
      const res = await api(staff.manager!, 'POST', '/savings/accounts', {
        customerId: custs[idx]!.id,
        accountType: 'fixed',
        guardianId: custs[guardian]!.id,
        termMonths: months,
        initialDeposit: amount,
        idempotencyKey: key(),
      });
      savings.set(idx, (res.account ?? res).id);
    };
    await fixed(41, 30, 6, GHS(500));
    await fixed(42, 31, 24, GHS(1_000));
  });

  // ---- plans over time: a second plan, one stopped, one changed between cycles
  on(150, async () => {
    for (const i of [0, 1, 4, 5]) {
      const a = susu.get(i)!;
      await api(staff.teller!, 'POST', `/susu/accounts/${a.id}/plans`, { dailyAmount: GHS(10) });
      await refreshPlans(a);
    }
  });
  on(90, async () => {
    const a = susu.get(4)!;
    const account = await refreshPlans(a);
    const second = account.plans.filter((p: J) => p.status === 'active').at(-1);
    await api(staff.manager!, 'POST', `/susu/accounts/${a.id}/plans/${String(second.id)}/stop`, {});
    await refreshPlans(a);
  });
  on(40, async () => {
    const a = susu.get(10)!;
    const account = await refreshPlans(a);
    const changeable = account.plans.find((p: J) => p.amountChangeable);
    if (changeable) {
      await api(staff.manager!, 'PATCH', `/susu/accounts/${a.id}/plans/${String(changeable.id)}`, {
        dailyAmount: changeable.dailyAmount + GHS(5),
      });
      await refreshPlans(a);
    } else {
      skipped.set('plan change: no plan between cycles that day', 1);
    }
  });

  // ---- susu money out
  const partial = async (idx: number, share: number) => {
    const account = await refreshPlans(susu.get(idx)!);
    const amount = Math.floor((account.availableToWithdraw * share) / 100) * 100;
    if (amount > 0) {
      await attempt(staff.teller!, 'POST', `/susu/accounts/${String(account.id)}/withdraw`, {
        amount,
        idempotencyKey: key(),
      }, 'susu partial withdrawal'); // prettier-ignore
    }
  };
  on(170, () => partial(1, 0.5));
  on(120, () => partial(5, 0.4));
  on(45, async () => {
    const a = susu.get(13)!;
    await refreshPlans(a);
    await attempt(staff.teller!, 'POST', `/susu/accounts/${a.id}/withdraw`, {
      amount: GHS(50),
      idempotencyKey: key(),
      collectedBy: { name: 'Adwoa Sarpong', phone: '0209003001' },
    }, 'susu collected by proxy'); // prettier-ignore
  });
  on(60, async () => {
    const a = susu.get(2)!;
    await api(staff.teller!, 'POST', `/susu/accounts/${a.id}/withdraw-all`, {
      idempotencyKey: key(),
    });
    await refreshPlans(a);
  });
  on(35, async () => {
    const a = susu.get(3)!;
    await api(staff.teller!, 'POST', `/susu/accounts/${a.id}/close`, {});
    a.onRound = false;
  });

  // ---- savings money out, one closed account, one mature fixed deposit paid
  on(30, async () => {
    const id = savings.get(39)!;
    await api(staff.teller!, 'POST', `/savings/accounts/${id}/close`, {});
    await api(staff.manager!, 'POST', `/customers/${custs[39]!.id}/deactivate`, {});
  });
  on(12, async () => {
    await attempt(staff.teller!, 'POST', `/savings/accounts/${savings.get(41)!}/withdrawals`, {
      amount: GHS(100),
      idempotencyKey: key(),
    }, 'fixed deposit payout'); // prettier-ignore
  });

  // ---- loan: small, repaid on time, which unlocks the big tier
  on(232, async () => {
    await applyLoan('onTime', 16, 5_000, 3);
    await approveLoan('onTime');
  });
  on(202, async () => void (await repayInstalment('onTime')));
  on(172, async () => void (await repayInstalment('onTime', 'momo')));
  on(150, () => repayAll('onTime'));
  on(75, async () => {
    await applyLoan('bigActive', 16, 25_000, 6);
    await approveLoan('bigActive');
  });
  on(45, async () => void (await repayInstalment('bigActive')));
  on(15, async () => void (await repayInstalment('bigActive')));

  // ---- loan: running normally, with a mistaken repayment trashed and a correction
  on(110, async () => {
    await applyLoan('onTrack', 17, 8_000, 6);
    await approveLoan('onTrack');
  });
  on(80, async () => void (await repayInstalment('onTrack', 'cash', staff.manager)));
  on(50, async () => void (await repayInstalment('onTrack', 'momo')));
  on(49, async () => {
    const res = await repayInstalment('onTrack');
    const id = res?.repayment?.id ?? (await latestRepayment(loans.onTrack!));
    await api(staff.manager!, 'DELETE', `/loans/${loans.onTrack!}/repayments/${String(id)}`, {
      reason: 'Entered against the wrong loan',
    });
  });
  on(20, async () => {
    await repayInstalment('onTrack');
    const id = await latestRepayment(loans.onTrack!);
    const rep = await RepaymentModel.findById(id);
    await api(staff.teller!, 'POST', `/loans/${loans.onTrack!}/repayments/${id}/corrections`, {
      amount: (rep?.amount ?? 0) - GHS(10),
      reason: 'Customer paid GHS 10 less than was typed',
    });
  });

  // ---- loan: never kept up, escalates until frozen in arrears
  on(235, async () => {
    await applyLoan('arrears', 28, 5_000, 3);
    await approveLoan('arrears');
  });
  on(205, async () => void (await repayInstalment('arrears')));

  // ---- loan: fee and collateral, repaid, collateral handed back
  on(150, async () => {
    await applyLoan('collateral', 20, 6_000, 3, {
      processingFee: GHS(100),
      collateralAmount: GHS(600),
    });
    await approveLoan('collateral');
  });
  on(120, async () => void (await repayInstalment('collateral')));
  on(95, () => repayAll('collateral'));
  on(90, async () => {
    await api(staff.manager!, 'POST', `/loans/${loans.collateral!}/collateral/return`, {});
  });

  // ---- loan: paid from the customer's other accounts
  on(130, async () => {
    await applyLoan('fromSusu', 21, 12_000, 12);
    await approveLoan('fromSusu');
  });
  on(100, async () => {
    await api(staff.teller!, 'POST', `/loans/${loans.fromSusu!}/repayments/susu`, {
      susuAccountId: susu.get(21)!.id,
      amount: GHS(150),
      idempotencyKey: key(),
    });
  });
  on(30, async () => {
    await api(staff.manager!, 'POST', '/transfers', {
      from: { type: 'savings', accountId: savings.get(21) },
      to: { type: 'loan', loanId: loans.fromSusu },
      amount: GHS(50),
      idempotencyKey: key(),
    });
  });

  // ---- loans: refused, waiting, and put in the trash
  on(60, async () => {
    await applyLoan('rejected', 19, 4_000, 3);
    await api(staff.manager!, 'POST', `/loans/${loans.rejected!}/reject`, {
      reason: 'Saving history too short for this amount',
    });
  });
  on(2, () => applyLoan('pending', 19, 2_500, 3).then(() => undefined));
  on(1, () => applyLoan('pending2', 23, 3_500, 6).then(() => undefined));
  on(40, async () => {
    await applyLoan('trashed', 24, 1_500, 3);
    await api(staff.manager!, 'DELETE', `/loans/${loans.trashed!}`, {
      reason: 'Application entered twice',
    });
  });

  // ---- loans brought over from paper
  on(28, async () => {
    const paper = async (idx: number, principal: number, repayments: J[]) => {
      const res = await api(staff.manager!, 'POST', '/loans/paper', {
        customerId: custs[idx]!.id,
        principal: GHS(principal),
        durationMonths: 12,
        ratePercent: 30,
        disbursedOn: dayStr(200),
        guarantors: [{ fullName: NAMES[idx + 3], phone: `0209004${String(100 + idx)}` }],
        repayments,
        paperRef: `PAPER-${String(idx)}`,
      });
      return res.loan.id;
    };
    loans.paper = await paper(24, 2_000, [
      { paidOn: dayStr(170), amount: GHS(300) },
      { paidOn: dayStr(140), amount: GHS(300) },
    ]);
  });

  // ---- hire purchase, one agreement in each state
  on(120, async () => {
    const e = await createAgreement('forfeit', 12, 'phone2', 1, 1_250, staff.manager!);
    await hpDeposit('forfeit', e.depositRequired);
  });
  on(115, async () => {
    const f = await createAgreement('redeem', 13, 'cooker', 1, 520, staff.manager!);
    await hpDeposit('redeem', f.depositRequired);
  });
  on(40, async () => {
    const d = await createAgreement('repossessed', 9, 'blender', 3, 320, staff.manager!);
    await hpDeposit('repossessed', d.depositRequired);
  });
  on(100, async () => {
    await api(
      staff.manager!,
      'POST',
      `/hire-purchase/agreements/${agreements.forfeit!}/repossess`,
      {
        reason: 'Nothing paid after the deposit',
      },
    );
  });
  on(70, async () => {
    const c = await createAgreement('arrears', 29, 'tv2', 1, 1_950, staff.manager!);
    await hpDeposit('arrears', c.depositRequired);
  });
  on(65, async () => {
    const a = await createAgreement('completed', 6, 'phone', 2, 1_800, staff.manager!);
    await hpDeposit('completed', a.depositRequired);
  });
  on(60, async () => {
    const g = await createAgreement('rejected', 7, 'tv', 6, 3_300, staff.teller!);
    await api(staff.manager!, 'POST', `/hire-purchase/agreements/${String(g.id)}/reject`, {
      reason: 'Customer asked to wait until after harvest',
    });
  });
  on(50, async () => {
    const b = await createAgreement('active', 14, 'fridge', 6, 4_100, staff.manager!);
    await hpDeposit('active', b.depositRequired);
  });
  on(95, async () => {
    await api(staff.manager!, 'POST', `/hire-purchase/agreements/${agreements.redeem!}/repossess`, {
      reason: 'Customer asked us to hold it while travelling',
    });
  });
  on(75, async () => {
    await api(staff.teller!, 'POST', `/hire-purchase/agreements/${agreements.redeem!}/redeem`, {
      idempotencyKey: key(),
      channel: 'cash',
    });
  });
  on(35, () => hpPay('completed', GHS(600)));
  on(65, async () => {
    await api(staff.manager!, 'POST', `/hire-purchase/agreements/${agreements.forfeit!}/forfeit`, {
      restock: { costPrice: GHS(600), sellingPrice: GHS(850), name: 'Used Galaxy A05' },
    });
  });
  on(25, async () => {
    await api(staff.manager!, 'POST', `/hire-purchase/agreements/${agreements.repossessed!}/repossess`, {
      reason: 'Customer stopped answering calls',
    }); // prettier-ignore
  });
  on(20, async () => {
    await hpPay('active', GHS(350));
    await attempt(staff.manager!, 'POST', '/transfers', {
      from: { type: 'savings', accountId: savings.get(14) },
      to: { type: 'hire-purchase', agreementId: agreements.active },
      amount: GHS(20),
      idempotencyKey: key(),
    }, 'transfer savings to HP'); // prettier-ignore
  });
  on(10, () => hpPay('completed'));
  on(3, async () => {
    await createAgreement('pending', 26, 'freezer', 6, 3_600, staff.manager!);
  });
  on(1, async () => {
    await createAgreement('awaiting', 15, 'tv', 6, 3_200, staff.teller!);
  });

  // ---- inventory
  on(150, async () => {
    await api(staff.manager!, 'POST', `/hire-purchase/items/${items.tv!}/receive`, {
      quantity: 6,
      unitCost: GHS(2_700),
      sellingPrice: GHS(3_400),
      supplier: 'Melcom Wholesale',
      invoiceRef: 'INV-2041',
      receivedOn: dayStr(150),
    });
    await api(staff.manager!, 'POST', `/hire-purchase/items/${items.blender!}/adjust-stock`, {
      delta: -1,
      reason: 'Count at stock-take came up one short',
    });
  });
  on(100, async () => {
    const report = async (by: Actor, item: string, cause: string, text: string, qty = 1) =>
      (
        await api(by, 'POST', '/hire-purchase/damages', {
          itemId: items[item],
          quantity: qty,
          cause,
          description: text,
          occurredOn: dayStr(100),
          photoUrls: [`${IMG}/sample.jpg`],
        })
      ).damage.id;
    const approved = await report(staff.teller!, 'tv2', 'delivery', 'Screen cracked on arrival');
    await api(staff.manager!, 'POST', `/hire-purchase/damages/${String(approved)}/approve`, {});
    const rejected = await report(staff.teller!, 'cooker', 'in-shop', 'Scratched, still sells');
    await api(staff.manager!, 'POST', `/hire-purchase/damages/${String(rejected)}/reject`, {
      reason: 'Cosmetic only — sell it as it is',
    });
  });
  on(4, async () => {
    await api(staff.teller!, 'POST', '/hire-purchase/damages', {
      itemId: items.iron,
      quantity: 1,
      cause: 'defective',
      description: 'Will not heat up',
      occurredOn: dayStr(4),
    });
  });
  on(55, async () => {
    await api(staff.manager!, 'PATCH', `/hire-purchase/items/${items.oldtv!}`, {
      status: 'discontinued',
    });
  });
  on(54, async () => {
    const { item } = await api(staff.manager!, 'POST', '/hire-purchase/items', {
      name: 'Item keyed by mistake',
      quantityInStock: 0,
      costPrice: GHS(10),
      sellingPrice: GHS(12),
    });
    await api(staff.manager!, 'DELETE', `/hire-purchase/items/${String(item.id)}`, {
      reason: 'Keyed by mistake',
    });
  });

  // ---- counter sales
  const sale = async (buyer: J, lines: J[]) =>
    (
      await api(staff.teller!, 'POST', '/hire-purchase/sales', {
        ...buyer,
        lines,
        idempotencyKey: key(),
        channel: 'cash',
      })
    ).sale;
  on(140, async () => {
    await sale({ buyerName: 'Walk-in Buyer', buyerPhone: '0209005001' }, [
      { itemId: items.blender, quantity: 2 },
    ]);
  });
  on(95, async () => {
    await sale({ customerId: custs[30]!.id }, [
      { itemId: items.cooker, quantity: 1 },
      { itemId: items.iron, quantity: 1 },
    ]);
  });
  on(33, async () => {
    const voided = await sale({ buyerName: 'Returned Goods' }, [{ itemId: items.phone, quantity: 1 }]);
    await api(staff.manager!, 'POST', `/hire-purchase/sales/${String(voided.id)}/void`, {
      reason: 'Buyer returned it the same day',
    });
  }); // prettier-ignore
  on(6, async () => {
    await sale({ customerId: custs[31]!.id }, [{ itemId: items.phone2, quantity: 1, unitPrice: GHS(1_200) }]);
  }); // prettier-ignore

  // ---- running costs: every month paid, recent ones in each state
  for (let d = 235; d > 15; d -= 30) {
    on(d, () => paidExpense('salaries-staff', `Staff salaries, ${dayStr(d).slice(0, 7)}`, 4_200, d, 'Staff payroll'));
    on(d, () => paidExpense('utilities-premises', `Rent and power, ${dayStr(d).slice(0, 7)}`, 950, d, 'ECG and landlord'));
    on(d, () => paidExpense('fees-transport-other', `Collector fuel, ${dayStr(d).slice(0, 7)}`, 380, d, 'Star Oil'));
  } // prettier-ignore
  on(200, () =>
    paidExpense(
      'professional-compliance-tax',
      'Business registration renewal',
      700,
      200,
      'Registrar General',
    ),
  );
  on(140, () => paidExpense('insurance', 'Motorbike insurance', 620, 140, 'SIC Insurance'));
  on(85, () => paidExpense('marketing', 'Radio announcement', 450, 85, 'Skyy Power FM'));
  on(14, async () => {
    const id = await addExpense(staff.manager!, 'petty-cash-office', 'Printer paper and pens', 180, 14, 'Stationery Plus');
    await api(staff.manager!, 'POST', `/expenses/${id}/receipt`, { receiptUrl: `${IMG}/sample.jpg` });
    await api(staff.admin!, 'POST', `/expenses/${id}/approve`, {});
  }); // prettier-ignore
  on(9, async () => {
    const id = await addExpense(staff.teller!, 'petty-cash-office', 'Team lunch', 400, 9, 'Local chop bar');
    await api(staff.admin!, 'POST', `/expenses/${id}/reject`, { reason: 'Not a business expense' });
  }); // prettier-ignore
  on(7, async () => {
    const id = await addExpense(staff.teller!, 'marketing', 'Duplicate flyer invoice', 120, 7, 'Print Hub');
    await api(staff.manager!, 'DELETE', `/expenses/${id}`, { reason: 'Same invoice entered twice' });
  }); // prettier-ignore
  on(2, async () => {
    await addExpense(staff.teller!, 'fees-transport-other', 'Motorbike tyre', 260, 2, 'Takoradi Spares');
  }); // prettier-ignore

  // ---- accounting
  on(45, async () => {
    await api(staff.admin!, 'POST', '/accounting/capital', {
      kind: 'drawing',
      amount: GHS(3_000),
      occurredOn: dayStr(45),
      cashAccountId: cash.main,
      note: 'Owner drawing',
    });
    await api(staff.admin!, 'POST', `/accounting/fixed-assets/${items.oldPrinterAsset!}/dispose`, {
      disposedOn: dayStr(45),
      disposalProceeds: GHS(150),
      cashAccountId: cash.main,
      note: 'Sold for parts',
    });
  });
  on(20, async () => {
    const summary = await api(staff.manager!, 'GET', '/commissions/summary');
    const amount = Math.floor((summary.balance ?? 0) / 200) * 100;
    if (amount > 0) {
      const { move } = await api(staff.manager!, 'POST', '/commissions/moves', {
        amount,
        cashAccountId: cash.main,
        note: 'Monthly sweep of commission',
        idempotencyKey: key(),
      });
      void move;
    }
  });
  on(11, async () => {
    const summary = await api(staff.manager!, 'GET', '/commissions/summary');
    if ((summary.balance ?? 0) >= GHS(20)) {
      const { move } = await api(staff.manager!, 'POST', '/commissions/moves', {
        amount: GHS(10),
        cashAccountId: cash.main,
        note: 'Moved by mistake',
        idempotencyKey: key(),
      });
      await api(staff.manager!, 'POST', `/commissions/moves/${String(move.id)}/trash`, {
        reason: 'Wrong amount',
      });
    }
  });

  // ---- transfers between a customer's own accounts
  on(55, async () => {
    await attempt(staff.manager!, 'POST', '/transfers', {
      from: { type: 'susu', accountId: susu.get(14)!.id },
      to: { type: 'savings', accountId: savings.get(14) },
      amount: GHS(40),
      idempotencyKey: key(),
    }, 'transfer susu to savings'); // prettier-ignore
  });
  on(25, async () => {
    await attempt(staff.manager!, 'POST', '/transfers', {
      from: { type: 'savings', accountId: savings.get(15) },
      to: { type: 'susu', accountId: susu.get(15)!.id },
      amount: GHS(30),
      idempotencyKey: key(),
    }, 'transfer savings to susu'); // prettier-ignore
  });

  // ---- staff and customer housekeeping
  on(50, async () => {
    await api(staff.admin!, 'PATCH', `/customers/${custs[27]!.id}/collector`, {
      collectorId: collectors()[1]!.id,
      reason: 'Moved house, now on the Axim Road round',
    });
    custs[27]!.collector = collectors()[1]!;
  });
  on(48, async () => {
    await api(staff.admin!, 'POST', `/users/${staff['former.staff']!.id}/disable`, {});
  });
  on(47, async () => {
    await api(staff.manager!, 'DELETE', `/customers/${custs[40]!.id}`, {
      reason: 'Registered twice under different spellings',
    });
  });
  on(5, async () => {
    await api(staff.admin!, 'POST', '/notifications/read-all', {});
  });

  // ---- teller's mistakes: corrections through each outcome, and the trash
  const propose = async (idx: number, reason: string): Promise<string> => {
    const a = susu.get(idx)!;
    const depositId = lastDeposit.get(idx)!;
    const { correction } = await api(
      staff.teller!,
      'POST',
      `/susu/accounts/${a.id}/deposits/${depositId}/corrections`,
      { amount: a.daily * 2, reason },
    );
    return correction.id;
  };
  on(33, async () => {
    const id = await propose(30, 'Customer also paid for yesterday');
    await api(staff.manager!, 'POST', `/corrections/${id}/approve`, {});
  });
  on(22, async () => {
    const id = await propose(31, 'Amount looks short by one payment');
    await api(staff.manager!, 'POST', `/corrections/${id}/reject`, {
      reason: 'The sheet shows one payment only',
    });
  });
  on(13, async () => {
    const id = await propose(32, 'Typed against the wrong customer');
    await api(staff.teller!, 'POST', `/corrections/${id}/cancel`, {});
  });
  on(1, async () => void (await propose(33, 'Customer says two payments were handed over')));
  on(17, async () => {
    const id = savings.get(34)!;
    const { txn } = await api(staff.teller!, 'POST', `/savings/accounts/${id}/deposits`, {
      amount: GHS(40),
      idempotencyKey: key(),
      channel: 'cash',
    });
    const { correction } = await api(
      staff.teller!,
      'POST',
      `/savings/accounts/${id}/transactions/${String(txn.id)}/corrections`,
      { amount: GHS(45), reason: 'Passbook shows GHS 45' },
    );
    await api(staff.manager!, 'POST', `/corrections/${String(correction.id)}/approve`, {});
  });
  on(15, async () => {
    // Trashed, then brought back: the balance must come out unchanged.
    const a = susu.get(31)!;
    await api(staff.manager!, 'DELETE', `/susu/accounts/${a.id}/deposits/${lastDeposit.get(31)!}`, {
      reason: 'Checking against the paper sheet',
    });
    await api(staff.manager!, 'POST', `/susu/accounts/${a.id}/deposits/${lastDeposit.get(31)!}/restore`, {});
  }); // prettier-ignore
  on(5, async () => {
    const a = susu.get(32)!;
    await api(staff.manager!, 'DELETE', `/susu/accounts/${a.id}/deposits/${lastDeposit.get(32)!}`, {
      reason: 'Customer was not in that day',
    });
  });
  on(6, async () => {
    const id = savings.get(35)!;
    const { txn } = await api(staff.teller!, 'POST', `/savings/accounts/${id}/deposits`, {
      amount: GHS(25),
      idempotencyKey: key(),
      channel: 'cash',
    });
    await api(staff.manager!, 'DELETE', `/savings/accounts/${id}/transactions/${String(txn.id)}`, {
      reason: 'Entered on the wrong account',
    });
  });
  on(8, async () => {
    const res = await api(staff.teller!, 'POST', '/savings/accounts', { customerId: custs[44]!.id });
    await api(staff.manager!, 'DELETE', `/savings/accounts/${String((res.account ?? res).id)}`, {
      reason: 'Opened by mistake',
    });
  }); // prettier-ignore

  // ---- things only an outside party completes
  on(3, async () => {
    const charge = (over: J) =>
      PaystackChargeModel.create({
        reference: `yadah-seed-${randomUUID()}`,
        kind: 'savings-deposit',
        targetId: new Types.ObjectId(savings.get(36)),
        customerId: custs[36]!.id,
        amount: GHS(50),
        phone: custs[36]!.phone,
        provider: 'mtn',
        email: `customer36@example.com`,
        initiatedById: staff.teller!.id,
        initiatedByRole: 'teller',
        ...over,
      });
    await charge({
      status: 'failed',
      executionStatus: 'failed',
      paystackStatus: 'failed',
      failureReason: 'Customer did not approve the prompt',
    });
    await charge({ status: 'pending', paystackStatus: 'pay_offline', displayText: 'Approve on your phone' });
  }); // prettier-ignore
  on(4, async () => {
    const refused = await submitRequest(custs[35]!.id, {
      kind: 'savings-withdrawal',
      targetId: new Types.ObjectId(savings.get(35)),
      amount: GHS(40),
      payoutProvider: 'mtn',
    } as never);
    await rejectRequest(
      { sub: staff.manager!.id, role: 'manager' } as never,
      new Types.ObjectId(refused.id),
      'Please come to the office with your ID',
    );
  });
  on(1, async () => {
    await submitRequest(custs[36]!.id, {
      kind: 'savings-withdrawal',
      targetId: new Types.ObjectId(savings.get(36)),
      amount: GHS(60),
      payoutProvider: 'vod',
    } as never);
    await submitRequest(custs[17]!.id, {
      kind: 'susu-partial-withdrawal',
      targetId: new Types.ObjectId(susu.get(17)!.id),
      amount: GHS(20),
      payoutProvider: 'mtn',
    } as never);
  });
}

async function latestRepayment(loanId: string): Promise<string> {
  const rep = await RepaymentModel.findOne({ loanId, deletedAt: null }).sort({ createdAt: -1 });
  if (!rep) throw new Error('no repayment found');
  return rep._id.toHexString();
}

// -------------------------------------------------------------- the daily routine

/** Runs steps a few at a time; customers on a round do not touch each other's records. */
async function inParallel<T>(
  list: T[],
  step: (item: T) => Promise<void>,
  width = 8,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < list.length) await step(list[next++] as T);
    }),
  );
}

async function collectionRound(): Promise<void> {
  await inParallel([...susu.values()], async (a) => {
    if (!a.onRound || a.daily <= 0) return;
    // Everyone misses the odd day and some catch up with two payments later.
    if (chance(0.1)) return;
    const catchUp = a.planIds.length === 1 && chance(0.05);
    const by = a.cust.collector ?? staff.teller!;
    const body: J = {
      amount: catchUp ? a.daily * 2 : a.daily,
      idempotencyKey: key(),
      channel: 'cash',
      ...(catchUp ? { split: [{ planId: a.planIds[0], payments: 2 }] } : {}),
    };
    const res = await api(by, 'POST', `/susu/accounts/${a.id}/deposits`, body);
    lastDeposit.set(a.cust.idx, res.deposit?.id);
  });
}

async function savingsRound(daysAgo: number): Promise<void> {
  for (const [idx, id] of savings) {
    const cust = custs[idx]!;
    if (idx === 39 && daysAgo <= 30) continue; // closed
    if (idx === 28 || idx === 29) continue; // deliberately broke
    if ((idx + daysAgo) % 7 === 0) {
      const momo = cust.collector === null && idx % 2 === 0 && chance(0.3);
      await api(momo || !cust.collector ? staff.teller! : cust.collector, 'POST', `/savings/accounts/${id}/deposits`, {
        amount: GHS(10 + (idx % 8) * 10),
        idempotencyKey: key(),
        channel: momo ? 'momo' : 'cash',
      }); // prettier-ignore
    }
    // A withdrawal about every five weeks, when there is enough to take.
    if ((idx * 3 + daysAgo) % 37 === 0 && idx !== 41 && idx !== 42) {
      const res = await api(staff.manager!, 'GET', `/savings/accounts/${id}`);
      const account = res.account ?? res;
      const amount = Math.floor(account.availableToWithdraw / 300) * 100;
      if (amount >= GHS(5)) {
        await attempt(staff.teller!, 'POST', `/savings/accounts/${id}/withdrawals`, {
          amount,
          idempotencyKey: key(),
        }, 'savings withdrawal'); // prettier-ignore
      }
    }
  }
}

async function closeTheDay(daysAgo: number): Promise<void> {
  const day = dayStr(daysAgo);
  for (const person of cashHandlers()) {
    // Today stays open on purpose, with one collector's day waiting on the office.
    if (daysAgo === 0 && person !== staff.collector1) continue;
    const { total, entries } = await api(
      staff.manager!,
      'GET',
      `/reconciliation/expected?accraDay=${day}&collectorId=${person.id}`,
    );
    if (!entries) continue;
    const short = chance(0.03) ? GHS(5) : 0;
    const { reconciliation } = await api(person, 'POST', '/reconciliation/declare', {
      accraDay: day,
      declaredAmount: total - short,
      ...(short ? { declaredNote: 'A customer owes me the difference' } : {}),
    });
    if (daysAgo <= 1) continue; // handed in, not counted yet
    const receiver = person === staff.teller ? staff.manager! : staff.teller!;
    await api(receiver, 'POST', `/reconciliation/${String(reconciliation.id)}/confirm`, {
      receivedAmount: total - short,
      ...(short ? { varianceReason: 'Short by GHS 5 — collector will make it good' } : {}),
    });
  }
}

async function nightlyWorkers(): Promise<void> {
  await runEscalationPass();
  await runHpArrearsPass();
  await runDebtRecoveryPass();
}

// -------------------------------------------------------------- verification

const problems: string[] = [];
const passed: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed.push(name);
  else problems.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

async function verifyLedgers(): Promise<void> {
  let bad = 0;
  for (const a of await SavingsAccountModel.find({})) {
    const last = await SavingsTxnModel.findOne({ accountId: a._id, deletedAt: null }).sort({
      createdAt: -1,
      _id: -1,
    });
    if ((last?.balanceAfter ?? 0) !== a.balance) {
      bad++;
      problems.push(`savings ${a.accountNumber}: balance ${String(a.balance)}, ledger ${String(last?.balanceAfter)}`);
    }
  } // prettier-ignore
  check('every savings balance equals its last ledger line', bad === 0);

  bad = 0;
  const tomorrow = new Date(Date.now() + DAY_MS);
  for (const a of await SusuAccountModel.find({ status: 'active' })) {
    const replay = await susuBalanceAsOf(a._id, tomorrow);
    if (replay !== a.balance) {
      bad++;
      problems.push(`susu ${a.accountNumber}: balance ${String(a.balance)}, replayed ${String(replay)}`);
    }
  } // prettier-ignore
  check('every susu balance equals its replayed deposits and payouts', bad === 0);

  bad = 0;
  for (const loan of await LoanModel.find({ deletedAt: null, status: { $ne: 'pending' } })) {
    const reps = await RepaymentModel.find({ loanId: loan._id, deletedAt: null });
    const sum = reps.reduce((s, r) => s + r.amount, 0);
    const opening = (loan as unknown as J).openingRepaid ?? 0;
    if (sum + opening !== loan.totalRepaid) {
      bad++;
      problems.push(`loan ${loan.accountNumber}: totalRepaid ${String(loan.totalRepaid)}, repayments ${String(sum)}`);
    }
    if (loan.status === 'repaid' && loan.totalRepaid !== loan.totalDue) {
      bad++;
      problems.push(`loan ${loan.accountNumber}: marked repaid with ${String(loan.totalDue - loan.totalRepaid)} left`);
    }
    if (loan.status !== 'rejected') {
      const lines = await LoanScheduleModel.find({ loanId: loan._id });
      const due = lines.reduce((s, l) => s + l.amountDue, 0);
      if (lines.length > 0 && due !== loan.totalDue && !loan.frozen && !loan.escalatedAt) {
        bad++;
        problems.push(`loan ${loan.accountNumber}: schedule totals ${String(due)}, due ${String(loan.totalDue)}`);
      }
    }
  } // prettier-ignore
  check('every loan agrees with its repayments and schedule', bad === 0);

  bad = 0;
  for (const a of await HpAgreementModel.find({ deletedAt: null })) {
    const pays = await HpPaymentModel.find({ agreementId: a._id, deletedAt: null });
    const sum = pays.reduce((s, p) => s + p.amount, 0);
    if (sum !== a.totalPaid) {
      bad++;
      problems.push(`HP ${String(a.accountNumber)}: totalPaid ${String(a.totalPaid)}, payments ${String(sum)}`);
    }
  } // prettier-ignore
  check('every hire purchase agreement agrees with its payments', bad === 0);

  const negative = await HpItemModel.countDocuments({ quantityInStock: { $lt: 0 } });
  check('no stock level is negative', negative === 0);

  const admin = staff.admin!;
  const month = (d: number) => dayStr(d);
  for (const d of [210, 150, 90, 30, 0]) {
    const position = await api(admin, 'GET', `/accounting/cash-position?asOf=${month(d)}`);
    const lows = (position.accounts ?? []).filter((a: J) => (a.balance ?? a.closing ?? 0) < 0);
    check(`no cash account overdrawn on ${month(d)}`, lows.length === 0, JSON.stringify(lows));
    const sheet = await api(admin, 'GET', `/accounting/balance-sheet?asOf=${month(d)}`);
    if (d === 0) {
      check(
        `balance sheet balances on ${month(d)}`,
        sheet.balances === true,
        `checkDifference ${String(sheet.checkDifference)}`,
      );
    }
  }
}

async function firstId(actor: Actor, path: string): Promise<string | undefined> {
  const { status, data } = await raw(actor, 'GET', path);
  if (status !== 200) return undefined;
  return data.items?.[0]?.id;
}

interface SweepResult {
  requests: number;
  failures: string[];
}

/** Every read endpoint, with real ids, in JSON and as downloads. */
async function sweep(): Promise<SweepResult> {
  const admin = staff.admin!;
  const failures: string[] = [];
  let requests = 0;
  const hit = async (actor: Actor | null, path: string, bearer?: string): Promise<void> => {
    requests++;
    const { status, data } = await raw(actor, 'GET', path, undefined, bearer);
    if (status >= 400) {
      failures.push(`${actor?.role ?? 'customer'} GET ${path} → ${String(status)} ${String(data?.error?.code ?? '')} ${String(data?.error?.message ?? '')}`);
    }
  }; // prettier-ignore

  const today = dayStr(0);
  const from = dayStr(60);
  const range = `from=${from}&to=${today}`;
  const lists = [
    '/users', '/customers', '/customers/trash', '/susu/accounts', '/susu/accounts/trash',
    '/susu/deposits/trash', '/susu/summary', '/savings/accounts', '/savings/accounts/trash',
    '/savings/transactions/trash', '/loans', '/loans/config', '/loans/trash',
    '/loans/repayments/trash', `/reports/transactions?${range}`, '/reports/workers', '/reports/dashboard',
    `/reports/collections?${range}`, `/reports/loans/outstanding?${range}`, `/reports/loans/aging?${range}`,
    `/reports/commission?${range}`, '/dashboard/summary', '/dashboard/financials', '/dashboard/series',
    '/dashboard/staff-performance', '/dashboard/efficiency', '/dashboard/alerts',
    '/dashboard/recent-transactions', '/collectors', '/payout-requests', '/accounting/cash-accounts',
    '/accounting/cash-position', '/accounting/fixed-assets', '/accounting/capital',
    '/accounting/balance-sheet', '/accounting/profit-loss', `/accounting/profit-loss?${range}`,
    '/expenses', '/expenses/summary', '/expenses/trash', '/commissions', '/commissions/summary',
    '/commissions/moves', '/hire-purchase/sales', '/hire-purchase/items', '/hire-purchase/items/trash',
    '/hire-purchase/brands', '/hire-purchase/categories', '/hire-purchase/damages',
    '/hire-purchase/damages/summary', '/hire-purchase/damages/trash', '/hire-purchase/config',
    '/hire-purchase/agreements', '/hire-purchase/agreements/trash', '/reconciliation', '/reconciliation/variances',
    '/corrections', '/notifications', '/notifications/unread-count', '/notifications/push/config', '/audit-logs',
    `/audit-logs?${range}`, '/auth/me',
  ]; // prettier-ignore
  for (const path of lists) await hit(admin, path);

  // Downloads, the way the export buttons ask for them.
  for (const path of [
    '/users', '/customers', '/susu/accounts', '/savings/accounts', '/loans', '/expenses',
    '/hire-purchase/items', '/hire-purchase/agreements', '/hire-purchase/sales', '/hire-purchase/damages',
    '/reconciliation', '/accounting/fixed-assets', '/audit-logs',
  ]) {
    await hit(admin, `${path}?format=csv`);
    await hit(admin, `${path}?format=xlsx`);
  } // prettier-ignore
  await hit(admin, `/reports/transactions?${range}&format=csv`);
  for (const f of ['pdf', 'csv', 'xlsx']) {
    await hit(admin, `/accounting/balance-sheet?format=${f}`);
    await hit(admin, `/accounting/profit-loss?format=${f}`);
  }

  // Every customer's page.
  for (const cust of await CustomerModel.find({ deletedAt: null })) {
    const id = cust._id.toHexString();
    await hit(admin, `/customers/${id}`);
    await hit(admin, `/customers/${id}/statement`);
    await hit(admin, `/loans/eligibility/${id}`);
    await hit(admin, `/hire-purchase/eligibility/${id}`);
  }
  const sampleCustomer = await CustomerModel.findOne({ deletedAt: null, isMinor: { $ne: true } });
  await hit(admin, `/customers/${sampleCustomer!._id.toHexString()}/registration-form`);

  // Every account, with its history and a receipt for a line of it.
  for (const a of await SusuAccountModel.find({})) {
    const id = a._id.toHexString();
    await hit(admin, `/susu/accounts/${id}`);
    await hit(admin, `/susu/accounts/${id}/cycles`);
    await hit(admin, `/susu/accounts/${id}/deposits`);
    await hit(admin, `/susu/accounts/${id}/payouts`);
    await hit(admin, `/susu/accounts/${id}/deposits/trash`);
    const { data } = await raw(admin, 'GET', `/susu/accounts/${id}/deposits`);
    const dep = data.items?.[0]?.id;
    if (dep) await hit(admin, `/susu/accounts/${id}/deposits/${String(dep)}/receipt`);
    const payouts = await raw(admin, 'GET', `/susu/accounts/${id}/payouts`);
    const pay = payouts.data.items?.[0]?.id;
    if (pay) await hit(admin, `/susu/accounts/${id}/withdrawals/${String(pay)}/receipt`);
  }
  for (const a of await SavingsAccountModel.find({ deletedAt: null })) {
    const id = a._id.toHexString();
    await hit(admin, `/savings/accounts/${id}`);
    await hit(admin, `/savings/accounts/${id}/transactions/trash`);
    const { data } = await raw(admin, 'GET', `/savings/accounts/${id}/transactions`);
    const txn = data.items?.[0]?.id;
    if (txn) await hit(admin, `/savings/accounts/${id}/txns/${String(txn)}/receipt`);
  }
  for (const loan of await LoanModel.find({ deletedAt: null })) {
    const id = loan._id.toHexString();
    await hit(admin, `/loans/${id}`);
    if (loan.disbursedAt) await hit(admin, `/loans/${id}/disbursement/receipt`);
    const rep = await RepaymentModel.findOne({ loanId: loan._id, deletedAt: null });
    if (rep) await hit(admin, `/loans/${id}/repayments/${rep._id.toHexString()}/receipt`);
  }
  for (const a of await HpAgreementModel.find({ deletedAt: null })) {
    const id = a._id.toHexString();
    await hit(admin, `/hire-purchase/agreements/${id}`);
    const pay = await HpPaymentModel.findOne({ agreementId: a._id, deletedAt: null });
    if (pay) await hit(admin, `/hire-purchase/agreements/${id}/payments/${pay._id.toHexString()}/receipt`);
  } // prettier-ignore
  for (const [list, item] of [
    ['/users', '/users'], ['/expenses', '/expenses'], ['/hire-purchase/damages', '/hire-purchase/damages'],
    ['/hire-purchase/sales', '/hire-purchase/sales'], ['/reconciliation', '/reconciliation'],
    ['/payout-requests', '/payout-requests'], ['/hire-purchase/brands', '/hire-purchase/brands'],
    ['/hire-purchase/categories', '/hire-purchase/categories'],
  ] as const) {
    const id = await firstId(admin, list);
    if (id) await hit(admin, `${item}/${id}`);
    else failures.push(`${list} came back with no rows`);
  } // prettier-ignore
  const saleId = await firstId(admin, '/hire-purchase/sales');
  if (saleId) await hit(admin, `/hire-purchase/sales/${saleId}/receipt`);
  const itemId = await firstId(admin, '/hire-purchase/items');
  if (itemId) await hit(admin, `/hire-purchase/items/${itemId}/price-changes`);
  const charge = await PaystackChargeModel.findOne({});
  if (charge) await hit(admin, `/payments/charges/${charge.reference}`);

  // Each junior role sees its own world without an error.
  const manager = staff.manager!;
  const teller = staff.teller!;
  const collector = staff.collector1!;
  for (const path of ['/dashboard/summary', '/customers', '/loans', '/corrections', '/reconciliation', '/expenses', '/commissions/summary', '/accounting/balance-sheet']) {
    await hit(manager, path);
  } // prettier-ignore
  for (const path of ['/customers', '/susu/accounts', '/savings/accounts', '/loans', '/hire-purchase/items', '/hire-purchase/agreements', '/expenses', '/reconciliation']) {
    await hit(teller, path);
  } // prettier-ignore
  for (const path of ['/customers', '/susu/accounts', '/savings/accounts', '/collectors/me/round', '/collectors/me/day', '/reconciliation', '/susu/summary', '/notifications']) {
    await hit(collector, path);
  } // prettier-ignore
  await hit(admin, `/collectors`);
  await hit(admin, `/reconciliation/expected?collectorId=${collector.id}`);

  // The customer portal, logged in the way a customer logs in.
  const portalPhone = custs[17]?.phone ?? '0209000117';
  await SmsLogModel.deleteMany({ template: 'portal-login-otp', to: portalPhone });
  await PortalOtpModel.deleteMany({});
  const request = await raw(null, 'POST', '/portal/auth/otp/request', { phone: portalPhone });
  if (request.status >= 300) failures.push(`portal OTP request → ${String(request.status)}`);
  const sms = await SmsLogModel.findOne({ template: 'portal-login-otp', to: portalPhone });
  const code = /\b(\d{4})\b/.exec(sms?.message ?? '')?.[1];
  const login = await raw(null, 'POST', '/portal/auth/otp/verify', { phone: portalPhone, code });
  if (login.status >= 300) {
    failures.push(`portal login → ${String(login.status)} ${JSON.stringify(login.data)}`);
  } else {
    const bearer = login.data.tokens?.accessToken ?? login.data.accessToken;
    for (const path of ['/portal/me', '/portal/accounts', '/portal/transactions', '/portal/statement', '/portal/requests']) {
      await hit(null, path, bearer);
    } // prettier-ignore
  }
  await PortalOtpModel.deleteMany({});
  return { requests, failures };
}

async function loadStaff(): Promise<void> {
  for (const user of await UserModel.find({})) {
    staff[user.username] = { id: user._id.toHexString(), role: user.role };
  }
  if (custs.length === 0) {
    const c = await CustomerModel.findOne({ phone: '0209000117' });
    if (c) custs[17] = { idx: 17, id: c._id.toHexString(), phone: c.phone, collector: null };
  }
}

async function report(): Promise<number> {
  resetClock();
  await loadStaff();
  await verifyLedgers();
  const { requests, failures } = await sweep();
  check(`${String(requests)} read requests across all modules`, failures.length === 0);
  // Let background notifications land, then close the log so nothing queued can
  // ever go out if an SMS key is added later.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await SmsLogModel.updateMany(
    { status: 'queued' },
    { $set: { status: 'failed', lastError: 'Seed data — never sent' } },
  );

  console.log('\n=== checks ===');
  for (const line of passed) console.log(`PASS  ${line}`);
  for (const line of problems) console.log(`FAIL  ${line}`);
  if (failures.length > 0) {
    console.log(`\n=== ${String(failures.length)} failed requests ===`);
    for (const line of failures) console.log(`  ${line}`);
  }
  if (skipped.size > 0) {
    console.log('\n=== steps the business rules refused (expected, counted) ===');
    for (const [label, n] of skipped) console.log(`  ${label} × ${String(n)}`);
  }
  return problems.length + failures.length;
}

async function counts(): Promise<void> {
  console.log('\n=== documents ===');
  for (const name of Object.keys(mongoose.models).sort()) {
    const n = await mongoose.models[name]!.countDocuments({});
    console.log(`  ${name.padEnd(22)} ${String(n)}`);
  }
}

// -------------------------------------------------------------- main

logger.level = 'silent';
await connectDb();
const app = createApp();
const server: Server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => {
    resolve(s);
  });
});
base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

let exitCode = 0;
try {
  await ensureChildPhoneRule();
  if (process.argv.includes('--verify')) {
    exitCode = await report();
  } else {
    if (process.argv.includes('--reset')) await wipeAllButAdmin();
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
    const existing = await CustomerModel.countDocuments({});
    if (existing > 0) {
      throw new Error(`${String(existing)} customers already here — run with --reset to replace them`);
    } // prettier-ignore
    await ensureAdmin();
    planCalendar();
    const startedAt = realTime();
    for (let daysAgo = START_DAYS_AGO; daysAgo >= 0; daysAgo--) {
      setDay(daysAgo, 8);
      for (const step of calendar.get(daysAgo) ?? []) await step();
      if (!isSunday(daysAgo) && daysAgo <= 235) {
        setDay(daysAgo, 10);
        await collectionRound();
        await savingsRound(daysAgo);
      }
      if (daysAgo <= 235) {
        setDay(daysAgo, 18);
        await closeTheDay(daysAgo);
      }
      setDay(daysAgo, 23);
      await nightlyWorkers();
      if (daysAgo % 20 === 0) {
        console.log(`${dayStr(daysAgo)} done (${String(daysAgo)} days to go, ${String(Math.round((realTime() - startedAt) / 1000))}s)`);
      } // prettier-ignore
    }
    await counts();
    exitCode = await report();
    console.log(`\nStaff password for manager, teller, collector1-3: ${STAFF_PASSWORD}`);
    console.log('Admin login is unchanged.');
  }
} catch (err) {
  console.error('\nSEED STOPPED:', err instanceof Error ? err.message : err);
  exitCode = 1;
} finally {
  resetClock();
  await new Promise((resolve) => {
    server.close(resolve);
  });
  await disconnectDb();
}
process.exit(exitCode);

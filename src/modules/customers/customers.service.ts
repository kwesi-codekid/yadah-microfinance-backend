import { MongoServerError } from 'mongodb';
import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { createdAtFilter } from '../../lib/time.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { fuzzyCustomerIds } from '../../lib/fuzzy.js';
import {
  CustomerModel,
  HpAgreementModel,
  LoanModel,
  SavingsAccountModel,
  SusuAccountModel,
  UserModel,
  type Customer,
  type CustomerIdentification,
  type NextOfKin,
} from '../../models/index.js';
import { buildRegistrationFormPdf } from './registration-pdf.js';
import { NOT_TRASHED, requireDeletedAt } from '../../models/shared.js';
import type { Pagination } from '../../schemas/common.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import {
  PHONES_DISTINCT_MESSAGE,
  phoneClashes,
  type CreateCustomerBody,
  type ListCustomersQuery,
  type UpdateCustomerBody,
} from './customers.schemas.js';

/** Scalar profile fields copied verbatim between body, document, and audit. */
const SCALAR_FIELDS = [
  'fullName',
  'dateOfBirth',
  'gender',
  'nationality',
  'maritalStatus',
  'mothersMaidenName',
  'residentialAddress',
  'ghanaPostGps',
  'postalAddress',
  'phone',
  'altPhone',
  'email',
  'occupation',
  'employerOrBusiness',
  'purposeOfAccount',
  'photoUrl',
  'idDocumentFrontUrl',
  'idDocumentBackUrl',
] as const;
/** Embedded objects replaced wholesale when present in a patch. */
const SUBDOC_FIELDS = ['identification', 'nextOfKin'] as const;

export interface PublicCustomer {
  id: string;
  fullName: string;
  dateOfBirth?: Date;
  gender?: string;
  nationality?: string;
  maritalStatus?: string;
  mothersMaidenName?: string;
  residentialAddress?: string;
  ghanaPostGps?: string;
  postalAddress?: string;
  phone: string;
  altPhone?: string;
  email?: string;
  identification?: CustomerIdentification;
  occupation?: string;
  employerOrBusiness?: string;
  purposeOfAccount?: string;
  nextOfKin?: NextOfKin;
  photoUrl?: string;
  idDocumentFrontUrl?: string;
  idDocumentBackUrl?: string;
  registeredById: string;
  status: 'active' | 'inactive';
  createdAt: Date;
}

export function toPublicCustomer(c: Customer): PublicCustomer {
  const out: PublicCustomer = {
    id: c._id.toHexString(),
    fullName: c.fullName,
    phone: c.phone,
    registeredById: c.registeredById.toHexString(),
    status: c.status,
    createdAt: c.createdAt,
  };
  for (const key of SCALAR_FIELDS) {
    const value = c[key];
    if (value !== undefined && !(key in out)) {
      (out as unknown as Record<string, unknown>)[key] = value;
    }
  }
  if (c.identification) out.identification = c.identification;
  if (c.nextOfKin) out.nextOfKin = c.nextOfKin;
  return out;
}

/** Flat spreadsheet row for csv/xlsx listing exports — every key always present. */
export function toCustomerExportRow(item: PublicCustomer): Record<string, unknown> {
  return {
    id: item.id,
    fullName: item.fullName,
    phone: item.phone,
    altPhone: item.altPhone ?? null,
    email: item.email ?? null,
    gender: item.gender ?? null,
    dateOfBirth: item.dateOfBirth ?? null,
    nationality: item.nationality ?? null,
    residentialAddress: item.residentialAddress ?? null,
    ghanaPostGps: item.ghanaPostGps ?? null,
    occupation: item.occupation ?? null,
    idType: item.identification?.idType ?? null,
    idNumber: item.identification?.idNumber ?? null,
    nextOfKinName: item.nextOfKin?.fullName ?? null,
    nextOfKinPhone: item.nextOfKin?.phone ?? null,
    status: item.status,
    createdAt: item.createdAt,
  };
}

function throwIfDuplicate(err: unknown): never {
  if (err instanceof MongoServerError && err.code === 11000) {
    const keys = Object.keys((err.keyPattern as Record<string, unknown> | undefined) ?? {});
    if (keys.includes('phone')) {
      throw new AppError('PHONE_TAKEN', 'A customer with this phone number already exists', 409);
    }
    if (keys.some((k) => k.startsWith('identification.'))) {
      throw new AppError('ID_TAKEN', 'A customer with this ID document already exists', 409);
    }
  }
  throw err as Error;
}

export async function createCustomer(
  actor: AccessTokenPayload,
  body: CreateCustomerBody,
  requestId?: string,
): Promise<PublicCustomer> {
  const doc: Record<string, unknown> = {
    registeredById: new Types.ObjectId(actor.sub),
    status: 'active',
  };
  for (const key of [...SCALAR_FIELDS, ...SUBDOC_FIELDS]) {
    if (body[key] !== undefined) doc[key] = body[key];
  }

  const customer = await CustomerModel.create(doc).catch(throwIfDuplicate);

  await audit({
    actorId: actor.sub,
    action: 'customer.create',
    entityType: 'customer',
    entityId: customer._id,
    after: { fullName: customer.fullName, phone: customer.phone },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  const created = toPublicCustomer(customer);
  emitAdminEvent('customer.created', { id: created.id, fullName: created.fullName });
  return created;
}

export interface CustomerList {
  items: PublicCustomer[];
  page: number;
  limit: number;
  total: number;
}

export async function listCustomers(
  _actor: AccessTokenPayload,
  query: ListCustomersQuery,
): Promise<CustomerList> {
  const filter: Record<string, unknown> = { ...NOT_TRASHED };
  if (query.status) filter.status = query.status;
  const dateFilter = createdAtFilter(query.from, query.to);
  if (dateFilter) filter.createdAt = dateFilter;

  // Fuzzy search: results come back in relevance order, not createdAt.
  if (query.search !== undefined) {
    const rankedIds = await fuzzyCustomerIds(query.search);
    filter._id = { $in: rankedIds };
    const matches = await CustomerModel.find(filter);
    const rank = new Map(rankedIds.map((id, i) => [id.toHexString(), i]));
    matches.sort(
      (a, b) => (rank.get(a._id.toHexString()) ?? 0) - (rank.get(b._id.toHexString()) ?? 0),
    );
    const start = (query.page - 1) * query.limit;
    return {
      items: matches.slice(start, start + query.limit).map(toPublicCustomer),
      page: query.page,
      limit: query.limit,
      total: matches.length,
    };
  }

  const [customers, total] = await Promise.all([
    CustomerModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    CustomerModel.countDocuments(filter),
  ]);

  return { items: customers.map(toPublicCustomer), page: query.page, limit: query.limit, total };
}

export async function getCustomer(
  _actor: AccessTokenPayload,
  id: Types.ObjectId,
): Promise<PublicCustomer> {
  const customer = await CustomerModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  return toPublicCustomer(customer);
}

export async function updateCustomer(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  patch: UpdateCustomerBody,
  requestId?: string,
): Promise<PublicCustomer> {
  const customer = await CustomerModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  if (customer.status === 'inactive') {
    throw new AppError(
      'CUSTOMER_INACTIVE',
      'Inactive customers cannot be edited — reactivate the customer first',
      409,
    );
  }

  // Pairwise-distinct phones: the schema can't see stored values on a partial
  // update, so merge the patch with the document before checking.
  const clashes = phoneClashes({
    phone: patch.phone ?? customer.phone,
    altPhone: patch.altPhone ?? customer.altPhone,
    nextOfKinPhone: patch.nextOfKin ? patch.nextOfKin.phone : customer.nextOfKin?.phone,
  });
  if (clashes.length > 0) {
    throw new AppError('PHONES_NOT_DISTINCT', PHONES_DISTINCT_MESSAGE, 422, { fields: clashes });
  }

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of SCALAR_FIELDS) {
    const next = patch[key];
    if (next !== undefined && String(next) !== String(customer[key] ?? '')) {
      before[key] = customer[key] ?? null;
      after[key] = next;
      (customer as Record<typeof key, unknown>)[key] = next;
    }
  }
  for (const key of SUBDOC_FIELDS) {
    const next = patch[key];
    if (next !== undefined && JSON.stringify(next) !== JSON.stringify(customer[key] ?? null)) {
      before[key] = customer[key] ?? null;
      after[key] = next;
      customer.set(key, next);
    }
  }
  await customer.save().catch(throwIfDuplicate);

  if (Object.keys(after).length > 0) {
    await audit({
      actorId: actor.sub,
      action: 'customer.update',
      entityType: 'customer',
      entityId: customer._id,
      before,
      after,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }
  return toPublicCustomer(customer);
}

export async function setCustomerStatus(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  status: 'active' | 'inactive',
  requestId?: string,
): Promise<PublicCustomer> {
  const customer = await CustomerModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  if (customer.status === status) return toPublicCustomer(customer); // idempotent

  const before = { status: customer.status };
  customer.status = status;
  await customer.save();

  await audit({
    actorId: actor.sub,
    action: status === 'inactive' ? 'customer.deactivate' : 'customer.activate',
    entityType: 'customer',
    entityId: customer._id,
    before,
    after: { status },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicCustomer(customer);
}

/** Public shape of a trashed customer — trash listings and the DELETE response. */
export interface TrashedCustomer extends PublicCustomer {
  deletedAt: Date;
  deletedById?: string;
  deleteReason?: string;
}

function toTrashedCustomer(c: Customer): TrashedCustomer {
  return {
    ...toPublicCustomer(c),
    deletedAt: requireDeletedAt(c.deletedAt),
    ...(c.deletedById ? { deletedById: c.deletedById.toHexString() } : {}),
    ...(c.deleteReason !== undefined ? { deleteReason: c.deleteReason } : {}),
  };
}

export async function trashCustomer(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  reason: string | undefined,
  requestId?: string,
): Promise<TrashedCustomer> {
  const customer = await CustomerModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);

  // A customer can only go to the trash once every product tie is severed.
  const [susu, savings, loans, hirePurchase] = await Promise.all([
    SusuAccountModel.countDocuments({
      customerId: id,
      ...NOT_TRASHED,
      status: { $in: ['active', 'completed', 'pending-payout'] },
    }),
    SavingsAccountModel.countDocuments({ customerId: id, ...NOT_TRASHED, status: 'active' }),
    LoanModel.countDocuments({
      customerId: id,
      ...NOT_TRASHED,
      status: { $in: ['pending', 'approved', 'active', 'arrears'] },
    }),
    HpAgreementModel.countDocuments({
      customerId: id,
      ...NOT_TRASHED,
      status: { $in: ['pending', 'active', 'in-arrears', 'repossessed'] },
    }),
  ]);
  if (susu + savings + loans + hirePurchase > 0) {
    throw new AppError(
      'CANNOT_TRASH',
      'Customer still has open accounts, loans or agreements',
      422,
      { susu, savings, loans, hirePurchase },
    );
  }

  customer.deletedAt = new Date();
  customer.deletedById = new Types.ObjectId(actor.sub);
  if (reason !== undefined) customer.deleteReason = reason;
  await customer.save();

  await audit({
    actorId: actor.sub,
    action: 'customer.trash',
    entityType: 'customer',
    entityId: customer._id,
    before: { status: customer.status, deletedAt: null },
    after: {
      status: customer.status,
      deletedAt: customer.deletedAt,
      ...(reason !== undefined ? { deleteReason: reason } : {}),
    },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  const trashed = toTrashedCustomer(customer);
  emitAdminEvent('customer.trashed', { id: trashed.id, fullName: trashed.fullName });
  return trashed;
}

export async function restoreCustomer(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  requestId?: string,
): Promise<PublicCustomer> {
  const customer = await CustomerModel.findById(id);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  if (!customer.deletedAt) throw new AppError('NOT_TRASHED', 'Customer is not in the trash', 409);

  const before = {
    status: customer.status,
    deletedAt: customer.deletedAt,
    ...(customer.deleteReason !== undefined ? { deleteReason: customer.deleteReason } : {}),
  };
  customer.deletedAt = null;
  customer.set('deletedById', undefined);
  customer.set('deleteReason', undefined);
  await customer.save();

  await audit({
    actorId: actor.sub,
    action: 'customer.restore',
    entityType: 'customer',
    entityId: customer._id,
    before,
    after: { status: customer.status, deletedAt: null },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  const restored = toPublicCustomer(customer);
  emitAdminEvent('customer.restored', { id: restored.id, fullName: restored.fullName });
  return restored;
}

export interface CustomerTrashList {
  items: TrashedCustomer[];
  page: number;
  limit: number;
  total: number;
}

export async function listCustomerTrash(
  _actor: AccessTokenPayload,
  query: Pagination,
): Promise<CustomerTrashList> {
  const filter = { deletedAt: { $ne: null } };
  const [customers, total] = await Promise.all([
    CustomerModel.find(filter)
      .sort({ deletedAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    CustomerModel.countDocuments(filter),
  ]);
  return {
    items: customers.map(toTrashedCustomer),
    page: query.page,
    limit: query.limit,
    total,
  };
}

// ---------------------------------------------------------------- registration form

/** Printable A4 registration form; the photo is embedded when reachable. */
export async function registrationFormPdf(
  _actor: AccessTokenPayload,
  id: Types.ObjectId,
): Promise<{ buffer: Buffer; filename: string }> {
  const customer = await CustomerModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  const registeredBy = await UserModel.findById(customer.registeredById, { name: 1 });

  const buffer = await buildRegistrationFormPdf(customer, registeredBy?.name ?? null);
  return { buffer, filename: `registration-${customer._id.toHexString()}.pdf` };
}

import { MongoServerError } from 'mongodb';
import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { fuzzyCustomerIds } from '../../lib/fuzzy.js';
import {
  CustomerModel,
  type Customer,
  type CustomerIdentification,
  type NextOfKin,
} from '../../models/index.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type {
  CreateCustomerBody,
  ListCustomersQuery,
  UpdateCustomerBody,
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
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;

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
  const customer = await CustomerModel.findById(id);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  return toPublicCustomer(customer);
}

export async function updateCustomer(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  patch: UpdateCustomerBody,
  requestId?: string,
): Promise<PublicCustomer> {
  const customer = await CustomerModel.findById(id);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);

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
  const customer = await CustomerModel.findById(id);
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

import { MongoServerError } from 'mongodb';
import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { uploadCustomerPhoto } from '../../lib/photos.js';
import { assertCanActOnCustomer, customerScopeFilter } from '../../middleware/rbac.js';
import { CustomerModel, UserModel, type Customer } from '../../models/index.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type {
  CreateCustomerBody,
  ListCustomersQuery,
  UpdateCustomerBody,
} from './customers.schemas.js';

export interface PublicCustomer {
  id: string;
  fullName: string;
  phone: string;
  altPhone?: string;
  ghanaCardNumber?: string;
  photoUrl?: string;
  residentialAddress?: string;
  ghanaPostGps?: string;
  registeredById: string;
  assignedCollectorId?: string;
  status: 'active' | 'inactive';
  createdAt: Date;
}

export function toPublicCustomer(c: Customer): PublicCustomer {
  return {
    id: c._id.toHexString(),
    fullName: c.fullName,
    phone: c.phone,
    ...(c.altPhone !== undefined ? { altPhone: c.altPhone } : {}),
    ...(c.ghanaCardNumber !== undefined ? { ghanaCardNumber: c.ghanaCardNumber } : {}),
    ...(c.photoUrl !== undefined ? { photoUrl: c.photoUrl } : {}),
    ...(c.residentialAddress !== undefined ? { residentialAddress: c.residentialAddress } : {}),
    ...(c.ghanaPostGps !== undefined ? { ghanaPostGps: c.ghanaPostGps } : {}),
    registeredById: c.registeredById.toHexString(),
    ...(c.assignedCollectorId ? { assignedCollectorId: c.assignedCollectorId.toHexString() } : {}),
    status: c.status,
    createdAt: c.createdAt,
  };
}

function throwIfDuplicate(err: unknown): never {
  if (err instanceof MongoServerError && err.code === 11000) {
    const key = Object.keys((err.keyPattern as Record<string, unknown> | undefined) ?? {})[0];
    if (key === 'phone') {
      throw new AppError('PHONE_TAKEN', 'A customer with this phone number already exists', 409);
    }
    if (key === 'ghanaCardNumber') {
      throw new AppError('GHANA_CARD_TAKEN', 'A customer with this Ghana Card already exists', 409);
    }
  }
  throw err as Error;
}

async function assertActiveCollector(id: Types.ObjectId): Promise<void> {
  const user = await UserModel.findById(id);
  if (user?.role !== 'collector' || user.status !== 'active') {
    throw new AppError('INVALID_COLLECTOR', 'Assigned collector must be an active collector', 422);
  }
}

export async function createCustomer(
  actor: AccessTokenPayload,
  body: CreateCustomerBody,
  requestId?: string,
): Promise<PublicCustomer> {
  let assignedCollectorId = body.assignedCollectorId;

  if (actor.role === 'collector') {
    // Field registration: the collector registers for their own book only.
    const self = new Types.ObjectId(actor.sub);
    if (assignedCollectorId && !assignedCollectorId.equals(self)) {
      throw new AppError('FORBIDDEN', 'Collectors can only assign customers to themselves', 403);
    }
    assignedCollectorId = self;
  } else if (assignedCollectorId) {
    await assertActiveCollector(assignedCollectorId);
  }

  const customer = await CustomerModel.create({
    fullName: body.fullName,
    phone: body.phone,
    ...(body.altPhone !== undefined ? { altPhone: body.altPhone } : {}),
    ...(body.ghanaCardNumber !== undefined ? { ghanaCardNumber: body.ghanaCardNumber } : {}),
    ...(body.residentialAddress !== undefined
      ? { residentialAddress: body.residentialAddress }
      : {}),
    ...(body.ghanaPostGps !== undefined ? { ghanaPostGps: body.ghanaPostGps } : {}),
    ...(assignedCollectorId ? { assignedCollectorId } : {}),
    registeredById: new Types.ObjectId(actor.sub),
    status: 'active',
  }).catch(throwIfDuplicate);

  await audit({
    actorId: actor.sub,
    action: 'customer.create',
    entityType: 'customer',
    entityId: customer._id,
    after: {
      fullName: customer.fullName,
      phone: customer.phone,
      assignedCollectorId: customer.assignedCollectorId?.toHexString() ?? null,
    },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicCustomer(customer);
}

export interface CustomerList {
  items: PublicCustomer[];
  page: number;
  limit: number;
  total: number;
}

export async function listCustomers(
  actor: AccessTokenPayload,
  query: ListCustomersQuery,
): Promise<CustomerList> {
  const filter: Record<string, unknown> = { ...customerScopeFilter(actor) };
  if (query.status) filter.status = query.status;
  if (query.assignedCollectorId && actor.role !== 'collector') {
    filter.assignedCollectorId = query.assignedCollectorId;
  }
  if (query.search !== undefined) {
    const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { fullName: { $regex: escaped, $options: 'i' } },
      { phone: { $regex: escaped, $options: 'i' } },
    ];
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
  actor: AccessTokenPayload,
  id: Types.ObjectId,
): Promise<PublicCustomer> {
  const customer = await CustomerModel.findById(id);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  assertCanActOnCustomer(actor, customer);
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

  const newCollectorId = patch.assignedCollectorId;
  const reassigning =
    newCollectorId !== undefined &&
    newCollectorId.toHexString() !== customer.assignedCollectorId?.toHexString();
  if (reassigning) {
    await assertActiveCollector(newCollectorId);
  }

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of [
    'fullName',
    'phone',
    'altPhone',
    'ghanaCardNumber',
    'residentialAddress',
    'ghanaPostGps',
  ] as const) {
    const next = patch[key];
    if (next !== undefined && next !== customer[key]) {
      before[key] = customer[key];
      after[key] = next;
      (customer as Record<typeof key, unknown>)[key] = next;
    }
  }
  if (reassigning) {
    before.assignedCollectorId = customer.assignedCollectorId?.toHexString() ?? null;
    after.assignedCollectorId = newCollectorId.toHexString();
    customer.assignedCollectorId = newCollectorId;
  }

  await customer.save().catch(throwIfDuplicate);

  if (Object.keys(after).length > 0) {
    await audit({
      actorId: actor.sub,
      action: reassigning ? 'customer.reassign' : 'customer.update',
      entityType: 'customer',
      entityId: customer._id,
      before,
      after,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }
  return toPublicCustomer(customer);
}

export async function setCustomerPhoto(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  imageBuffer: Buffer,
  requestId?: string,
): Promise<PublicCustomer> {
  const customer = await CustomerModel.findById(id);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  assertCanActOnCustomer(actor, customer);

  const photoUrl = await uploadCustomerPhoto(customer._id.toHexString(), imageBuffer);
  const before = { photoUrl: customer.photoUrl ?? null };
  customer.photoUrl = photoUrl;
  await customer.save();

  await audit({
    actorId: actor.sub,
    action: 'customer.photo',
    entityType: 'customer',
    entityId: customer._id,
    before,
    after: { photoUrl },
    ...(requestId !== undefined ? { requestId } : {}),
  });
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

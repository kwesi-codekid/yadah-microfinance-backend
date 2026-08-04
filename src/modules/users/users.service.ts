import bcrypt from 'bcrypt';
import { MongoServerError } from 'mongodb';
import type { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { UserModel } from '../../models/index.js';
import {
  BCRYPT_COST,
  notifyPasswordChanged,
  toPublicUser,
  type AccessTokenPayload,
  type PublicUser,
} from '../auth/auth.service.js';
import type { CreateUserBody, ListUsersQuery, UpdateUserBody } from './users.schemas.js';

export interface UserList {
  items: PublicUser[];
  page: number;
  limit: number;
  total: number;
}

/** Maps a Mongo duplicate-key error to a friendly 409. */
function throwIfDuplicate(err: unknown): never {
  if (err instanceof MongoServerError && err.code === 11000) {
    const key = Object.keys((err.keyPattern as Record<string, unknown> | undefined) ?? {})[0];
    if (key === 'username') {
      throw new AppError('USERNAME_TAKEN', 'This username is already in use', 409);
    }
    if (key === 'phone') {
      throw new AppError('PHONE_TAKEN', 'This phone number is already in use', 409);
    }
  }
  throw err as Error;
}

export async function createUser(
  actor: AccessTokenPayload,
  body: CreateUserBody,
  requestId?: string,
): Promise<PublicUser> {
  const { password, email, ...fields } = body;
  const user = await UserModel.create({
    ...fields,
    ...(email !== undefined ? { email } : {}),
    passwordHash: await bcrypt.hash(password, BCRYPT_COST),
    status: 'active',
  }).catch(throwIfDuplicate);

  await audit({
    actorId: actor.sub,
    action: 'user.create',
    entityType: 'user',
    entityId: user._id,
    after: { name: user.name, username: user.username, phone: user.phone, role: user.role },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicUser(user);
}

export async function listUsers(query: ListUsersQuery): Promise<UserList> {
  const filter: Record<string, unknown> = {};
  if (query.role) filter.role = query.role;
  if (query.status) filter.status = query.status;
  if (query.search !== undefined) {
    const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { name: { $regex: escaped, $options: 'i' } },
      { username: { $regex: escaped, $options: 'i' } },
    ];
  }

  const [users, total] = await Promise.all([
    UserModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    UserModel.countDocuments(filter),
  ]);

  return { items: users.map(toPublicUser), page: query.page, limit: query.limit, total };
}

export async function getUser(id: Types.ObjectId): Promise<PublicUser> {
  const user = await UserModel.findById(id);
  if (!user) throw new AppError('NOT_FOUND', 'User not found', 404);
  return toPublicUser(user);
}

export async function updateUser(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  patch: UpdateUserBody,
  requestId?: string,
): Promise<PublicUser> {
  const user = await UserModel.findById(id);
  if (!user) throw new AppError('NOT_FOUND', 'User not found', 404);

  const isSelf = actor.sub === id.toHexString();
  const roleChanged = patch.role !== undefined && patch.role !== user.role;
  if (isSelf && roleChanged) {
    throw new AppError('CANNOT_MODIFY_SELF', 'You cannot change your own role', 403);
  }

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of ['name', 'phone', 'email', 'role'] as const) {
    const next = patch[key];
    if (next !== undefined && next !== user[key]) {
      before[key] = user[key];
      after[key] = next;
      (user as Record<typeof key, unknown>)[key] = next;
    }
  }

  // Stale JWTs must not keep an old role longer than the access-token window.
  if (roleChanged) {
    user.refreshSessions = [];
  }

  await user.save().catch(throwIfDuplicate);

  if (Object.keys(after).length > 0) {
    await audit({
      actorId: actor.sub,
      action: 'user.update',
      entityType: 'user',
      entityId: user._id,
      before,
      after,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }
  return toPublicUser(user);
}

export async function resetUserPassword(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  newPassword: string,
  requestId?: string,
): Promise<void> {
  const user = await UserModel.findById(id);
  if (!user) throw new AppError('NOT_FOUND', 'User not found', 404);

  user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  user.refreshSessions = []; // every existing session dies now
  await user.save();

  await audit({
    actorId: actor.sub,
    action: 'user.password-reset',
    entityType: 'user',
    entityId: user._id,
    ...(requestId !== undefined ? { requestId } : {}),
  });
  await notifyPasswordChanged(user);
}

export async function setUserStatus(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  status: 'active' | 'disabled',
  requestId?: string,
): Promise<PublicUser> {
  const user = await UserModel.findById(id);
  if (!user) throw new AppError('NOT_FOUND', 'User not found', 404);

  if (status === 'disabled' && actor.sub === id.toHexString()) {
    throw new AppError('CANNOT_MODIFY_SELF', 'You cannot disable yourself', 403);
  }
  if (user.status === status) {
    return toPublicUser(user); // idempotent
  }

  const before = { status: user.status };
  user.status = status;
  if (status === 'disabled') {
    // Their access token dies within 15 minutes; refresh dies now.
    user.refreshSessions = [];
  }
  await user.save();

  await audit({
    actorId: actor.sub,
    action: status === 'disabled' ? 'user.disable' : 'user.enable',
    entityType: 'user',
    entityId: user._id,
    before,
    after: { status },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicUser(user);
}

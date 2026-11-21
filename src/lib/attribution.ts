import { Types } from 'mongoose';
import { UserModel } from '../models/index.js';
import type { AccessTokenPayload } from '../modules/auth/auth.service.js';
import { AppError } from './errors.js';

/**
 * Whose collection a transaction is, and who typed it in.
 *
 * Collectors go out on their rounds and the office attendant enters what they
 * brought back. The money is the collector's — their day, their cash count,
 * their row on every report — so it is filed under them, in the field every
 * existing read already uses. The person at the keyboard goes in `enteredById`,
 * set only when the two differ, and the audit entry names them as the actor.
 */
export interface Attribution {
  /** Who the money is filed under. */
  recordedById: Types.ObjectId;
  /** Who typed it in, when that is somebody else. */
  enteredById?: Types.ObjectId;
}

export async function resolveAttribution(
  actor: AccessTokenPayload,
  collectorId: Types.ObjectId | undefined,
): Promise<Attribution> {
  const self = new Types.ObjectId(actor.sub);
  if (!collectorId || collectorId.equals(self)) return { recordedById: self };
  if (actor.role === 'collector') {
    throw new AppError('FORBIDDEN', 'A collector records only their own collections', 403);
  }
  await assertActiveCollector(collectorId);
  return { recordedById: collectorId, enteredById: self };
}

export async function assertActiveCollector(collectorId: Types.ObjectId): Promise<void> {
  const known = await UserModel.exists({
    _id: collectorId,
    role: 'collector',
    status: 'active',
  });
  if (!known) throw new AppError('COLLECTOR_NOT_FOUND', 'That collector is not active', 422);
}

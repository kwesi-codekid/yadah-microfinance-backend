import { Types, type ClientSession } from 'mongoose';
import { AuditLogModel } from '../models/index.js';

export interface AuditEntry {
  /** User performing the action (from req.auth.sub). */
  actorId: string | Types.ObjectId;
  /** Dot-notation action, e.g. "susu.deposit.record", "loan.approve". */
  action: string;
  /** Kebab-case entity type matching the collection, e.g. "susu-account". */
  entityType: string;
  entityId: Types.ObjectId;
  /** For money mutations: balance/total before and after, in pesewas. */
  amountBefore?: number;
  amountAfter?: number;
  /** Optional snapshots of the changed fields. */
  before?: unknown;
  after?: unknown;
  /** From req.id — links the entry to the HTTP request in the logs. */
  requestId?: string;
}

/**
 * Writes one audit entry (rule 3: every mutating money action, no silent
 * mutations). Pass the session of the surrounding transaction so the entry
 * commits and rolls back WITH the money move it records. A failed audit
 * write throws — a money move that cannot be audited must not commit.
 */
export async function audit(entry: AuditEntry, session?: ClientSession): Promise<void> {
  await AuditLogModel.create(
    [
      {
        ...entry,
        actorId:
          typeof entry.actorId === 'string' ? new Types.ObjectId(entry.actorId) : entry.actorId,
      },
    ],
    session ? { session } : {},
  );
}

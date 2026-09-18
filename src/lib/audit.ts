import { Types, type ClientSession } from 'mongoose';
import { AuditLogModel } from '../models/index.js';
import { currentRequest } from './request-context.js';

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
 *
 * Where the change came from — the endpoint, the caller's user agent, and
 * the request id — is read off the request context rather than
 * passed in, so every one of the hundred call sites records it without
 * knowing. A caller that names its own `requestId` keeps it. Outside a
 * request (a worker) there is no context and none of it is written.
 */
export async function audit(entry: AuditEntry, session?: ClientSession): Promise<void> {
  const request = currentRequest();
  const source = request
    ? {
        ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
        method: request.method,
        path: request.path,
        ...(request.userAgent !== undefined ? { userAgent: request.userAgent } : {}),
      }
    : {};
  await AuditLogModel.create(
    [
      {
        ...source,
        ...entry,
        actorId:
          typeof entry.actorId === 'string' ? new Types.ObjectId(entry.actorId) : entry.actorId,
      },
    ],
    session ? { session } : {},
  );
}

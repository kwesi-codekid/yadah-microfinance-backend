import { Types } from 'mongoose';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { backfillPayoutLines, migrateSusuPlans } from '../../scripts/migrate-susu-plans.js';

/**
 * The susu data update, run from the office's screen rather than a terminal
 * (user request, 30 Sep 2026). Two steps, both here: books become one account
 * with plans, and money out that names no plan gets its shares. A dry run
 * reports what would change and writes nothing; `apply` writes and leaves an
 * audit entry. One run at a time — a second caller is told to wait.
 */

export interface MigrationReport {
  apply: boolean;
  migration: Awaited<ReturnType<typeof migrateSusuPlans>>;
  backfill: Awaited<ReturnType<typeof backfillPayoutLines>>;
  /** balanceBefore − commissionTakenNow − balanceAfter; zero when the money reconciles. */
  drift: number;
}

let running = false;

export async function runSusuMigration(
  actor: AccessTokenPayload,
  apply: boolean,
  requestId?: string,
): Promise<MigrationReport> {
  if (running) {
    throw new AppError('MIGRATION_RUNNING', 'The susu data update is already running', 409);
  }
  running = true;
  try {
    const migration = await migrateSusuPlans(apply);
    const backfill = await backfillPayoutLines(apply);
    const drift = migration.balanceBefore - migration.commissionTakenNow - migration.balanceAfter;
    if (apply) {
      await audit({
        actorId: actor.sub,
        action: 'susu.migrate',
        entityType: 'susu-account',
        entityId: new Types.ObjectId(),
        after: { migration, backfill, drift },
        ...(requestId !== undefined ? { requestId } : {}),
      });
    }
    return { apply, migration, backfill, drift };
  } finally {
    running = false;
  }
}

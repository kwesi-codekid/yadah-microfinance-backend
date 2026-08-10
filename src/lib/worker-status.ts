/**
 * In-memory heartbeat registry for the background workers (SMS, loan
 * escalation, HP arrears, debt recovery). Purely for ops visibility via
 * GET /reports/workers — resets on restart, which is fine: a fresh process
 * runs every pass immediately at startup anyway.
 */

export interface WorkerStatus {
  startedAt: Date | null;
  lastRunAt: Date | null;
  lastOk: boolean | null;
  lastError: string | null;
  /** What the last pass changed (worker-specific counters), if anything. */
  lastChanges: Record<string, number> | null;
  runCount: number;
}

const registry = new Map<string, WorkerStatus>();

function entry(name: string): WorkerStatus {
  let status = registry.get(name);
  if (!status) {
    status = {
      startedAt: null,
      lastRunAt: null,
      lastOk: null,
      lastError: null,
      lastChanges: null,
      runCount: 0,
    };
    registry.set(name, status);
  }
  return status;
}

export function recordWorkerStart(name: string): void {
  entry(name).startedAt = new Date();
}

export function recordWorkerRun(
  name: string,
  result: { ok: boolean; error?: string; changes?: Record<string, number> },
): void {
  const status = entry(name);
  status.lastRunAt = new Date();
  status.lastOk = result.ok;
  status.lastError = result.ok ? null : (result.error ?? 'unknown error');
  status.lastChanges = result.changes ?? null;
  status.runCount += 1;
}

export function workerStatuses(): Record<string, WorkerStatus> {
  return Object.fromEntries(registry);
}

/** Test helper. */
export function resetWorkerStatuses(): void {
  registry.clear();
}

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What a teller can reach, read from the routers rather than trusted.
 *
 * A teller is the counter: unscoped, because anyone may walk up, but junior,
 * because deciding is not their job. That line is drawn one `requireOffice` at
 * a time across nine modules, which is exactly the kind of thing that drifts —
 * somebody adds a route, copies the wrong neighbour, and a teller can approve
 * a loan. So the two halves are written down here and checked against the
 * route files.
 *
 * A failure means one of two things, and they are not the same: either a gate
 * moved and this list should follow it, or a gate moved by accident and the
 * route should be put back. Read the diff before editing this file.
 */

const MODULES_DIR = 'src/modules';

/** Gates that admit the office but refuse a teller. `requireCounter` does not. */
const OFFICE_ONLY_GUARDS = ['requireOffice', 'requireAdmin', 'requireRole'];

/**
 * Every `METHOD /path` a teller token can reach. A guard on the router itself
 * closes everything beneath it; otherwise each route carries its own.
 *
 * The customer portal is excluded: it sits behind a different door entirely
 * and no staff token opens it.
 */
function tellerReachable(): Set<string> {
  const found = new Set<string>();

  for (const moduleName of readdirSync(MODULES_DIR)) {
    if (moduleName === 'portal') continue;
    const dir = join(MODULES_DIR, moduleName);

    for (const file of readdirSync(dir).filter((f) => f.endsWith('.routes.ts'))) {
      const lines = readFileSync(join(dir, file), 'utf8').split('\n');

      const routerClosed = lines.some(
        (l) => l.includes('.use(') && OFFICE_ONLY_GUARDS.some((g) => l.includes(g)),
      );
      if (routerClosed) continue;

      for (const [i, line] of lines.entries()) {
        const inline = /Router\.(get|post|patch|put|delete)\(\s*'([^']*)'/.exec(line);
        const wrapped = /Router\.(get|post|patch|put|delete)\(\s*$/.exec(line);

        let method: string;
        let path: string;
        if (inline) {
          method = inline[1] ?? '';
          path = inline[2] ?? '';
        } else if (wrapped) {
          method = wrapped[1] ?? '';
          // A wrapped definition puts the path on the line below the verb.
          path = (lines[i + 1] ?? '').trim().replace(/[',]/g, '');
        } else {
          continue;
        }

        // The guard, if any, sits in the few lines after the verb.
        if (
          OFFICE_ONLY_GUARDS.some((g) =>
            lines
              .slice(i, i + 6)
              .join(' ')
              .includes(g),
          )
        ) {
          continue;
        }

        const openApiPath = `/${moduleName}${path === '/' ? '' : path}`.replace(
          /:([A-Za-z0-9_]+)/g,
          '{$1}',
        );
        found.add(`${method.toUpperCase()} ${openApiPath}`);
      }
    }
  }
  return found;
}

/** Serving whoever is standing at the counter: money in, money out, and the book. */
const THE_COUNTER = [
  // The person, and the record of them.
  'POST /customers',
  'PATCH /customers/{id}',
  'GET /customers/{id}',
  'GET /customers/{id}/statement',
  'GET /customers/{id}/registration-form',

  // Susu: open a cycle, take the daily, pay it out at the end.
  'POST /susu/accounts',
  'POST /susu/accounts/{id}/deposits',
  'POST /susu/collect-all',
  'POST /susu/accounts/{id}/withdraw',
  'POST /susu/accounts/{id}/payout',
  'POST /susu/accounts/{id}/close',

  // Savings: the same shape, with the API's own limits on what may leave.
  'POST /savings/accounts',
  'POST /savings/accounts/{id}/deposits',
  'POST /savings/accounts/{id}/withdrawals',
  'POST /savings/accounts/{id}/close',

  // Loans and hire purchase: take the money, never decide the thing.
  'POST /loans/{id}/repayments',
  'POST /loans/{id}/repayments/susu-closure',
  'POST /hire-purchase/sales',
  'POST /hire-purchase/agreements/{id}/deposit',
  'POST /hire-purchase/agreements/{id}/payments',
  'POST /hire-purchase/agreements/{id}/redeem',

  // The day's figures, and declaring the till at the end of it.
  'GET /dashboard/summary',
  'POST /reconciliation/declare',
] as const;

/** Deciding, correcting, and the company's own books. Not the counter's. */
const NOT_THE_COUNTER = [
  // Credit is decided by a person senior to whoever holds the cash.
  'POST /loans/applications',
  'POST /loans/{id}/approve',
  'POST /loans/{id}/reject',
  'PUT /loans/config',
  'POST /hire-purchase/agreements',
  'POST /hire-purchase/agreements/{id}/reject',
  'POST /hire-purchase/agreements/{id}/repossess',
  'POST /hire-purchase/agreements/{id}/forfeit',
  'PUT /hire-purchase/config',

  // The shelf, and undoing a sale already rung up.
  'POST /hire-purchase/items',
  'POST /hire-purchase/items/{id}/adjust-stock',
  'POST /hire-purchase/sales/{id}/void',

  // Taking anything out of the listings, or bringing it back.
  'DELETE /customers/{id}',
  'POST /customers/{id}/restore',
  'GET /customers/trash',
  'DELETE /susu/accounts/{id}',
  'POST /susu/accounts/{id}/terminate',
  'DELETE /savings/accounts/{id}',

  // Registering a whole book at once is an office job, unlike one at the desk.
  'POST /customers/import',

  // Moving a customer between their own products, and moving them between rounds.
  'POST /transfers',
  'PATCH /customers/{id}/collector',

  // The company's own money, what it is owed, and who works here.
  'GET /accounting/cash-position',
  'GET /reports/dashboard',
  'POST /users',

  // Counting somebody else's declared cash is supervision, not counter work.
  'GET /reconciliation/variances',
  'POST /reconciliation/{id}/confirm',
] as const;

describe('what a teller can reach', () => {
  const reachable = tellerReachable();

  it('serves the counter', () => {
    expect(THE_COUNTER.filter((r) => !reachable.has(r))).toEqual([]);
  });

  it('decides nothing, and touches neither the books nor the trash', () => {
    expect(NOT_THE_COUNTER.filter((r) => reachable.has(r))).toEqual([]);
  });

  it('is checking real routes, not a list of typos', () => {
    // Both lists must name endpoints that exist, or the assertions above pass
    // by describing nothing. Every path should appear in some route file.
    const everyRoute = new Set<string>();
    for (const moduleName of readdirSync(MODULES_DIR)) {
      const dir = join(MODULES_DIR, moduleName);
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.routes.ts'))) {
        const lines = readFileSync(join(dir, file), 'utf8').split('\n');
        for (const [i, line] of lines.entries()) {
          const inline = /Router\.(get|post|patch|put|delete)\(\s*'([^']*)'/.exec(line);
          const wrapped = /Router\.(get|post|patch|put|delete)\(\s*$/.exec(line);
          if (!inline && !wrapped) continue;
          const method = (inline ? inline[1] : wrapped?.[1]) ?? '';
          const path = inline
            ? (inline[2] ?? '')
            : (lines[i + 1] ?? '').trim().replace(/[',]/g, '');
          everyRoute.add(
            `${method.toUpperCase()} /${moduleName}${path === '/' ? '' : path}`.replace(
              /:([A-Za-z0-9_]+)/g,
              '{$1}',
            ),
          );
        }
      }
    }
    expect([...THE_COUNTER, ...NOT_THE_COUNTER].filter((r) => !everyRoute.has(r))).toEqual([]);
  });
});

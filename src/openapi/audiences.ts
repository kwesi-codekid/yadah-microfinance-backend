/**
 * Which app can call what.
 *
 * Three clients share this API and they are NOT interchangeable:
 *
 *   Office app     — admin, manager and teller tokens. Everything not listed
 *                    below. A teller reaches a subset of it: the counter gates
 *                    (`requireCounter`) let them serve whoever is standing
 *                    there, while the decisions stay behind `requireOffice`.
 *   Collector app  — collector tokens. Exactly the operations in COLLECTOR_APP.
 *   Customer portal— customer tokens, a different signing key entirely. Every
 *                    /portal route, tagged `Customer Portal`.
 *
 * The module tags (Susu, Savings…) group endpoints by SUBJECT, which is what
 * the office app wants. That is no help to someone building the collector app,
 * because a collector can call eight of the twenty-two Susu endpoints and the
 * docs give no hint which. So the operations below get a second tag, and the
 * `Collector App` section then lists exactly what a collector token reaches.
 *
 * Operations appear under both tags on purpose — the same endpoint viewed by
 * subject and by audience.
 *
 * This list is checked against the routers by audiences.test.ts: if a guard
 * changes and this file does not, the test fails. Do not hand-edit it to make
 * a test pass — fix whichever of the two is actually wrong.
 */

export const AUDIENCE_TAGS = {
  collector: 'Collector App',
  portal: 'Customer Portal',
} as const;

/**
 * Every `METHOD /path` a COLLECTOR token can reach, in OpenAPI path form.
 *
 * Reachable is not the same as unrestricted: a collector is additionally
 * scoped to the customers assigned to them, so a listing returns only their
 * own and reaching for anyone else's record is a 403, never an empty result
 * (see lib/customer-scope.ts).
 */
export const COLLECTOR_APP: readonly string[] = [
  // Sign in. Shared with the office — same credentials, same endpoints.
  'POST /auth/login',
  'POST /auth/otp/request',
  'POST /auth/otp/verify',
  'POST /auth/refresh',
  'POST /auth/logout',
  'POST /auth/password/change',
  'POST /auth/password/forgot',
  'POST /auth/password/reset',
  'GET /auth/me',

  // The two home screens: what is still owed today, and the day so far.
  'GET /collectors/me/round',
  'GET /collectors/me/day',

  // Their own customers, read-only. Registration is office-only.
  'GET /customers',
  'GET /customers/{id}',

  // Taking susu money in the field, and the receipt for it.
  'GET /susu/accounts',
  'GET /susu/accounts/{id}',
  'GET /susu/accounts/{id}/deposits',
  'POST /susu/accounts/{id}/deposits',
  'POST /susu/collect-all',
  'GET /susu/accounts/{id}/deposits/{depositId}/receipt',
  'GET /susu/accounts/{id}/withdrawals/{payoutId}/receipt',
  'GET /susu/summary',

  // Savings deposits only. Withdrawals and closures are office-only.
  'GET /savings/accounts',
  'GET /savings/accounts/{id}',
  'GET /savings/accounts/{id}/transactions',
  'POST /savings/accounts/{id}/deposits',
  'GET /savings/accounts/{id}/txns/{txnId}/receipt',

  // Mobile money, for a customer who would rather pay by phone.
  'POST /payments/charges',
  'GET /payments/charges/{reference}',
  'POST /payments/charges/{reference}/verify',

  // End of round: check what the system expects, then declare the cash.
  'GET /reconciliation/expected',
  'POST /reconciliation/declare',
  'GET /reconciliation',
  'GET /reconciliation/{id}',

  // In-app alerts and web push.
  'GET /notifications',
  'GET /notifications/unread-count',
  'GET /notifications/push/config',
  'POST /notifications/push/subscribe',
  'POST /notifications/push/unsubscribe',
  'POST /notifications/read-all',
  'POST /notifications/{id}/read',

  // Photos captured on a handset.
  'POST /uploads/images',
  'DELETE /uploads/images',
];

/**
 * Sidebar sections, in the order a reader should meet them. Scalar and Redoc
 * both understand `x-tagGroups`; a client that does not simply falls back to a
 * flat tag list, which still works.
 */
export const TAG_GROUPS = [
  {
    name: 'Start here',
    tags: ['Auth'],
  },
  {
    name: 'Collector app',
    tags: ['Collector App', 'Collectors', 'Reconciliation'],
  },
  {
    name: 'Customer portal',
    tags: ['Customer Portal', 'Payout Requests'],
  },
  {
    name: 'Office — money',
    tags: ['Susu', 'Savings', 'Loans', 'Hire Purchase', 'Transfers', 'Payments'],
  },
  {
    name: 'Office — books and reporting',
    tags: ['Dashboard', 'Accounting', 'Reports'],
  },
  {
    name: 'Office — administration',
    tags: ['Customers', 'Users', 'Notifications', 'Uploads'],
  },
];

/** Adds the audience tag to every operation listed in COLLECTOR_APP. */
export function applyAudienceTags(paths: Record<string, unknown>): void {
  const wanted = new Set(COLLECTOR_APP);
  for (const [path, item] of Object.entries(paths)) {
    if (typeof item !== 'object' || item === null) continue;
    for (const [method, operation] of Object.entries(item as Record<string, unknown>)) {
      if (typeof operation !== 'object' || operation === null) continue;
      if (!wanted.has(`${method.toUpperCase()} ${path}`)) continue;
      const op = operation as { tags?: string[] };
      op.tags = [...(op.tags ?? []), AUDIENCE_TAGS.collector];
    }
  }
}

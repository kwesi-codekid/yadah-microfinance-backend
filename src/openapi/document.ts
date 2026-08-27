import { createDocument } from 'zod-openapi';
import { authPaths } from '../modules/auth/auth.openapi.js';
import { userPaths } from '../modules/users/users.openapi.js';
import { customerPaths } from '../modules/customers/customers.openapi.js';
import { susuPaths } from '../modules/susu/susu.openapi.js';
import { savingsPaths } from '../modules/savings/savings.openapi.js';
import { uploadPaths } from '../modules/uploads/uploads.openapi.js';
import { loanPaths } from '../modules/loans/loans.openapi.js';
import { reportPaths } from '../modules/reports/reports.openapi.js';
import { dashboardPaths } from '../modules/dashboard/dashboard.openapi.js';
import { collectorPaths } from '../modules/collectors/collectors.openapi.js';
import { portalPaths } from '../modules/portal/portal.openapi.js';
import { accountingPaths } from '../modules/accounting/accounting.openapi.js';
import { hpPaths } from '../modules/hire-purchase/hp.openapi.js';
import { transferPaths } from '../modules/transfers/transfers.openapi.js';
import { paymentPaths } from '../modules/payments/payments.openapi.js';
import { reconciliationPaths } from '../modules/reconciliation/reconciliation.openapi.js';
import { notificationPaths } from '../modules/notifications/notifications.openapi.js';
import { applyAudienceTags, AUDIENCE_TAGS, TAG_GROUPS } from './audiences.js';

/** Modules register their paths here as they land (users, customers, susu…). */
export function buildOpenApiDocument(): ReturnType<typeof createDocument> {
  const document = createDocument({
    openapi: '3.1.0',
    info: {
      title: 'Yadah Microfinance API',
      version: '0.1.0',
      description:
        'Susu collection, savings, and loans API for Yadah Dynamic Enterprise.\n\n' +
        '### Which app are you building?\n\n' +
        'Three clients share this API and they are not interchangeable. Start from the ' +
        'section that matches yours:\n\n' +
        '- **Collector app** (field staff). The **Collector App** tag lists every endpoint ' +
        'a collector token can reach — nothing else will answer. Collectors are further ' +
        'scoped to their own assigned customers: reaching for anyone else returns 403, ' +
        'never an empty list.\n' +
        '- **Customer portal**. Everything under **Customer Portal**, on the `/portal` ' +
        'prefix. Portal tokens are signed with a different key and are rejected by every ' +
        'staff endpoint, so they use the `portalAuth` scheme, not `bearerAuth`.\n' +
        '- **Office app** (admin and manager). Everything else, grouped by subject.\n\n' +
        'Endpoints a collector shares with the office appear twice — once under their ' +
        'subject, once under Collector App. That is one endpoint seen two ways, not two ' +
        'endpoints.\n\n' +
        '### Conventions\n\n' +
        'JSON, camelCase fields. All money values are **integer pesewas** ' +
        '(GHS 10.50 = `1050`) — convert only when you display. Dates are ISO 8601 UTC, and ' +
        'day-boundary rules use the Africa/Accra calendar day. Errors always use the ' +
        '`{ error: { code, message, details? } }` envelope, with Zod issues in `details`. ' +
        'Authenticate with `Authorization: Bearer <accessToken>`.',
    },
    servers: [{ url: '/api/v1' }],
    tags: [
      { name: 'Auth', description: 'Login (username+password or phone OTP), sessions' },
      {
        name: AUDIENCE_TAGS.collector,
        description:
          'Everything a COLLECTOR token can reach, gathered in one place — the definitive ' +
          'list for building the field app. Each of these also appears under its own ' +
          'subject tag; this is the same set viewed by audience rather than by topic. ' +
          'Anything not listed here answers 403 to a collector.',
      },
      { name: 'Users', description: 'Staff management and role assignment (office roles)' },
      { name: 'Customers', description: 'Customer registration, profile, collector assignment' },
      {
        name: 'Susu',
        description: 'Daily-deposit cycles: 31 deposits, catch-up, collect-all, closure',
      },
      {
        name: 'Savings',
        description:
          'Min GHS 5 deposits, 1 withdrawal/day with flat GHS 10 fee, GHS 50 min balance',
      },
      {
        name: 'Notifications',
        description: 'In-app notifications and Web Push subscriptions (all staff roles)',
      },
      {
        name: 'Reconciliation',
        description:
          'End-of-day cash handover: collector declares, office confirms, variance recorded',
      },
      {
        name: 'Uploads',
        description: 'Image upload/delete — URLs are submitted in later form posts',
      },
      {
        name: 'Loans',
        description:
          'Small 1k–20k / big to 50k GHS · flat 10/20/30% by duration · escalation on original principal · office only',
      },
      {
        name: 'Dashboard',
        description:
          'Everything the office dashboard screen reads: headline KPIs, bucketed cash ' +
          'series for the charts, standing alerts, and a recent-activity window. JSON only ' +
          '— exports live under Reports.',
      },
      {
        name: 'Collectors',
        description:
          "The field app's two home screens: today's round (who still owes a susu deposit) " +
          'and the day so far across susu and savings.',
      },
      {
        name: 'Customer Portal',
        description:
          'Customer-facing. Phone + OTP login, own accounts and history, mobile-money ' +
          'pay-in, and withdrawal requests. Portal tokens are signed with a different key ' +
          'from staff tokens and are rejected by every staff endpoint.',
      },
      {
        name: 'Payout Requests',
        description:
          'The office side of customer withdrawal requests. Approving one EXECUTES the ' +
          'withdrawal and then sends the money by Paystack transfer.',
      },
      {
        name: 'Accounting',
        description:
          'The company own books: expenses, cash and bank accounts, the fixed-asset ' +
          'register, owner capital, and the balance sheet and profit-and-loss statements ' +
          'built from them.',
      },
      { name: 'Reports', description: 'Office reports with CSV export (format=csv)' },
      {
        name: 'Hire Purchase',
        description:
          'Inventory + agreements: 50% deposit, flat-once interest, monthly instalments, arrears, repossession with 1-month redemption, used-item restock.',
      },
      {
        name: 'Transfers',
        description: 'Atomic internal moves: susu → savings/loan/HP · savings → susu/loan/HP',
      },
      {
        name: 'Payments',
        description: 'Paystack mobile-money charges into susu, savings, loans, hire purchase',
      },
    ],
    paths: {
      ...authPaths,
      ...userPaths,
      ...customerPaths,
      ...susuPaths,
      ...savingsPaths,
      ...uploadPaths,
      ...loanPaths,
      ...reportPaths,
      ...dashboardPaths,
      ...collectorPaths,
      ...portalPaths,
      ...accountingPaths,
      ...hpPaths,
      ...transferPaths,
      ...paymentPaths,
      ...reconciliationPaths,
      ...notificationPaths,
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        // Signed with a key derived from the staff secret: a portal token can
        // never satisfy bearerAuth, and vice versa.
        portalAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
  });

  // Stamped after the fact rather than written into each module: which app can
  // call what is one cross-cutting decision, and it belongs in one file where
  // it can be read whole and checked against the routers (see audiences.ts).
  applyAudienceTags(document.paths ?? {});
  return { ...document, 'x-tagGroups': TAG_GROUPS };
}

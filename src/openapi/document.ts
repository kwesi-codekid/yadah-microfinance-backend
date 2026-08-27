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
import { hpPaths } from '../modules/hire-purchase/hp.openapi.js';
import { transferPaths } from '../modules/transfers/transfers.openapi.js';
import { paymentPaths } from '../modules/payments/payments.openapi.js';
import { reconciliationPaths } from '../modules/reconciliation/reconciliation.openapi.js';
import { notificationPaths } from '../modules/notifications/notifications.openapi.js';

/** Modules register their paths here as they land (users, customers, susu…). */
export function buildOpenApiDocument(): ReturnType<typeof createDocument> {
  return createDocument({
    openapi: '3.1.0',
    info: {
      title: 'Yadah Microfinance API',
      version: '0.1.0',
      description:
        'Susu collection, savings, and loans API for Yadah Dynamic Enterprise.\n\n' +
        '**Conventions**: JSON, camelCase fields. All money values are **integer pesewas** ' +
        '(GHS 10.50 = `1050`). Dates are ISO 8601 UTC. Errors always use the ' +
        '`{ error: { code, message, details? } }` envelope. Authenticate with ' +
        '`Authorization: Bearer <accessToken>`.',
    },
    servers: [{ url: '/api/v1' }],
    tags: [
      { name: 'Auth', description: 'Login (username+password or phone OTP), sessions' },
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
      ...hpPaths,
      ...transferPaths,
      ...paymentPaths,
      ...reconciliationPaths,
      ...notificationPaths,
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
  });
}

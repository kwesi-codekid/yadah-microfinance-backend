import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import { trashBody } from '../../schemas/common.js';
import { proposeCorrectionPathFor } from '../corrections/corrections.openapi.js';
import {
  addPlanBody,
  changePlanBody,
  depositBody,
  listAccountsQuery,
  listCyclesQuery,
  listPayoutsQuery,
  migrateBody,
  renumberBody,
  listDepositsQuery,
  listTrashQuery,
  openAccountBody,
  summaryQuery,
  updateDepositBody,
  withdrawalBody,
} from './susu.schemas.js';

const susuPlan = z
  .object({
    id: z.string(),
    accountId: z.string(),
    dailyAmount: z.number().int().describe('Pesewas. Changeable only between cycles.'),
    paidInCycle: z.number().int().describe('Payments made in the cycle in progress, 0..30'),
    cycleTarget: z.literal(31),
    cycleNumber: z
      .number()
      .int()
      .describe('The cycle in progress — or, between cycles, the one the next deposit starts'),
    cyclesCompleted: z.number().int(),
    status: z.enum(['active', 'stopped']),
    locked: z
      .number()
      .int()
      .describe('One payment’s amount while a cycle is in progress; 0 between cycles or stopped'),
    amountChangeable: z.boolean().describe('True between cycles'),
    startedAt: z.iso.datetime(),
    stoppedAt: z.iso.datetime().optional(),
    stopCommission: z
      .number()
      .int()
      .optional()
      .describe('Charged when stopped mid-cycle; 0 when stopped between cycles'),
    balance: z
      .number()
      .int()
      .optional()
      .describe(
        'What the plan holds, pesewas: its ended cycles net of commission, plus the cycle in ' +
          'progress, less withdrawals taken off it beyond the days they cost. On the account ' +
          'detail only; listings leave it out. 0 on a closed account.',
      ),
    withdrawn: z
      .number()
      .int()
      .optional()
      .describe(
        'Σ withdrawals taken off this plan, pesewas. On the account detail only; ' +
          'listings leave it out.',
      ),
  })
  .meta({ id: 'SusuPlan' });

const withdrawalLine = z.object({
  planId: z.string(),
  dailyAmount: z.number().int().describe('The plan’s amount at the time'),
  amount: z.number().int(),
  paymentsRemoved: z.number().int().describe('Whole payments this share took off the plan’s cycle'),
});

const susuPayout = z
  .object({
    id: z.string(),
    accountId: z.string(),
    amount: z.number().int(),
    kind: z
      .enum(['payout', 'withdrawal'])
      .describe('withdrawal leaves the account open; payout is the closing disbursement'),
    destination: z.enum(['cash', 'savings', 'loan', 'hire-purchase']),
    commissionAmount: z.number().int(),
    lines: z
      .array(withdrawalLine)
      .optional()
      .describe(
        'How the money was spread over the plans; absent on closing payouts and pre-plan rows',
      ),
    recordedById: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SusuPayout' });

const susuAccount = z
  .object({
    id: z.string(),
    accountNumber: z
      .string()
      .describe('The customer’s susu number, e.g. SU26090005 — one per customer, for life.'),
    customerId: z.string(),
    customerName: z.string().optional().describe('On list responses, for display'),
    balance: z.number().int().describe('Pesewas — what the account holds'),
    locked: z
      .number()
      .int()
      .describe('Σ one payment per plan mid-cycle: the part of the balance nothing may take'),
    availableToWithdraw: z.number().int().describe('balance − locked, floored at 0'),
    dailyTotal: z
      .number()
      .int()
      .describe('Σ daily amounts of the active plans — what one day’s round collects'),
    status: z.enum(['active', 'closed']),
    plans: z.array(susuPlan).describe('Active plans first, then stopped; each oldest first'),
    openedAt: z.iso.datetime(),
    closedAt: z.iso.datetime().optional(),
    closeCommission: z.number().int().optional(),
    closePayout: z.number().int().optional(),
  })
  .meta({ id: 'SusuAccount' });

const susuDepositLine = z.object({
  planId: z.string(),
  dailyAmount: z.number().int().describe('The plan’s amount at the time'),
  cycleNumber: z.number().int(),
  payments: z.number().int(),
  seqStart: z.number().int().describe('1-based position in the 31-payment cycle'),
  seqEnd: z.number().int(),
  amount: z.number().int().describe('payments × dailyAmount'),
  commissionAmount: z
    .number()
    .int()
    .describe('One payment’s amount when this line landed the 31st payment; else 0'),
  completesCycle: z.boolean(),
});

const susuDeposit = z
  .object({
    id: z.string(),
    accountId: z.string(),
    customerId: z.string(),
    collectorId: z.string().describe('User who recorded it (collector or office staff)'),
    amount: z.number().int().describe('The cash handed over, pesewas'),
    payments: z.number().int().describe('Σ lines.payments'),
    lines: z
      .array(susuDepositLine)
      .describe(
        'How the cash was credited: one line per plan, and two for a plan the deposit ' +
          'ran past its 31st payment (the second opens its next cycle)',
      ),
    leftover: z
      .number()
      .int()
      .describe('Cash beyond whole payments — stays in the balance, counts toward no plan'),
    commissionAmount: z
      .number()
      .int()
      .describe('Σ lines.commissionAmount — taken out of this deposit as cycles completed'),
    channel: z
      .enum(['cash', 'paystack', 'momo', 'transfer'])
      .describe("'transfer' = created by an internal transfer"),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SusuDeposit' });

const susuCycle = z
  .object({
    id: z.string(),
    planId: z.string(),
    accountId: z.string(),
    cycleNumber: z.number().int(),
    dailyAmount: z.number().int(),
    payments: z.number().int().describe('31 when completed; fewer when stopped mid-cycle'),
    commissionAmount: z.number().int(),
    endReason: z.enum(['completed', 'plan-stopped', 'account-closed']),
    endedAt: z.iso.datetime(),
  })
  .meta({ id: 'SusuCycle' });

const trashedSusuAccount = susuAccount.extend({
  deletedAt: z.iso.datetime(),
  deletedById: z.string().optional(),
  deleteReason: z.string().optional(),
});

const trashedSusuDeposit = susuDeposit.extend({
  deletedAt: z.iso.datetime(),
  deletedById: z.string().optional(),
  deleteReason: z.string().optional(),
});

const idParam = z.object({ id: z.string().describe('Susu account id') });
const planIdParam = z.object({
  id: z.string().describe('Susu account id'),
  planId: z.string().describe('Plan id'),
});
const depositIdParam = z.object({
  id: z.string().describe('Susu account id'),
  depositId: z.string().describe('Deposit id'),
});

const accountResult = z.object({ account: susuAccount });
const planResult = z.object({ account: susuAccount, plan: susuPlan });
const depositResult = z.object({
  deposit: susuDeposit,
  account: susuAccount,
  replayed: z.boolean().describe('True when this response replays an earlier identical request'),
});
const security = [{ bearerAuth: [] }];

function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number(),
    limit: z.number(),
    total: z.number(),
  });
}

export const susuPaths: ZodOpenApiPathsObject = {
  '/susu/accounts': {
    post: {
      tags: ['Susu'],
      summary: 'Open a customer’s susu account (counter)',
      description:
        'One account per customer, like savings: a balance holding one or more plans. ' +
        'Opens it with its first plan (min GHS 10 a day). A customer whose account was ' +
        'closed gets it reopened (200) with the new plan — same number, same history. ' +
        'A customer with an open account is refused (409 ALREADY_OPEN, details.accountId): ' +
        'add a plan to it instead.',
      security,
      requestBody: jsonBody(openAccountBody),
      responses: {
        '201': jsonResponse(
          'Opened',
          z.object({ account: susuAccount, reopened: z.literal(false) }),
        ),
        '200': jsonResponse(
          'Reopened',
          z.object({ account: susuAccount, reopened: z.literal(true) }),
        ),
        '404': errorResponse('NOT_FOUND — customer'),
        '409': errorResponse('ALREADY_OPEN (details.accountId, details.accountNumber)'),
        '422': errorResponse('CUSTOMER_INACTIVE'),
      },
    },
    get: {
      tags: ['Susu'],
      summary: 'List accounts',
      description:
        'All roles see all accounts. `search` is fuzzy: typo-tolerant customer ' +
        'name, phone, or account-number prefix. Pass format=csv or format=xlsx ' +
        'to download a spreadsheet (pagination is ignored; capped at 10,000 rows).',
      security,
      requestParams: { query: listAccountsQuery },
      responses: { '200': jsonResponse('Paginated accounts', paginated(susuAccount)) },
    },
  },
  '/susu/accounts/trash': {
    get: {
      tags: ['Susu'],
      summary: 'List trashed susu accounts (office only)',
      security,
      requestParams: { query: listTrashQuery },
      responses: {
        '200': jsonResponse('Paginated trashed accounts', paginated(trashedSusuAccount)),
        '403': errorResponse('FORBIDDEN — office only'),
      },
    },
  },
  '/susu/accounts/{id}': {
    get: {
      tags: ['Susu'],
      summary: 'Account detail with its plans',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('The account', accountResult),
        '404': errorResponse('NOT_FOUND'),
      },
    },
    delete: {
      tags: ['Susu'],
      summary: 'Move a susu account to the trash (office only)',
      description:
        'Only an account that never held money qualifies: active, zero balance, no deposit ' +
        'ever recorded. Used accounts go through close instead.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(trashBody),
      responses: {
        '200': jsonResponse('Moved to the trash', z.object({ account: trashedSusuAccount })),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '422': errorResponse(
          'CANNOT_TRASH (details.status, details.balance, details.depositRecords)',
        ),
      },
    },
  },
  '/susu/accounts/{id}/restore': {
    post: {
      tags: ['Susu'],
      summary: 'Restore a susu account from the trash (office only)',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Restored', accountResult),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_TRASHED'),
        '422': errorResponse('CANNOT_RESTORE — the customer already holds an account'),
      },
    },
  },
  '/susu/accounts/{id}/plans': {
    post: {
      tags: ['Susu'],
      summary: 'Add a plan — another daily amount on its own cycle (counter)',
      description:
        'The plan’s first cycle starts with its first deposit. Several plans run side by ' +
        'side, each counting its own 31 payments and each charging one payment’s amount ' +
        'per cycle.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(addPlanBody),
      responses: {
        '201': jsonResponse('Added', planResult),
        '404': errorResponse('NOT_FOUND'),
        '422': errorResponse('ACCOUNT_CLOSED'),
      },
    },
  },
  '/susu/accounts/{id}/plans/{planId}': {
    patch: {
      tags: ['Susu'],
      summary: 'Change a plan’s daily amount, between cycles only (counter)',
      description:
        'Allowed while paidInCycle is 0 — right after a cycle completes and before the next ' +
        'deposit. The next cycle, and its commission, run at the new amount. Mid-cycle the ' +
        'request is refused (PLAN_MID_CYCLE): stop the plan and start a new one.',
      security,
      requestParams: { path: planIdParam },
      requestBody: jsonBody(changePlanBody),
      responses: {
        '200': jsonResponse('Changed', planResult),
        '404': errorResponse('NOT_FOUND'),
        '422': errorResponse('PLAN_MID_CYCLE (details.paidInCycle), PLAN_STOPPED, ACCOUNT_CLOSED'),
      },
    },
  },
  '/susu/accounts/{id}/plans/{planId}/stop': {
    post: {
      tags: ['Susu'],
      summary: 'Stop a plan (counter)',
      description:
        'Mid-cycle this charges the plan’s one payment on the spot and records the unfinished ' +
        'cycle; between cycles it charges nothing. The money stays in the balance — stopping ' +
        'a plan moves nothing out of the account.',
      security,
      requestParams: { path: planIdParam },
      responses: {
        '200': jsonResponse('Stopped', planResult.extend({ commission: z.number().int() })),
        '404': errorResponse('NOT_FOUND'),
        '422': errorResponse('PLAN_STOPPED, ACCOUNT_CLOSED'),
      },
    },
  },
  '/susu/renumber': {
    post: {
      tags: ['Susu'],
      summary: 'Renumber this month’s susu accounts into the continuing sequence (office only)',
      description:
        'Accounts opened this month under the old monthly-restart rule are renumbered, in ' +
        'opening order, to carry on from the highest number any earlier month reached; the ' +
        'customer’s stored susu number moves with the account, and the susu counter is set so ' +
        'the next account follows. `apply: false` previews and writes nothing; `apply: true` ' +
        'writes and is audited. Susu only. One run at a time.',
      security,
      requestBody: jsonBody(renumberBody),
      responses: {
        '200': jsonResponse(
          'What changed, or would',
          z.object({
            apply: z.boolean(),
            changes: z.array(z.object({ from: z.string(), to: z.string() })),
            counter: z.number().int().describe('The next account is this plus one'),
          }),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
        '409': errorResponse('RENUMBER_RUNNING'),
      },
    },
  },
  '/susu/migrate': {
    post: {
      tags: ['Susu'],
      summary: 'Run the susu data update (admin)',
      description:
        'Turns per-cycle books into one account with plans, then gives money out that names ' +
        'no plan its shares on the plans. `apply: false` is a dry run that reports what would ' +
        'change and writes nothing; `apply: true` writes and leaves an audit entry. One run at ' +
        'a time (409 while one is running). Idempotent: a second apply finds nothing to do.',
      security,
      requestBody: jsonBody(migrateBody),
      responses: {
        '200': jsonResponse(
          'What changed, or would',
          z.object({
            apply: z.boolean(),
            migration: z.object({
              customers: z.number().int(),
              books: z.number().int(),
              plans: z.number().int(),
              deposits: z.number().int(),
              payoutsLabelled: z.number().int(),
              balanceBefore: z.number().int(),
              balanceAfter: z.number().int(),
              commissionTakenNow: z.number().int(),
            }),
            backfill: z.object({
              accounts: z.number().int(),
              payouts: z.number().int(),
              loose: z.number().int(),
            }),
            drift: z.number().int().describe('Zero when the money reconciles'),
          }),
        ),
        '403': errorResponse('FORBIDDEN — admin only'),
        '409': errorResponse('MIGRATION_RUNNING'),
      },
    },
  },
  '/susu/accounts/{id}/payouts': {
    get: {
      tags: ['Susu'],
      summary: 'Money out, newest first',
      description:
        'Withdrawals and the closing payout, each with how it was spread over the plans ' +
        '(`lines`). Pass planId to keep only the rows with a share on that plan — the other ' +
        'half of a plan’s statement.',
      security,
      requestParams: { path: idParam, query: listPayoutsQuery },
      responses: { '200': jsonResponse('Paginated payouts', paginated(susuPayout)) },
    },
  },
  '/susu/accounts/{id}/cycles': {
    get: {
      tags: ['Susu'],
      summary: 'Ended cycles, newest first',
      description:
        'The statement’s history and the commission trail: one row per cycle that ' +
        'completed, or was cut short by a plan stop or the account closing. The cycle in ' +
        'progress is on the plan itself.',
      security,
      requestParams: { path: idParam, query: listCyclesQuery },
      responses: { '200': jsonResponse('Paginated cycles', paginated(susuCycle)) },
    },
  },
  '/susu/accounts/{id}/deposits': {
    get: {
      tags: ['Susu'],
      summary: 'Deposit history (statement)',
      description:
        'Pass format=csv or format=xlsx to download a spreadsheet (pagination is ' +
        'ignored; capped at 10,000 rows).',
      security,
      requestParams: { path: idParam, query: listDepositsQuery },
      responses: { '200': jsonResponse('Deposits, newest first', paginated(susuDeposit)) },
    },
    post: {
      tags: ['Susu'],
      summary: 'Record a deposit',
      description:
        'Any collector or office staff. `amount` is the cash received (pesewas). `split` ' +
        'says how many whole payments go to each plan; omit it for one payment on every ' +
        'active plan (a collector’s daily round). Whatever the split does not use stays in ' +
        'the balance as `leftover`. A plan reaching its 31st payment completes its cycle: ' +
        'one payment’s amount is taken as commission out of this deposit, and payments ' +
        'past the 31st open the plan’s next cycle at the same amount. Requires an ' +
        'idempotency key: a retried request returns the original (200). SMS receipt sent.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(depositBody),
      responses: {
        '201': jsonResponse('Recorded', depositResult),
        '200': jsonResponse('Replay of an earlier request', depositResult),
        '409': errorResponse('CONFLICT — concurrent update, retry'),
        '422': errorResponse(
          'ACCOUNT_CLOSED, NO_ACTIVE_PLANS, or INVALID_SPLIT (details.amount, details.required) ' +
            'when the split names a plan not on the account, needs more cash than the deposit, ' +
            'pays no plan at all, or runs one plan across more than two cycles',
        ),
      },
    },
  },
  '/susu/accounts/{id}/deposits/trash': {
    get: {
      tags: ['Susu'],
      summary: 'List trashed deposits of an account (office only)',
      security,
      requestParams: { path: idParam, query: listTrashQuery },
      responses: {
        '200': jsonResponse(
          'Trashed deposits, most recently trashed first',
          paginated(trashedSusuDeposit),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/susu/accounts/{id}/deposits/{depositId}': {
    patch: {
      tags: ['Susu'],
      summary: 'Correct the most recent deposit’s amount (office only)',
      description:
        'Data-entry fixes. The deposit is un-credited and credited afresh at the new amount, ' +
        'keeping its id and date; plans and balance adjust atomically, including undoing or ' +
        'completing a cycle. Only the most recent deposit on every plan it paid qualifies. ' +
        '`split` may be omitted when the deposit paid one plan; a deposit split across plans ' +
        'needs the new split (SPLIT_REQUIRED). Transfer- and Paystack-created deposits are ' +
        'immutable. A teller asks through POST …/corrections and the office applies it.',
      security,
      requestParams: { path: depositIdParam },
      requestBody: jsonBody(updateDepositBody),
      responses: {
        '200': jsonResponse('Corrected', depositResult),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('CONFLICT — concurrent update, retry'),
        '422': errorResponse(
          'CANNOT_TRASH (not the latest / closed / transfer-created / plan stopped since), ' +
            'CANNOT_CORRECT, SPLIT_REQUIRED, or INVALID_SPLIT',
        ),
      },
    },
    delete: {
      tags: ['Susu'],
      summary: 'Move the most recent deposit to the trash (office only)',
      description:
        'Un-credits the plans (undoing any cycle it completed and refunding that commission) ' +
        'and takes the money back out of the balance — refused if it has since been withdrawn.',
      security,
      requestParams: { path: depositIdParam },
      requestBody: jsonBody(trashBody),
      responses: {
        '200': jsonResponse(
          'Moved to the trash',
          z.object({ deposit: trashedSusuDeposit, account: susuAccount }),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('CONFLICT — concurrent update, retry'),
        '422': errorResponse('CANNOT_TRASH'),
      },
    },
  },
  '/susu/accounts/{id}/deposits/{depositId}/corrections': proposeCorrectionPathFor(
    'Susu',
    'a deposit',
    depositIdParam,
  ),
  '/susu/accounts/{id}/deposits/{depositId}/restore': {
    post: {
      tags: ['Susu'],
      summary: 'Restore a trashed deposit (office only)',
      description:
        'Re-credits the deposit. Only possible while every plan it paid still stands where ' +
        'the deposit found it (nothing newer recorded since).',
      security,
      requestParams: { path: depositIdParam },
      responses: {
        '200': jsonResponse('Restored', depositResult),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_TRASHED or CONFLICT'),
        '422': errorResponse('CANNOT_RESTORE'),
      },
    },
  },
  '/susu/accounts/{id}/deposits/{depositId}/receipt': {
    get: {
      tags: ['Susu'],
      summary: 'Printable deposit receipt',
      description:
        'A4 receipt: receipt number, customer, account, the amount in a boxed headline, a ' +
        'row per plan paid, commission and leftover when any, the balance after (rebuilt from ' +
        'the ledger, so reprints match), who recorded it, and signature lines. Binary ' +
        'response (application/pdf). Available to collectors as well as the office.',
      security,
      requestParams: { path: depositIdParam },
      responses: {
        '200': {
          description: 'The receipt',
          content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
        },
        '403': errorResponse('CUSTOMER_NOT_ASSIGNED — collector reaching outside their round'),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/susu/accounts/{id}/withdrawals/{payoutId}/receipt': {
    get: {
      tags: ['Susu'],
      summary: 'Printable withdrawal or payout receipt',
      description:
        'A withdrawal that leaves the account open (no commission), or the payout that ' +
        'closed it (showing the commission for the cycles that were in progress). Binary ' +
        'response (application/pdf).',
      security,
      requestParams: {
        path: z.object({ id: z.string().describe('Susu account id'), payoutId: z.string() }),
      },
      responses: {
        '200': {
          description: 'The receipt',
          content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
        },
        '403': errorResponse('CUSTOMER_NOT_ASSIGNED — collector reaching outside their round'),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/susu/accounts/{id}/withdraw': {
    post: {
      tags: ['Susu'],
      summary: 'Withdraw from the balance, keeping the account open (counter)',
      description:
        'Like a savings withdrawal: any amount up to availableToWithdraw. No commission is ' +
        'taken — it is taken as each cycle completes — and every cycle is untouched. One ' +
        'payment’s amount per plan with a cycle in progress stays locked so that commission ' +
        'remains collectible; the same lock applies to transfers and loan repayments out of ' +
        'susu. The money walks the plans in order (running first, oldest first): each gives ' +
        'what it holds less its own lock, the rest moves to the next, and whatever no plan ' +
        'can give comes from the account’s loose money. Each plan’s share takes whole ' +
        'payments (share ÷ daily amount, rounded down) off its cycle in progress, never below ' +
        '0 of 31 and never into a completed cycle. `lines` says what came off which plan. ' +
        'Idempotent on idempotencyKey; sends an SMS.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(withdrawalBody),
      responses: {
        '201': jsonResponse(
          'Withdrawn',
          z.object({
            account: susuAccount,
            amount: z.number().int(),
            payoutId: z.string(),
            lines: z.array(withdrawalLine).describe('What came off which plan, in the order taken'),
            loose: z.number().int().describe('The part that sat on no plan'),
            replayed: z.boolean(),
          }),
        ),
        '200': jsonResponse('Replay of an earlier identical request', z.object({})),
        '403': errorResponse('FORBIDDEN — counter only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('CONFLICT — account changed concurrently, retry'),
        '422': errorResponse(
          'ACCOUNT_CLOSED, or EXCEEDS_AVAILABLE (details.available, details.balance, details.locked)',
        ),
      },
    },
  },
  '/susu/accounts/{id}/close': {
    post: {
      tags: ['Susu'],
      summary: 'Close the account and pay out (counter)',
      description:
        'The customer leaves. Every plan with a cycle in progress is stopped and charged its ' +
        'one payment; the rest of the balance is paid out in cash and recorded on the ' +
        'transactions feed. The account keeps its number and history and can be reopened ' +
        'through POST /susu/accounts.',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse(
          'Closed',
          z.object({
            account: susuAccount,
            commission: z.number().int(),
            payout: z.number().int(),
            payoutId: z.string(),
          }),
        ),
        '403': errorResponse('FORBIDDEN — counter only'),
        '409': errorResponse('ALREADY_CLOSED'),
      },
    },
  },
  '/susu/summary': {
    get: {
      tags: ['Susu'],
      summary: 'Daily collection summary (reconciliation)',
      description:
        'Deposits recorded on an Accra calendar day. Collectors see their own; ' +
        'office roles may pass collectorId or omit it for everyone.',
      security,
      requestParams: { query: summaryQuery },
      responses: {
        '200': jsonResponse(
          'Summary',
          z.object({
            date: z.string(),
            collectorId: z.string().nullable(),
            depositCount: z.number().int(),
            totalCollected: z.number().int(),
            deposits: z.array(
              z.object({
                depositId: z.string(),
                accountId: z.string(),
                customerId: z.string(),
                customerName: z.string(),
                collectorId: z.string(),
                amount: z.number().int(),
                payments: z.number().int(),
                at: z.iso.datetime(),
              }),
            ),
          }),
        ),
      },
    },
  },
};

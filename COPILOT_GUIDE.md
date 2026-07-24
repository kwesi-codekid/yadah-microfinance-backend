# LLM Copilot Guide — Yadah Microfinance API

You are assisting a backend developer at Auxiliary Network building a microfinance
management API for Yadah Dynamic Enterprise, a susu collection, savings, and loans
company in Esiama, Ghana. This file is your source of truth. When a request
conflicts with this file, flag the conflict instead of silently choosing.

## Project context

- Phase 1, backend API only. A separate frontend engineer consumes the API via a
  published OpenAPI (Scalar) contract. Never generate frontend code unless asked.
- Deadline-driven (31 Aug 2026). Prefer the simplest correct implementation.
  No speculative abstraction, no premature optimization, no extra features.
- Out of scope for Phase 1 — do not build, even if it seems helpful: customer
  portal, hire purchase, offline mode, Paystack/MoMo payment flows (only the
  `channel` field exists in schemas), AI/analytics features.

## Stack

Node.js · Express · TypeScript (strict) · Zod · Pino · MongoDB with replica set
(Mongoose) · Socket.io · smsonlinegh · Coolify on VPS
(staging + production).

## Domain glossary

- **Susu**: traditional Ghanaian daily-deposit savings. Customer commits a fixed
  amount deposited daily by a door-to-door collector over a 31-deposit cycle.
- **Commission**: the company keeps 1 day's deposit per completed-or-exited cycle.
- **Collector**: field agent who records deposits on their phone. **Admin/Manager**:
  office roles.
- **Passbook-era**: the client previously ran everything on one Excel sheet.
  SMS receipts replace paper passbooks as the customer's proof.

## Business rules — NEVER deviate without flagging

### Susu

1. Account = one cycle: fixed daily amount, 31 deposits. Principal is immutable —
   any change requires closing and opening a new account.
2. Cycle stretches on missed days: it ends at 31 deposits, not 31 calendar days.
3. Catch-up allowed: one payment may cover multiple missed days.
4. A customer may hold multiple concurrent susu accounts. "Collect-all" splits one
   cash amount across all active accounts atomically.
5. Commission = exactly 1 day's deposit per account, taken at payout, regardless of
   when the customer exits (even day 2).
6. Withdrawal closes the account. Payout = total deposits − 1 day commission.
7. Withdrawals are processed at the office only. Send SMS notification on processing.

### Savings

1. Minimum deposit GHS 10. No interest paid to customers.
2. Max 1 withdrawal per day. Flat GHS 10 fee per withdrawal, any amount.
3. Minimum balance GHS 50, withdrawable only on full closure.
4. Available-to-withdraw = balance − 50 − 10. Expose this in API responses.
5. The GHS 10 fee applies on the closing withdrawal too (200 balance → customer
   receives 190).

### Loans

1. Tiers: small 1,000–20,000 · big 20,001–50,000 (GHS).
2. Interest by chosen duration: 3 months = 10%, 6 months = 20%, 12 months = 30%.
   Flat, on principal.
3. Escalation: when overdue past its duration, the loan moves to the next tier's
   rate applied to the ORIGINAL PRINCIPAL (not outstanding balance). Past 30%
   there is no further escalation: amount freezes, loan is flagged in arrears.
4. Repayment: monthly instalments. Channels: cash, or by closing a susu account
   and applying its payout (atomic transaction across both modules).
5. Eligibility: ~4 months of susu/savings history; API provides the history
   summary, a human admin makes the decision. No auto-approval logic.
6. Graduation: only a small loan repaid ON TIME unlocks the big tier.
7. One active loan per customer. The API must always refuse a second application.
   No exception paths.

## Non-negotiable engineering rules

1. **Money is integer pesewas everywhere.** No floats, no `parseFloat`, no
   decimals in money math. GHS 10.50 = 1050. Convert only at the presentation
   boundary. If you ever write `amount * 0.1`, stop and use integer math with
   explicit rounding rules.
2. **Multi-document money moves use Mongo transactions** (sessions): collect-all,
   susu closure + payout, loan repayment via susu closure, anything touching two
   or more collections' balances. All-or-nothing, always.
3. **Every mutating money action writes an audit log entry**: actor, action,
   entity, before/after amounts, timestamp. No silent mutations.
4. **Validate every request body/query/params with Zod** at the route boundary.
   Handlers receive typed, parsed data only. Shared schemas live in one module
   (money, ObjectId, pagination, Ghanaian phone).
5. **Log with Pino, redact secrets**: passwords, tokens, and Ghana Card numbers
   must never appear in logs. Use child loggers with request IDs.
6. **RBAC on every route**: Admin, Manager, Collector. Collectors may only read
   and act on their own assigned customers. Enforce in middleware/queries, not
   in the frontend.
7. **Idempotency for money endpoints**: deposits and repayments accept an
   idempotency key so a retried mobile request can't double-record cash.
8. **SMS is fire-and-forget through a queue with retry** — a gateway failure must
   never fail or roll back the money transaction it announces. Log every send;
   count against the 3,000/month cap.
9. **No deploy to production until told the commitment payment has cleared.**
   Staging is the demo environment.

## Conventions

- REST, JSON, `camelCase` fields. Errors as `{ error: { code, message, details? } }`
  with correct HTTP statuses. Zod issues map to `details`.
- Route structure: `/api/v1/{auth|users|customers|susu|savings|loans|reports}`.
- Dates in ISO 8601 UTC; the client operates in Africa/Accra — be explicit at
  day boundaries (a "day" for the 1-withdrawal/day rule is an Accra calendar day).
- Business logic lives in service functions, thin controllers, no logic in models.
- Emit Socket.io events to the admin room on: deposit recorded, account
  opened/closed, savings txn, loan application/approval/repayment/arrears.
  Events are notifications, not sources of truth.
- Tests: money math and cycle/escalation logic get unit tests; transactions get
  integration tests against the replica set. When writing money logic, propose
  the edge-case test list before the implementation.

## Edge cases to always consider when touching money code

- Catch-up deposit that completes a cycle mid-payment.
- Collect-all where one of the accounts completes its 31st deposit.
- Withdrawal on day 1–2 of a cycle (commission still applies; payout may be tiny —
  never negative; flag if deposit total < commission).
- Savings withdrawal that would breach minimum balance including the fee.
- Two collectors or duplicate retries hitting the same account concurrently.
- Loan escalating on the exact boundary day of its duration.
- Repayment-via-susu where the payout exceeds the remaining loan balance
  (define: excess goes where? → flag for the developer to decide, do not guess).

## How to behave as copilot

- When the developer asks for code, give complete, runnable TypeScript — no
  placeholder pseudo-logic inside money paths.
- If a request contradicts a business rule above, say so before writing code.
- If a business rule is ambiguous for the case at hand, name the ambiguity and
  offer the options — never invent a rule silently. Client-facing rule changes
  are decided by the client, not by us.
- Prefer boring, explicit code over clever code. This is a ledger.
- When estimates matter, remind: schedule is at full capacity; scope additions
  cost rest days.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

This is the backend API for Yadah Dynamic Enterprise, a susu/savings/loans microfinance company in Ghana. **No code exists yet** — the repo currently holds two planning documents that are the source of truth:

- **[COPILOT_GUIDE.md](COPILOT_GUIDE.md)** — full business rules, engineering rules, conventions, and edge cases. Read it before writing any code. If a request conflicts with it, flag the conflict instead of silently choosing.
- **[Yadah_Phase1_Backend_WBS.md](Yadah_Phase1_Backend_WBS.md)** — the week-by-week task plan (23 Jul – 31 Aug 2026) with effort estimates and OpenAPI checkpoints.

Once scaffolding exists (task 1.1 in the WBS), update this file with the actual build/lint/test commands.

## Scope discipline

Phase 1 is backend-only, deadline-driven, at full schedule capacity. Prefer the simplest correct implementation. Explicitly out of scope — do not build even if helpful: frontend code, customer portal, hire purchase, offline mode, Paystack/MoMo payment flows (only the `channel` field exists in schemas), AI/analytics.

## Planned stack

Node.js · Express · TypeScript (strict) · Zod · Pino · MongoDB replica set via Mongoose (replica set required locally too, or transactions won't run) · Socket.io · smsonlinegh · Coolify deploys (staging = demo; **no production deploy until told the commitment payment has cleared**).

## Non-negotiable engineering rules (summary — full text in COPILOT_GUIDE.md)

1. **Money is integer pesewas everywhere.** No floats in money math; GHS 10.50 = 1050. Convert only at the presentation boundary.
2. **Multi-document money moves use Mongo transactions** (collect-all, susu closure + payout, loan repayment via susu closure).
3. **Every mutating money action writes an audit log entry** (actor, action, entity, before/after amounts, timestamp).
4. **Zod validation at every route boundary**; shared schemas (money, ObjectId, pagination, Ghanaian phone) live in one module.
5. **Pino logging with redaction** — passwords, tokens, Ghana Card numbers never in logs.
6. **RBAC on every route** (Admin / Manager / Collector); collectors scoped to their own customers, enforced in middleware/queries.
7. **Idempotency keys on deposits and repayments** — retried mobile requests must not double-record cash.
8. **SMS is fire-and-forget via a queue with retry** — a gateway failure never fails or rolls back the money transaction. Count sends against the 3,000/month cap.

## Key business rules (client-confirmed — never deviate without flagging)

- **Susu**: one account = one cycle of 31 fixed daily deposits; principal immutable; cycle stretches on missed days; catch-up payments allowed; commission = exactly 1 day's deposit at payout regardless of exit day; withdrawal closes the account (office-only, SMS on processing); multiple concurrent accounts allowed, "collect-all" splits cash across them atomically.
- **Savings**: min deposit GHS 10; no interest; max 1 withdrawal per Accra calendar day; flat GHS 10 fee per withdrawal (including the closing one); min balance GHS 50 withdrawable only on closure; expose `available = balance − 50 − 10`.
- **Loans**: small 1,000–20,000 / big 20,001–50,000 GHS; flat interest on principal by duration (3m = 10%, 6m = 20%, 12m = 30%); overdue escalation applies the next tier's rate to the **original principal**, frozen + flagged in arrears past 30%; monthly instalments, repayable by cash or by closing a susu account atomically; eligibility (~4 months history) is summarized by the API but decided by a human admin — no auto-approval; only an on-time-repaid small loan unlocks the big tier; **one active loan per customer, always auto-refused**.

## Conventions

- REST, JSON, `camelCase`; errors as `{ error: { code, message, details? } }` with correct HTTP statuses (Zod issues → `details`).
- Routes under `/api/v1/{auth|users|customers|susu|savings|loans|reports}`.
- Dates ISO 8601 UTC; day-boundary rules (e.g. 1 withdrawal/day) use the Africa/Accra calendar day.
- Business logic in service functions; thin controllers; no logic in Mongoose models.
- Socket.io events to the admin room on money/account events — notifications only, never sources of truth.
- The API contract is published to a frontend engineer via OpenAPI (Scalar); WBS tasks marked ⚡ are contract checkpoints — keep the spec current when endpoints change.
- Money logic: propose the edge-case test list before implementing (see the edge-case list in COPILOT_GUIDE.md). Money math gets unit tests; transactions get integration tests against the replica set.

## How to behave

- Complete, runnable TypeScript — no placeholder pseudo-logic in money paths.
- If a business rule is ambiguous for the case at hand, name the ambiguity and offer options; client-facing rule changes are the client's call, never invent one. (Known open question: repayment-via-susu where payout exceeds remaining loan balance — where does the excess go? Flag, don't guess.)
- Boring, explicit code over clever code — this is a ledger.

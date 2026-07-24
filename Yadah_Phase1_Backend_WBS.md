# Yadah Microfinance API — Phase 1 Backend Work Breakdown

**Auxiliary Network** · 23 Jul – 31 Aug 2026
**Stack:** Node.js · Express · TypeScript · Zod · Pino · MongoDB (replica set) · Socket.io · smsonlinegh · Coolify on VPS

**Legend:** `P2` = may slide into acceptance period · `TXN` = requires Mongo multi-document transaction · ⚡ = OpenAPI contract checkpoint for frontend
**Capacity:** 40 calendar days minus rest days **Sun 9 Aug** and **Sun 16 Aug** = **38 working days**. P1 load ≈ 41.75 days including a 2-day bug buffer — the plan runs at full capacity; the buffer and P2 deferrals are the contingency.

**Global rules:**

- All money stored as **integer pesewas** — no floats, ever
- Every transaction document carries `channel: "cash" | "paystack" | "momo"` — future-proofing only, no online-payment flows in Phase 1
- Every mutating money action writes to the audit log
- Nothing deploys to production until the 30% commitment payment clears

---

## Week 1 — Foundations & DevOps (23–26 Jul) — ~7.75d

- [ ] **1.1** Repo init — Express + TypeScript scaffold, strict tsconfig, ESLint/Prettier, commit hooks _(0.5d)_
- [ ] **1.2** 3-node Mongo replica set locally, env config pattern _(0.5d)_ — replica set locally too, or transactions won't run in dev
- [ ] **1.3** Coolify — staging environment + auto-deploy from `main` _(0.5d)_
- [ ] **1.4** Mongoose models — `users, customers, susuAccounts, susuDeposits, savingsAccounts, savingsTxns, loans, loanSchedules, repayments, smsLog, auditLog` _(1d)_
- [ ] **1.5** Seed script + dev fixtures _(0.5d)_
- [ ] **1.6** Auth — login, JWT access + refresh rotation, bcrypt _(1d)_
- [ ] **1.7** RBAC middleware — Admin / Manager / Collector; collectors scoped to own customers only _(1d)_
- [ ] **1.8** Audit log service + mutation middleware _(1d)_
- [ ] **1.9** 🔴 smsonlinegh — account setup, **submit sender ID registration NOW** _(0.25d)_ — approval takes days; this unblocks Week 4
- [ ] **1.10** ⚡ Scalar/OpenAPI pipeline set up; publish **auth + users** spec _(0.5d)_
- [ ] **1.11** Zod — validation middleware pattern + shared schemas (money, IDs, pagination, phone) _(0.5d)_ — per-endpoint schemas live inside each endpoint task; schemas can also feed the OpenAPI spec
- [ ] **1.12** Pino — structured logger, HTTP request logging, sensitive-field redaction, error serializer _(0.5d)_ — redact passwords, tokens, Ghana Card numbers

## Week 2 — Users & Customers (27 Jul – 2 Aug) — ~5.25d

- [ ] **2.1** User CRUD + role assignment endpoints _(1d)_
- [ ] **2.2** `P2` Password change / reset flow _(0.5d)_
- [ ] **2.3** Customer CRUD — Ghana Card no., contacts, status _(1d)_
- [ ] **2.4** Customer photo upload — multer + disk/S3-compatible storage _(0.5d)_
- [ ] **2.5** Zone / collector assignment + reassignment _(0.5d)_
- [ ] **2.6** Customer search & filters — text index, pagination _(0.5d)_
- [ ] **2.7** Socket.io — server setup, JWT handshake, admin room _(1d)_ — scoped to the live admin dashboard only
- [ ] **2.8** ⚡ Publish OpenAPI — **customers** module _(0.25d)_

## Week 3 — Susu Module (3–8 Aug · rest Sun 9) — ~7.5d

- [ ] **3.1** Open susu account — fixed daily amount, immutable principal, multiple concurrent accounts per customer _(1d)_
- [ ] **3.2** Deposit endpoint — single day + multi-day catch-up _(1d)_ — cycle stretches until 31 deposits complete
- [ ] **3.3** `TXN` Collect-all — one cash amount split across all active accounts, all-or-nothing _(1.5d)_
- [ ] **3.4** Cycle engine — deposit count, completion detection, stretch on misses _(1d)_
- [ ] **3.5** Commission — 1 day's deposit per cycle, applied at payout regardless of exit day _(0.5d)_
- [ ] **3.6** `TXN` Withdrawal = closure — payout calc, office-processed _(1d)_
- [ ] **3.7** Collector daily summary endpoint (reconciliation) _(0.5d)_
- [ ] **3.8** Socket events — deposit recorded, account opened/closed _(0.25d)_
- [ ] **3.9** SMS receipts — itemized per account on deposit _(0.5d)_ — falls back to log-only until sender ID approved
- [ ] **3.10** ⚡ Publish OpenAPI — **susu** module _(0.25d)_

## Week 4 — SMS Service & Savings (10–15 Aug · rest Sun 16) — ~4.75d

- [ ] **4.1** SMS service — smsonlinegh client, templates, send queue with retry, delivery log _(1d)_
- [ ] **4.2** Monthly SMS counter vs 3,000 cap + admin alert _(0.5d)_ — protects the service-fee margin
- [ ] **4.3** Savings — open account + deposit (min GHS 10) _(0.5d)_
- [ ] **4.4** Savings withdrawal — 1/day rule, GHS 10 flat fee, min balance 50, `available = balance − 50 − 10` _(1d)_
- [ ] **4.5** Savings closure — fee applies to final payout _(0.5d)_
- [ ] **4.6** Transaction history + statement endpoint _(0.5d)_
- [ ] **4.7** Withdrawal-processed SMS notification _(0.25d)_
- [ ] **4.8** Socket events — savings transactions _(0.25d)_
- [ ] **4.9** ⚡ Publish OpenAPI — **savings + SMS admin** _(0.25d)_

_Lightest week by design — slack here absorbs susu overrun or SMS gateway delays._

## Week 5 — Loans Module (17–23 Aug) — ~8d

- [ ] **5.1** Loan config endpoints — tiers (1,000–20,000 / 20,001–50,000), rates 10/20/30, durations, admin-editable _(0.5d)_
- [ ] **5.2** Eligibility summary — aggregation of customer's susu/savings history for admin review _(1d)_ — admin decides; no hard auto-rule
- [ ] **5.3** Application + admin approval workflow; auto-block second active loan _(1.5d)_
- [ ] **5.4** Graduation rule — on-time-repaid small loan unlocks big tier _(0.5d)_
- [ ] **5.5** Repayment schedule generation — monthly instalments _(1d)_
- [ ] **5.6** `TXN` Repayment recording — cash; and via susu closure applying payout atomically _(1.5d)_
- [ ] **5.7** Overdue daily cron — tier escalation on **original principal**, freeze past 30%, arrears flags _(1.5d)_
- [ ] **5.8** Socket events — application, approval, repayment, arrears _(0.25d)_
- [ ] **5.9** ⚡ Publish OpenAPI — **loans** module _(0.25d)_

_Heaviest week — protect it. Nothing else gets scheduled here._

## Week 6 — Reports, Ops, Testing & Demo (24–31 Aug) — ~11d incl. buffer

**Reports & Ops**

- [ ] **6.1** Dashboard metrics endpoint + live socket feed — daily collections, cash position, active accounts _(1d)_ — the demo money-shot
- [ ] **6.2** `P2` Reports — collections by collector, outstanding loans, arrears/aging, commission earned _(1.5d)_
- [ ] **6.3** `P2` CSV export _(0.5d)_
- [ ] **6.4** Backups — mongodump cron, off-VPS storage, **restore test performed once** _(1d)_ — promised in the Service & Ops document
- [ ] **6.5** Production environment in Coolify + deploy script — **held until 30% payment clears** _(0.5d)_

**Testing & Demo**

- [ ] **7.1** Money-math unit tests — commission, fees, escalation, catch-up, payout edge cases _(2d)_
- [ ] **7.2** Transaction integration tests — collect-all, loan-via-susu-closure, concurrent deposits _(1d)_
- [ ] **7.3** End-to-end UAT run on staging with realistic seed data _(1d)_
- [ ] **7.4** Bug-fix buffer _(2d)_ — contingency; also absorbs overrun from earlier weeks
- [ ] **7.5** Demo dataset + demo script — **end on a live SMS landing in the room** _(0.5d)_ — the demo triggers the 30% payment

---

## Business rules quick reference (client-confirmed)

| Rule            | Decision                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------- |
| Susu cycle      | 31 deposits; stretches on missed days; catch-up allowed                                   |
| Susu commission | 1 day's deposit per cycle, at payout, regardless of exit day                              |
| Susu principal  | Immutable; withdrawal closes the account; multiple concurrent accounts allowed            |
| Withdrawals     | Office only; SMS notification on processing                                               |
| Savings         | Min deposit 10 · 1 withdrawal/day · flat 10 fee · min balance 50 · fee applies on closure |
| Loan tiers      | Small 1,000–20,000 · Big 20,001–50,000 · 10%/3m · 20%/6m · 30%/12m                        |
| Escalation      | Overdue → next tier rate on original principal; frozen + flagged past 30%                 |
| Graduation      | On-time-repaid small loan unlocks big; one active loan, always auto-refused               |
| Repayment       | Monthly; cash, or via susu closure payout                                                 |
| Eligibility     | ~4 months history, admin reviews and decides                                              |

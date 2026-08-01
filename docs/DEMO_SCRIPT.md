# Demo script (WBS 7.5)

Goal: walk the client through their own business running on the system, and
**end on a live SMS landing on a phone in the room**. Total time ~15 minutes.

## Before the demo (day before)

1. Seed: `npx tsx src/scripts/seed-demo.ts --wipe && npx tsx src/scripts/seed-demo.ts`
2. Confirm the phone with **0594213496** will be in the room, charged, with signal.
3. Log in once as `demo.manager` / `demo-pass-2026` to verify.
4. Open the Scalar docs (`/api/v1/docs`) in a tab — useful if technical questions come up.

## The walk-through

**1. "This is your office" (2 min)**
Log in as `demo.manager`. Show the customer list — two dozen familiar-sounding
names, photos, Ghana Cards. Open Esi Mensah: full profile from the paper form,
ID front/back images.

**2. "This is a collection day" (3 min)**
Show Esi's susu account: GHS 20/day, day 20 of 31, GHS 400 saved. Record
today's deposit — **her phone buzzes with the receipt SMS right there**:
"GHS 20.00 received on susu acct NNNNNN. Progress: 21/31."
Mention: the receipt _is_ the passbook now; catch-up days work the same way.

**3. "Savings, with the rules you gave us" (2 min)**
Esi's savings: balance GHS 1,500, available shows GHS 940 (min 50 + fee 10
reserved — their rule, enforced by the system, not by memory). Process a small
withdrawal — second SMS lands. Try a second withdrawal: refused, one per day.

**4. "Loans that follow your rules" (4 min)**
Open the loans list: one pending (decide it live — show the eligibility
summary and approve; approval SMS lands), one on track, one repaid on time
(point out the big-tier unlock), one **in arrears** — show the escalated rate
on the original principal, frozen exactly at 30%, on the aging report.

**5. "You can see everything" (2 min)**
Reports: today's collections by collector (including the deposit just taken),
commission earned this month, outstanding loans. Download one as CSV, open it
in Excel — the language the office already speaks.

**6. Close (1 min)**
Audit trail: show that every money movement recorded today has an entry —
who, what, before/after amounts, when. Nothing is silent.

> The demo triggers the 30% commitment payment (WBS). Production deploys only
> after that payment clears — the standing rule.

## Reset between rehearsals

`npx tsx src/scripts/seed-demo.ts --wipe && npx tsx src/scripts/seed-demo.ts`

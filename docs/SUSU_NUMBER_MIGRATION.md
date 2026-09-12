# Per-customer susu numbers — production runbook

One-time. Moves susu account numbers from one-per-account to **one per
customer**, with their books separated by month inside it, as the branch's
paper passbooks work (client decision, 12 Sep 2026). Two books opened for one
customer in one month end up carrying the same number, byte for byte.

Read [the script's own header](../src/scripts/migrate-susu-customer-numbers.ts)
before running anything.

## Why the order is forced

`susu-accounts.accountNumber` carried a **unique** index. Duplicates are now
legitimate, so it has to go — and mongoose never drops an index on its own
(`autoIndex` only ever creates), so the schema change alone leaves production
still enforcing uniqueness.

|              | old unique index                                        | after migration                       |
| ------------ | ------------------------------------------------------- | ------------------------------------- |
| **old code** | today                                                   | fine — it mints unique numbers anyway |
| **new code** | **breaks**: second book in a month → 500 at the counter | target                                |

So the migration runs **first**, and it is safe to run while the old code is
still serving. There is no window in which new code meets the old index.

## Where you run it from

**Your laptop**, against the production URI. `tsx` is a devDependency, so the
Nixpacks container has no way to run a `.ts` script. Override the URI for the
one command rather than editing `.env` — an `.env` you forget to change back is
how a dev migration becomes a production one.

Overriding on the command line genuinely works: `src/config/env.ts` uses
`import 'dotenv/config'`, and dotenv does not overwrite a variable already set
in the environment, so your `MONGO_URI=` wins over the `.env` beside it.

The script also prints the database it connected to. **Read that line every
time before letting it continue.** It is the last guard between you and the
wrong database.

**On Windows:** the inline form below is Git Bash. In PowerShell use
`$env:MONGO_URI='...'`, run the command, then `Remove-Item Env:MONGO_URI` —
PowerShell has no inline env-var prefix, and a variable left set in a shell you
keep using is the same foot-gun as an edited `.env`.

```
[16:28:17] INFO: mongodb connected {"dbName":"yadah-dev"}
```

## Steps

### 0. Confirm what you are pointed at

```bash
cd backend
export PROD_URI='mongodb://USER:PASS@HOST:PORT/PRODDB?authSource=admin'
MONGO_URI="$PROD_URI" npx tsx src/scripts/migrate-susu-customer-numbers.ts --dry-run
```

Writes nothing. Check the `dbName` line, then read the report:

```
accountNumber_1: WOULD BE DROPPED (is unique)
customers: N (N numbers to claim) · accounts: M to rewrite, K already correct
  SU26090005     -> SU26090004      (kept as issuedNumber)
  SU26090008-SEP -> SU26090004-SEP  (kept as issuedNumber)
```

**Stop if** you see `BLOCKED: n stem(s) claimed by more than one customer`.
That is the guard refusing to build a unique index it would violate. Send the
output to whoever owns the change; do not force past it.

### 1. Back up

On the VPS, using the proven path (see [BACKUPS.md](./BACKUPS.md)):

```bash
. /opt/yadah-backup/env
/opt/yadah-backup/backup.sh
ls -lh /var/backups/yadah/          # confirm a fresh, non-trivial archive
```

`backup.sh` fails loudly on a suspiciously small archive, so a silently-empty
dump cannot masquerade as a good one. Note the archive name — step 7 needs it.

### 2. Migrate

Old code still serving. This is the only step that touches data.

```bash
MONGO_URI="$PROD_URI" npx tsx src/scripts/migrate-susu-customer-numbers.ts
```

```
accountNumber_1: dropped (was unique)
customers: N (N numbers claimed) · accounts: M rewritten, K already correct
indexes synced
```

### 3. Run it again — the idempotence check

```bash
MONGO_URI="$PROD_URI" npx tsx src/scripts/migrate-susu-customer-numbers.ts
```

```
accountNumber_1: absent
customers: N (0 numbers claimed) · accounts: 0 rewritten, N+M already correct
```

**`0 rewritten, 0 claimed` or stop.** Step 6 depends on this being a true
no-op; if a second run rewrites anything, the stem it picks is not stable and
the same instability will bite between steps 2 and 5.

### 4. Deploy the backend

Coolify → redeploy the API. Backend before frontend: an old frontend simply
ignores the new `ref` field, but a new frontend against an old API renders
`undefined` in the customer portal's option labels.

### 5. Deploy the frontend

Coolify → redeploy the web app.

> **Keep steps 2–5 tight, ideally before the branch opens.** In that window the
> branch sees collapsed numbers on the _old_ frontend, which has no ref column —
> so two of a customer's rows look identical with nothing to tell them apart.
> Harmless to the data, confusing at the counter.

### 6. Sweep

```bash
MONGO_URI="$PROD_URI" npx tsx src/scripts/migrate-susu-customer-numbers.ts
```

Collapses any book the **old** code minted between steps 2 and 4. Expect
`0 rewritten` if nothing was opened in the window; anything it does rewrite
here is correct and expected.

### 7. Verify

```bash
mongosh "$PROD_URI"
```

```js
// accountNumber_1 present, and NOT unique. Present matters as much as
// non-unique: without it every account-number search is a collection scan.
db['susu-accounts'].getIndexes();
// susuNumber_1 unique + sparse — the one uniqueness the scheme still has.
db.customers.getIndexes();

// A customer with more than one book: same number, different _id.
db['susu-accounts'].aggregate([
  { $group: { _id: '$customerId', n: { $sum: 1 }, numbers: { $addToSet: '$accountNumber' } } },
  { $match: { n: { $gt: 1 } } },
  { $limit: 5 },
]);
```

Then in the app:

1. A customer with two books in one month shows **one number on both rows**,
   with a different ref under each name.
2. **Open a second susu book for a customer this month** — same number, no
   error. This is the operation that would have 500'd before step 2.
3. Search that number in the susu book — returns the customer's whole family.
4. Search an `issuedNumber` from before the migration — still finds the book.
   That is the promise to customers holding old receipts.

## Rollback

Every original number is preserved in `issuedNumber`, so the collapse undoes
without a restore:

```js
// In mongosh, against the production URI.
db['susu-accounts']
  .find({ issuedNumber: { $exists: true } })
  .forEach((a) =>
    db['susu-accounts'].updateOne(
      { _id: a._id },
      { $set: { accountNumber: a.issuedNumber }, $unset: { issuedNumber: '' } },
    ),
  );
db.customers.updateMany({}, { $unset: { susuNumber: '' } });
```

Then redeploy the previous backend and frontend. The unique index is rebuilt
by the old schema's `autoIndex` on boot — but only if no duplicates remain, so
run the undo **before** redeploying.

Restoring the step-1 archive is the heavier alternative and loses everything
written since:

```bash
mongorestore --uri="$BACKUP_MONGO_URI" --archive=<archive.gz> --gzip --drop
```

## Tell the branch

Two things staff notice on the morning after:

- Some customers' account numbers **change** to match their first book. Nothing
  is lost — the old number is still on the record and still searchable.
- There is a new muted **ref** under each customer's name. That is what to
  quote to support when two rows look the same.

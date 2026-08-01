# Backups & Restore — Yadah Microfinance API

Nightly automated MongoDB backups, stored on the VPS **and** off-VPS, with a
proven restore path. Promised in the Service & Ops document (WBS 6.4).

The scripts live in [`ops/backup/`](../ops/backup/):
`backup.sh` (nightly dump + ship + prune) and `restore-test.sh` (proof of
restorability). They run **on the VPS via cron** — the app container is built
by Nixpacks and has no `mongodump`.

## What is backed up

| Data                                                            | Where it lives        | Covered by                  |
| --------------------------------------------------------------- | --------------------- | --------------------------- |
| All money records (accounts, deposits, txns, loans, repayments) | MongoDB               | ✅ these backups            |
| Users, customers, audit logs                                    | MongoDB               | ✅ these backups            |
| Customer photos + ID scans                                      | Cloudinary            | Cloudinary's own redundancy |
| SMS delivery history                                            | smsonlinegh dashboard | their platform              |

One archive per database per night. If staging and production use different
databases, add one cron line per database.

## Schedule & retention

- **02:30 UTC nightly** (Ghana is UTC+0, so 02:30 Accra — quietest hour)
- **7 days** of archives kept on the VPS (`/var/backups/yadah`)
- **30 days** kept off-VPS (rclone remote)
- `backup.sh` fails loudly if the archive is suspiciously small (<10 KB), so
  a silently-empty dump can't masquerade as a good backup

## One-time setup (VPS)

```bash
sudo apt-get install -y mongodb-database-tools rclone
rclone config          # create a remote — e.g. Backblaze B2 named "yadah"

sudo mkdir -p /opt/yadah-backup /var/backups/yadah
sudo cp ops/backup/backup.sh ops/backup/restore-test.sh /opt/yadah-backup/
sudo chmod +x /opt/yadah-backup/*.sh

sudo tee /opt/yadah-backup/env >/dev/null <<'EOF'
BACKUP_MONGO_URI=mongodb://USER:PASS@HOST:PORT/DBNAME?authSource=admin
RCLONE_REMOTE=yadah:backups
EOF
sudo chmod 600 /opt/yadah-backup/env

sudo tee /etc/cron.d/yadah-backup >/dev/null <<'EOF'
30 2 * * * root . /opt/yadah-backup/env && /opt/yadah-backup/backup.sh >> /var/log/yadah-backup.log 2>&1
EOF
```

Off-VPS destination options (pick one during `rclone config`):
**Backblaze B2** (10 GB free — recommended), any S3-compatible bucket
(R2 / Spaces / AWS), or another server over SFTP.

## The restore test — run once now, and after any Mongo upgrade

A backup that has never been restored is a hope, not a backup.

```bash
. /opt/yadah-backup/env
/opt/yadah-backup/backup.sh
/opt/yadah-backup/restore-test.sh /var/backups/yadah/yadah-<stamp>.archive.gz <dbname>
```

The test restores into a **throwaway database name** (it can never touch the
live one), prints per-collection document counts for eyeball comparison, then
drops the scratch database. Ends with `OK — the archive restores cleanly`.

Record the date of the last successful restore test here:

| Date      | Archive tested | Tested by |
| --------- | -------------- | --------- |
| _pending_ |                |           |

## Real disaster recovery

1. **Stop and think.** `mongorestore --drop` overwrites the target database.
2. Fetch the newest archive (local `/var/backups/yadah` or
   `rclone copy yadah:backups/<file> .`).
3. Restore:
   ```bash
   mongorestore --uri="$BACKUP_MONGO_URI" --archive=<archive.gz> --gzip --drop
   ```
4. Redeploy/restart the app in Coolify so sockets and background workers
   start clean.
5. Expected losses: anything written after the archive's timestamp (≤24 h).
   SMS logs TTL-expire on their own; queued SMS from before the incident may
   re-send or be marked stale — both harmless.

## Monitoring

Check `/var/log/yadah-backup.log` occasionally (or after any VPS change).
Every run ends with either `done: <archive>` or an error — a silent log means
cron itself stopped, which is also a failure.

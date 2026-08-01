# Backups — runbook (WBS 6.4)

Nightly `mongodump` on the VPS, compressed, copied off-VPS, with retention
and a **tested restore path**. The app container (Nixpacks) has no mongodump,
so this runs on the VPS itself via cron.

## One-time setup (on the VPS, as root or a backup user)

1. **Install MongoDB database tools + rclone**

   ```bash
   sudo apt-get install -y mongodb-database-tools rclone
   ```

2. **Configure the off-VPS destination** (pick one, then `rclone config`):
   - Backblaze B2 — 10 GB free, cheapest paid tier after that
   - Any S3-compatible bucket (AWS, DigitalOcean Spaces, Cloudflare R2)
   - Another server via SFTP

   Name the remote e.g. `yadah`, then the value below is `yadah:backups`.

3. **Install the scripts + environment**

   ```bash
   sudo mkdir -p /opt/yadah-backup /var/backups/yadah
   sudo cp backup.sh restore-test.sh /opt/yadah-backup/
   sudo chmod +x /opt/yadah-backup/*.sh
   sudo tee /opt/yadah-backup/env >/dev/null <<'EOF'
   BACKUP_MONGO_URI=mongodb://USER:PASS@HOST:PORT/DBNAME?authSource=admin
   RCLONE_REMOTE=yadah:backups
   EOF
   sudo chmod 600 /opt/yadah-backup/env
   ```

4. **Cron — nightly at 02:30 UTC (= 02:30 Accra)**

   ```bash
   sudo tee /etc/cron.d/yadah-backup >/dev/null <<'EOF'
   30 2 * * * root . /opt/yadah-backup/env && /opt/yadah-backup/backup.sh >> /var/log/yadah-backup.log 2>&1
   EOF
   ```

## The restore test (do this once now, and after any Mongo upgrade)

```bash
. /opt/yadah-backup/env
/opt/yadah-backup/backup.sh                                   # produce a fresh archive
/opt/yadah-backup/restore-test.sh /var/backups/yadah/yadah-<stamp>.archive.gz <dbname>
```

`restore-test.sh` restores into a throwaway database name (never the live
one), prints per-collection document counts for eyeball verification, then
drops the scratch database. If it prints `OK`, the backup is real.

## Restoring for real (disaster recovery)

```bash
# THINK FIRST. This overwrites the target database.
mongorestore --uri="$BACKUP_MONGO_URI" --archive=<archive.gz> --gzip --drop
```

Restore the most recent archive; SMS logs TTL-expire and re-queue harmlessly.
After restoring, redeploy/restart the app so in-memory state (sockets,
workers) starts clean.

## What is NOT covered

- **Customer images** live on Cloudinary (their redundancy, not ours).
- The **staging/dev distinction**: point `BACKUP_MONGO_URI` at each database
  you care about (one cron line per database is fine).

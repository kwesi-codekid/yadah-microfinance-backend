# Backup scripts

Full documentation lives in [`docs/BACKUPS.md`](../../docs/BACKUPS.md) —
setup, schedule, retention, the restore test, and disaster recovery.

- `backup.sh` — nightly mongodump → gzip → off-VPS via rclone, with retention
  pruning. Configure via `BACKUP_MONGO_URI`, `RCLONE_REMOTE`.
- `restore-test.sh <archive.gz> [source-db]` — restores into a throwaway
  database and prints collection counts; never touches a live database.

Both run on the VPS (cron), not in the app container.

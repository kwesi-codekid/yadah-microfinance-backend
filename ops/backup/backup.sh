#!/usr/bin/env bash
# Nightly MongoDB backup: mongodump → gzip archive → off-VPS via rclone.
# Install on the VPS (NOT inside the app container — it has no mongodump).
# See README.md in this directory for setup + cron instructions.
set -euo pipefail

# ---- configuration (override via environment or edit here) ----
MONGO_URI="${BACKUP_MONGO_URI:?set BACKUP_MONGO_URI (mongodb://user:pass@host:port/dbname?authSource=admin)}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/yadah}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"           # e.g. "b2:yadah-backups" — empty = local only
RETENTION_DAYS_LOCAL="${RETENTION_DAYS_LOCAL:-7}"
RETENTION_DAYS_REMOTE="${RETENTION_DAYS_REMOTE:-30}"
# ---------------------------------------------------------------

STAMP="$(date -u +%Y%m%d-%H%M%S)"
ARCHIVE="${BACKUP_DIR}/yadah-${STAMP}.archive.gz"

mkdir -p "${BACKUP_DIR}"

echo "[backup] dumping to ${ARCHIVE}"
mongodump --uri="${MONGO_URI}" --archive="${ARCHIVE}" --gzip

# Sanity: refuse to keep a suspiciously small archive (empty dump ≈ <10KB)
SIZE=$(stat -c%s "${ARCHIVE}")
if [ "${SIZE}" -lt 10240 ]; then
  echo "[backup] ERROR: archive is only ${SIZE} bytes — treating as failure" >&2
  exit 1
fi
echo "[backup] archive size: ${SIZE} bytes"

if [ -n "${RCLONE_REMOTE}" ]; then
  echo "[backup] pushing off-VPS to ${RCLONE_REMOTE}"
  rclone copy "${ARCHIVE}" "${RCLONE_REMOTE}/" --no-traverse
  echo "[backup] pruning remote copies older than ${RETENTION_DAYS_REMOTE} days"
  rclone delete "${RCLONE_REMOTE}/" --min-age "${RETENTION_DAYS_REMOTE}d" || true
else
  echo "[backup] WARNING: RCLONE_REMOTE not set — backup exists on this VPS only" >&2
fi

echo "[backup] pruning local copies older than ${RETENTION_DAYS_LOCAL} days"
find "${BACKUP_DIR}" -name 'yadah-*.archive.gz' -mtime "+${RETENTION_DAYS_LOCAL}" -delete

echo "[backup] done: ${ARCHIVE}"

#!/usr/bin/env bash
# Restore test: restores an archive into a SCRATCH database name and counts
# documents, proving the backup is actually restorable (the ops promise).
# NEVER restores over a live database — the target name is always remapped.
set -euo pipefail

ARCHIVE="${1:?usage: restore-test.sh <archive.gz> [source-db] }"
SOURCE_DB="${2:-yadah-dev}"
MONGO_URI="${BACKUP_MONGO_URI:?set BACKUP_MONGO_URI}"
SCRATCH_DB="restore-test-$(date -u +%Y%m%d%H%M%S)"

echo "[restore-test] restoring ${SOURCE_DB} from ${ARCHIVE} into ${SCRATCH_DB}"
mongorestore --uri="${MONGO_URI}" --archive="${ARCHIVE}" --gzip \
  --nsFrom="${SOURCE_DB}.*" --nsTo="${SCRATCH_DB}.*" --drop

echo "[restore-test] collection counts in ${SCRATCH_DB}:"
mongosh "${MONGO_URI}" --quiet --eval "
  const db2 = db.getSiblingDB('${SCRATCH_DB}');
  for (const c of db2.getCollectionNames().sort()) {
    print(c + ': ' + db2.getCollection(c).countDocuments());
  }
"

echo "[restore-test] dropping scratch database ${SCRATCH_DB}"
mongosh "${MONGO_URI}" --quiet --eval "db.getSiblingDB('${SCRATCH_DB}').dropDatabase()"
echo "[restore-test] OK — the archive restores cleanly"

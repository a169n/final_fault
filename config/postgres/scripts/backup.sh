#!/bin/bash
# Backup sidecar (H7). Every BACKUP_INTERVAL_S seconds: pg_dump the database in custom format, check
# that the archive is readable, write its SHA-256 next to it and record it in latest.json.
# The dump is taken from the current primary; if there is none, from the standby (pg_dump works on a
# hot standby), so a backup is still taken while the database is failed over or read-only.
# Connects as `backup` (pg_read_all_data: read-only). Restore is an operator action: npm run db:restore.
# BACKUP_ENABLED=0 (baseline, midterm, endterm): the sidecar idles, so those modes have no backups.
set -uo pipefail

DIR=/backups
INTERVAL=${BACKUP_INTERVAL_S:-15}
KEEP=${BACKUP_KEEP:-20}
HOSTS=${DB_HOSTS:-postgres-primary postgres-replica}

if [ "${BACKUP_ENABLED:-0}" != 1 ]; then
  echo "backup.sh: backups are disabled in this mode"
  rm -f "$DIR/latest.json"       # a stale file from an earlier mode must not look like a live backup
  exec sleep infinity
fi

export PGPASSWORD=$BACKUP_DB_PASSWORD PGCONNECT_TIMEOUT=2
mkdir -p "$DIR"

pick_host() {
  for h in $HOSTS; do
    [ "$(psql -h "$h" -U backup -d university -tAc 'select pg_is_in_recovery()' 2>/dev/null)" = f ] && { echo "$h"; return; }
  done
  for h in $HOSTS; do
    psql -h "$h" -U backup -d university -tAc 'select 1' >/dev/null 2>&1 && { echo "$h"; return; }
  done
}

while true; do
  host=$(pick_host)
  if [ -z "$host" ]; then
    echo "backup.sh: no database node reachable, skipping this cycle"
  else
    started_ms=$(date +%s%3N)
    file="university-$(date -u +%Y%m%dT%H%M%S)-${started_ms}.dump"
    if pg_dump -h "$host" -U backup -d university -Fc -f "$DIR/$file.tmp" \
       && pg_restore --list "$DIR/$file.tmp" >/dev/null; then
      mv "$DIR/$file.tmp" "$DIR/$file"
      sha=$(sha256sum "$DIR/$file" | cut -d' ' -f1)
      echo "$sha  $file" > "$DIR/$file.sha256"
      finished_ms=$(date +%s%3N)
      size=$(stat -c %s "$DIR/$file")
      printf '{"file":"%s","sha256":"%s","startedMs":%s,"finishedMs":%s,"sizeBytes":%s,"source":"%s"}\n' \
        "$file" "$sha" "$started_ms" "$finished_ms" "$size" "$host" > "$DIR/latest.json.tmp"
      mv "$DIR/latest.json.tmp" "$DIR/latest.json"
      echo "backup.sh: $file from $host, $size bytes, $((finished_ms - started_ms)) ms"
      ls -1t "$DIR"/university-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
        rm -f "$old" "$old.sha256"
      done
    else
      rm -f "$DIR/$file.tmp"
      echo "backup.sh: pg_dump from $host FAILED"
    fi
  fi
  sleep "$INTERVAL"
done

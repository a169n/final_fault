#!/bin/bash
# Database roles, created from .env on first initialisation of the primary's volume (Task 4, Task 12).
# No password is ever committed: every one comes from the generated, git-ignored .env.
#   app_rw:  the application role every service connects as (DATABASE_URL, DATABASE_REPLICA_URL).
#            Its table privileges are granted in 90-grants.sql, after the tables exist:
#            SELECT/INSERT/UPDATE on the business tables, SELECT on reference data, no DELETE,
#            TRUNCATE or DDL (THREAT-MODEL.md B4.T2).
#   repl:    physical replication only (pg_basebackup and streaming by postgres-replica).
#   monitor: read-only statistics for postgres-exporter (pg_monitor), no table access.
#   failover: the database controller (app/services/db_controller.py). It may promote a standby,
#            fence a stale primary (read-only) and switch synchronous replication, and nothing
#            else: no table access. Its rights are granted in 90-grants.sql.
#   backup:  the backup sidecar (config/postgres/scripts/backup.sh). Read-only on all data
#            (pg_read_all_data), so it can run pg_dump and cannot change anything.
# The superuser "postgres" (POSTGRES_PASSWORD) is for the operator only, over docker exec.
set -euo pipefail

for var in APP_DB_PASSWORD REPL_PASSWORD MONITOR_DB_PASSWORD FAILOVER_DB_PASSWORD BACKUP_DB_PASSWORD; do
  if [ -z "${!var:-}" ]; then
    echo "00-roles.sh: $var is empty; run npm run up:<mode> to generate .env" >&2
    exit 1
  fi
done

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v app_pw="$APP_DB_PASSWORD" -v repl_pw="$REPL_PASSWORD" -v monitor_pw="$MONITOR_DB_PASSWORD" \
     -v failover_pw="$FAILOVER_DB_PASSWORD" -v backup_pw="$BACKUP_DB_PASSWORD" <<'SQL'
CREATE ROLE app_rw WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_pw';
CREATE ROLE repl WITH LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'repl_pw';
CREATE ROLE monitor WITH LOGIN PASSWORD :'monitor_pw';
GRANT pg_monitor TO monitor;
CREATE ROLE failover WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'failover_pw';
GRANT pg_monitor TO failover;
CREATE ROLE backup WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'backup_pw';
GRANT pg_read_all_data TO backup;
SQL

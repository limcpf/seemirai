#!/usr/bin/env bash
set -euo pipefail

: "${SEEMIRAI_DATABASE_URL:?SEEMIRAI_DATABASE_URL is required}"
: "${SEEMIRAI_RESTORE_DATABASE_URL:?SEEMIRAI_RESTORE_DATABASE_URL is required}"

backup_file="${SEEMIRAI_BACKUP_FILE:-.local/backups/seemirai-$(date -u +%Y%m%dT%H%M%SZ).dump}"

mkdir -p "$(dirname "$backup_file")"

database_identity() {
  psql "$1" \
    -v ON_ERROR_STOP=1 \
    --no-align \
    --tuples-only \
    -c "SELECT concat(current_setting('data_directory'), ':', current_setting('port'), '/', oid, '/', datname) FROM pg_database WHERE datname = current_database();"
}

if [ "$SEEMIRAI_DATABASE_URL" = "$SEEMIRAI_RESTORE_DATABASE_URL" ]; then
  printf 'Refusing to restore into the source database: connection strings are identical\n' >&2
  exit 2
fi

source_identity="$(database_identity "$SEEMIRAI_DATABASE_URL")"
restore_identity="$(database_identity "$SEEMIRAI_RESTORE_DATABASE_URL")"

if [ "$source_identity" = "$restore_identity" ]; then
  printf 'Refusing to restore into the source database: %s\n' "$source_identity" >&2
  exit 2
fi

restore_prepared=0

finish_timescaledb_restore() {
  if [ "$restore_prepared" = "1" ]; then
    psql "$SEEMIRAI_RESTORE_DATABASE_URL" \
      -v ON_ERROR_STOP=1 \
      -c "SELECT timescaledb_post_restore();" >/dev/null || true
  fi
}

trap finish_timescaledb_restore EXIT

pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --file "$backup_file" \
  "$SEEMIRAI_DATABASE_URL"

psql "$SEEMIRAI_RESTORE_DATABASE_URL" \
  -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO public;
SQL

psql "$SEEMIRAI_RESTORE_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"

psql "$SEEMIRAI_RESTORE_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -c "SELECT timescaledb_pre_restore();"
restore_prepared=1

pg_restore \
  --exit-on-error \
  --no-owner \
  --no-acl \
  --dbname "$SEEMIRAI_RESTORE_DATABASE_URL" \
  "$backup_file"

psql "$SEEMIRAI_RESTORE_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -c "SELECT timescaledb_post_restore();"
restore_prepared=0
trap - EXIT

psql "$SEEMIRAI_RESTORE_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) AS migration_count FROM schema_migrations;"

printf 'Backup/restore smoke test completed: %s\n' "$backup_file"

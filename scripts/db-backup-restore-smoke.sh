#!/usr/bin/env bash
set -euo pipefail

: "${SEEMIRAI_DATABASE_URL:?SEEMIRAI_DATABASE_URL is required}"
: "${SEEMIRAI_RESTORE_DATABASE_URL:?SEEMIRAI_RESTORE_DATABASE_URL is required}"

backup_file="${SEEMIRAI_BACKUP_FILE:-.local/backups/seemirai-$(date -u +%Y%m%dT%H%M%SZ).dump}"

mkdir -p "$(dirname "$backup_file")"

pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --file "$backup_file" \
  "$SEEMIRAI_DATABASE_URL"

pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  --dbname "$SEEMIRAI_RESTORE_DATABASE_URL" \
  "$backup_file"

psql "$SEEMIRAI_RESTORE_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) AS migration_count FROM schema_migrations;"

printf 'Backup/restore smoke test completed: %s\n' "$backup_file"

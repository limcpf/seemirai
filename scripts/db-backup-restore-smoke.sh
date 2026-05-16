#!/usr/bin/env bash
set -euo pipefail

: "${SEEMIRAI_DATABASE_URL:?SEEMIRAI_DATABASE_URL is required}"
: "${SEEMIRAI_RESTORE_DATABASE_URL:?SEEMIRAI_RESTORE_DATABASE_URL is required}"

# dump 파일 위치는 호출자가 지정할 수 있고, 기본값은 로컬 산출물 디렉터리 아래 UTC timestamp다.
backup_file="${SEEMIRAI_BACKUP_FILE:-.local/backups/seemirai-$(date -u +%Y%m%dT%H%M%SZ).dump}"

mkdir -p "$(dirname "$backup_file")"

# source와 restore URL이 다른 문자열이어도 같은 PostgreSQL 인스턴스/DB를 가리킬 수 있다.
# host alias나 socket/TCP 차이에 흔들리지 않도록 DB data directory, port, DB oid/name으로 실제 대상을 식별한다.
database_identity() {
  psql "$1" \
    -v ON_ERROR_STOP=1 \
    --no-align \
    --tuples-only \
    -c "SELECT concat(current_setting('data_directory'), ':', current_setting('port'), '/', oid, '/', datname) FROM pg_database WHERE datname = current_database();"
}

# restore 대상이 원본 DB와 같으면 `pg_restore`가 원본 schema를 지울 수 있으므로 즉시 중단한다.
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

# TimescaleDB는 restore 도중 background worker 상태를 전환해야 한다.
# 중간 실패 시에도 post_restore를 best-effort로 호출해 restore DB session 상태가 남지 않게 한다.
finish_timescaledb_restore() {
  if [ "$restore_prepared" = "1" ]; then
    psql "$SEEMIRAI_RESTORE_DATABASE_URL" \
      -v ON_ERROR_STOP=1 \
      -c "SELECT timescaledb_post_restore();" >/dev/null || true
  fi
}

trap finish_timescaledb_restore EXIT

# 원본 DB를 PostgreSQL custom format으로 백업한다.
pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --file "$backup_file" \
  "$SEEMIRAI_DATABASE_URL"

# restore smoke는 disposable 검증 DB를 전제로 한다.
# 이전 복구 결과가 남아 있으면 검증이 섞이므로 public schema를 비우고 다시 만든다.
psql "$SEEMIRAI_RESTORE_DATABASE_URL" \
  -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO public;
SQL

# TimescaleDB dump를 복원하려면 restore 전에 extension을 먼저 로드하고 pre_restore hook을 호출해야 한다.
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

# restore가 끝나면 TimescaleDB post_restore hook으로 background worker 상태를 정상화한다.
psql "$SEEMIRAI_RESTORE_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -c "SELECT timescaledb_post_restore();"
restore_prepared=0
trap - EXIT

# 최소 smoke 기준은 migration 이력이 복구되어 schema 버전을 조회할 수 있는지다.
psql "$SEEMIRAI_RESTORE_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) AS migration_count FROM schema_migrations;"

printf 'Backup/restore smoke test completed: %s\n' "$backup_file"

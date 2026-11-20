#!/bin/bash
# Re-apply unapplied SQL files in infra/db/migrations as fb_owner, then exit.
# 00-roles.sh already ran them on the first postgres initialisation (M-20); applied files are skipped.
# Grants are idempotent (REVOKE + GRANT) and are re-applied so a newly applied migration is covered (A-01 §3.4).
set -euo pipefail

: "${PG_HOST:?PG_HOST required}"
: "${PG_DATABASE:?PG_DATABASE required}"
: "${PG_USER:?PG_USER required}"
PG_PORT="${PG_PORT:-5432}"
SECRETS_DIR="${SECRETS_DIR:-/run/secrets}"
DB_DIR="${INFRA_DB_DIR:-/app/infra/db}"
export PGSSLMODE=disable
export HOME=/tmp

secret_file="$SECRETS_DIR/pg_owner_password"
[ -r "$secret_file" ] || { echo "migrate: missing owner password file" >&2; exit 1; }
pw="$(tr -d '\r\n' < "$secret_file")"
[ -n "$pw" ] || { echo "migrate: empty owner password" >&2; exit 1; }
export PGPASSWORD="$pw"
unset pw

psql_owner() {
  psql -X -v ON_ERROR_STOP=1 -h "$PG_HOST" -p "$PG_PORT" --username "$PG_USER" --dbname "$PG_DATABASE" "$@"
}

ready=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if psql_owner -c 'SELECT 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || { echo "migrate: fb_owner could not connect" >&2; exit 1; }

psql_owner -c "CREATE TABLE IF NOT EXISTS app.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"

shopt -s nullglob
files=("$DB_DIR"/migrations/[0-9][0-9][0-9][0-9]_*.sql)
[ "${#files[@]}" -gt 0 ] || { echo "migrate: no migration files in $DB_DIR/migrations" >&2; exit 1; }

applied=0
skipped=0
for f in "${files[@]}"; do
  v="$(basename "$f" .sql)"
  done_already="$(psql_owner -At -c "SELECT 1 FROM app.schema_migrations WHERE version = '$v'")"
  if [ -n "$done_already" ]; then
    echo "migrate: skip $v"
    skipped=$((skipped + 1))
    continue
  fi
  echo "migrate: apply $v"
  {
    echo "BEGIN;"
    cat "$f"
    echo
    echo "INSERT INTO app.schema_migrations (version) VALUES ('$v');"
    echo "COMMIT;"
  } | psql_owner -q
  applied=$((applied + 1))
done

psql_owner -q -f "$DB_DIR/grants.sql"
unset PGPASSWORD
echo "migrate: done applied=$applied skipped=$skipped"

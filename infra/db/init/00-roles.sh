#!/bin/bash
# First-initialisation script of the postgres container (A-01 2.3 / 3.4). Mounted in /docker-entrypoint-initdb.d/.
# Creates the four roles (passwords read from /run/secrets/pg_*_password), then runs the migrations and grants.sql as fb_owner.
# Idempotent: roles are created-or-altered, schema/migrations are tracked in app.schema_migrations, grants are REVOKE+GRANT.
# harness has NO database role (H-06).
set -euo pipefail

SECRETS_DIR="${SECRETS_DIR:-/run/secrets}"
# Directory holding migrations/ and grants.sql. Default: the parent of this script's directory (infra/db).
# TODO(T01-REVIEW): compose.yml mounts only init/ into /docker-entrypoint-initdb.d; migrations/ and grants.sql must be mounted
# too (e.g. infra/db at /infra-db, read-only) and INFRA_DB_DIR=/infra-db set (non-secret). compose.yml was not changed (T14).
DB_DIR="${INFRA_DB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DB_NAME="${POSTGRES_DB:-app}"
SUPER="${POSTGRES_USER:-postgres}"

read_secret() { # strip trailing newline only
  local f="$SECRETS_DIR/$1"
  [ -r "$f" ] || { echo "00-roles.sh: missing secret file $f" >&2; exit 1; }
  tr -d '\r\n' < "$f"
}

psql_super() { psql -X -v ON_ERROR_STOP=1 --username "$SUPER" --dbname "$DB_NAME" "$@"; }

for r in owner gateway hands booking; do
  pw="$(read_secret "pg_${r}_password")"
  [ -n "$pw" ] || { echo "00-roles.sh: empty password for $r" >&2; exit 1; }
  # password passed as a psql variable (never in argv / environment of the server), quoted with :'pw'
  psql_super -v "pw=$pw" -v "role=fb_$r" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE', :'role')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'role', :'pw') \gexec
SQL
done

# fb_owner owns schema app and every table in it; it needs CREATE on the database to create the schema.
psql_super <<SQL
GRANT CONNECT ON DATABASE "$DB_NAME" TO fb_owner, fb_gateway, fb_hands, fb_booking;
GRANT CREATE ON DATABASE "$DB_NAME" TO fb_owner;
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION fb_owner;
SQL

# Migration runner: files NNNN_name.sql in order, each in one transaction together with its bookkeeping row.
export PGPASSWORD
PGPASSWORD="$(read_secret pg_owner_password)"
# Connect over TCP loopback so fb_owner authenticates with its password (local socket auth in the image is trust).
psql_owner() { psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 --username fb_owner --dbname "$DB_NAME" "$@"; }

# During docker-entrypoint init the temporary server listens on the unix socket only; fall back to it.
if ! psql_owner -c 'SELECT 1' >/dev/null 2>&1; then
  psql_owner() { PGPASSWORD="" psql -X -v ON_ERROR_STOP=1 --username fb_owner --dbname "$DB_NAME" "$@"; }
fi

psql_owner -c "CREATE TABLE IF NOT EXISTS app.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"

shopt -s nullglob
for f in "$DB_DIR"/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  v="$(basename "$f" .sql)"
  done_already="$(psql_owner -At -c "SELECT 1 FROM app.schema_migrations WHERE version = '$v'")"
  if [ -n "$done_already" ]; then echo "00-roles.sh: migration $v already applied"; continue; fi
  echo "00-roles.sh: applying migration $v"
  { echo "BEGIN;"; cat "$f"; echo; echo "INSERT INTO app.schema_migrations (version) VALUES ('$v');"; echo "COMMIT;"; } | psql_owner -q
done

psql_owner -q -f "$DB_DIR/grants.sql"
echo "00-roles.sh: roles, migrations and grants done"

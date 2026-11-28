#!/usr/bin/env bash
# A local Postgres for the database tests (synthetic data only), for a cloud or
# dev container that has the PostgreSQL server binaries but no running server.
# Idempotent: initialises once, starts if stopped, creates the test database.
#
#   eval "$(bash tools/maintenance/local-test-db.sh)"   # exports TEST_DATABASE_URL
#
# CI does not use this: it runs a postgres:16 service container.
set -euo pipefail
dir="${H2G_TEST_PG_DIR:-/var/tmp/h2g-pg}"
port="${H2G_TEST_PG_PORT:-55432}"
bin="${PG_BINDIR:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$bin/initdb" ] || { echo "no PostgreSQL server binaries found (set PG_BINDIR)" >&2; exit 1; }

as_pg() { # initdb and the server refuse to run as root
  if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi
}
mkdir -p "$dir"
[ "$(id -u)" = 0 ] && chown postgres "$dir"
if [ ! -f "$dir/data/PG_VERSION" ]; then
  as_pg "'$bin/initdb' -D '$dir/data' -A trust -U postgres" >&2
fi
if ! as_pg "'$bin/pg_ctl' -D '$dir/data' status" >/dev/null 2>&1; then
  as_pg "'$bin/pg_ctl' -D '$dir/data' -o '-p $port -k $dir' -l '$dir/log' -w start" >&2
fi
url="postgres://postgres@127.0.0.1:$port"
if ! "$bin/psql" "$url/postgres" -tAc "SELECT 1 FROM pg_database WHERE datname = 'h2g_test'" | grep -q 1; then
  "$bin/psql" "$url/postgres" -qc "CREATE DATABASE h2g_test" >&2
fi
echo "export TEST_DATABASE_URL=$url/h2g_test"
echo "export PG_BINDIR=$bin"

#!/bin/sh
# Runs once, on first initialisation of the data volume.
#
# Integration tests must never run against development data: they truncate
# tables and assert on exact row counts. A separate database is the cheapest
# way to make that impossible rather than merely discouraged.
set -e

TEST_DB="${POSTGRES_DB:-orion}_test"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE "$TEST_DB";
EOSQL

echo "created test database: $TEST_DB"

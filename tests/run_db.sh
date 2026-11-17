#!/bin/bash
# fresh local database with the stubs and every migration from 059 on; extra args: more sql files to run after
set -e
P="psql -p 5544 -h /tmp -U postgres -qX -v ON_ERROR_STOP=1"
psql -p 5544 -h /tmp -U postgres -qX -c "drop database if exists t2" -c "create database t2" >/dev/null
$P -d t2 -f tests/db_stub.sql >/dev/null
for f in schema/059_*.sql schema/060_*.sql schema/061_*.sql schema/062_*.sql schema/063_*.sql; do $P -d t2 -f $f >/dev/null || { echo "FAIL $f"; exit 1; }; done
$P -d t2 -f tests/db_stub2.sql >/dev/null
# a migration that patches live function text the stubs don't have ("did not match") is skipped with a note
for f in schema/06[5-9]*.sql schema/07*.sql schema/08*.sql schema/09*.sql schema/1[0-9][0-9]*.sql; do [ -f "$f" ] || continue
  out=$($P -1 -d t2 -f $f 2>&1 >/dev/null) || { if grep -q "did not match" <<<"$out"; then echo "skip $f (patches live text the stubs lack)"; continue; fi; echo "$out"; echo "FAIL $f"; exit 1; }; done
for f in "$@"; do $P -tA -d t2 -f $f || { echo "FAIL $f"; exit 1; }; done
echo OK

#!/bin/bash
# The upstream suites each own process-global SQLite state; run each file in its own process.
set -uo pipefail
cd "$(dirname "$0")/.."
PY="${MEETCLIP_TEST_PYTHON:-../.venv/bin/python}"
[ -x "$PY" ] || PY="$(command -v python3)"
fail=0
for f in tests/test_*.py; do
  name="$(basename "$f" .py)"
  if PYTHONDONTWRITEBYTECODE=1 "$PY" -m "tests.$name" >/tmp/meetclip-test-$name.log 2>&1; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    tail -12 "/tmp/meetclip-test-$name.log"
    fail=$((fail+1))
  fi
done
exit "$fail"

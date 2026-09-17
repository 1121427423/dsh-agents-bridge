#!/usr/bin/env bash
#
# Every gate this repository owes a reviewer, in the order they must run, on ONE
# command. This is the script CI should call, and the script a human should run
# before saying "it is green".
#
# WHY A SCRIPT AND NOT A COPY-PASTED LINE. The six gates have three properties
# that a loose shell history loses: they must run SERIALLY (two concurrent
# `build.mjs` runs overwrite `lib/index.js`, and two concurrent vitest runs make
# the reported totals meaningless), they must all run even when an early one
# fails (a reviewer needs the whole picture, not the first failure), and each
# number has to be printed with the command that produced it. The last point is
# the one that keeps a stale metrics row out of `docs/plan.md`: the numbers are
# right there in the output the reader can re-run.
#
# Exit status is non-zero if ANY gate failed, so a CI job needs no extra logic.
#
# Usage:
#   bash scripts/gates.sh            # all six
#   bash scripts/gates.sh --fast     # skip the two builds (unit gates only)
#
# @module dsh-agents-bridge/scripts/gates

set -u

cd "$(dirname "$0")/.." || exit 1

NODE="${NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
VERIFY_PY="${VERIFY_PY:-$HOME/.agents/skills/dsh-plugin-studio/scripts/verify_plugin.py}"
FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

FAILED=0
run() {
  local label="$1"
  shift
  printf '\n=== %s ===\n' "$label"
  if "$@"; then
    printf -- '--- %s: OK\n' "$label"
  else
    printf -- '--- %s: FAILED (exit %s)\n' "$label" "$?"
    FAILED=1
  fi
}

# 1. Unit + integration suites. Must not overlap with the builds below.
run 'vitest' "$NODE" node_modules/vitest/vitest.mjs run

# 2. The source tree must typecheck…
run 'tsc(src)' "$NODE" node_modules/typescript/bin/tsc --noEmit

# 3. …and so must the TEST tree, which `tsc` on its own never looks at (IM-14).
run 'tsc(tests)' "$NODE" node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json

if [ "$FAST" -eq 0 ]; then
  # 4 & 5. The two bundles. Serial by construction: this script never runs two
  # builds at once, and neither should you.
  run 'build' "$NODE" scripts/build.mjs
  run 'build-client' "$NODE" scripts/build-client.mjs

  printf '\n=== bundle sizes (bytes/1024) ===\n'
  ls -l lib/index.js lib/client.js 2>/dev/null | awk '{ printf "  %-16s %8.1f KB\n", $9, $5 / 1024 }'
fi

# 6. The plugin contract (name/patch/client id agreement, externals, artifacts).
if [ -f "$VERIFY_PY" ]; then
  run 'verify_plugin.py' python3 "$VERIFY_PY" .
else
  printf '\n=== verify_plugin.py ===\n  SKIPPED: %s not found (set VERIFY_PY to its path)\n' "$VERIFY_PY"
  FAILED=1
fi

printf '\n=== gates: %s ===\n' "$([ "$FAILED" -eq 0 ] && echo 'ALL PASSED' || echo 'FAILURES ABOVE')"
exit "$FAILED"

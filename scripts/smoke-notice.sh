#!/usr/bin/env bash
#
# Reproduce the end-to-end evidence for the C path: does a delegated session's
# COMPLETION announce itself, without the caller polling?
#
# THE CLAIM THIS SCRIPT TESTS. `agents_run` returns immediately and the session
# is registered as a DSH background job owned by the CALLING agent, so the host's
# job runtime opens a model turn when the session ends (see src/host/jobs.ts and
# `docs/review-fixes.md` §U). The proof is not "the plugin loaded" — it is a real
# model turn in which the notice APPEARS UNASKED after the model has been told
# not to poll anything.
#
# HOW IT DISCRIMINATES. The prompt forbids `agents_wait` / `agents_status` /
# `agents_output` / `agents_probe` / `job_output`, and makes the model idle in
# `bash sleep` instead. Anything about the job that reaches the model therefore
# arrived on the runtime's initiative. The model is then asked to quote it
# verbatim, and to say NONE if nothing arrived — so a broken notice produces a
# NONE, not a story about a notice.
#
# WHAT YOU NEED. A profile that (a) loads dsh-agents-bridge and (b) provides
# `@deepseek-ai/dsh-jobs-local` + `@deepseek-ai/dsh-tool-jobs` (the reporter).
# `headless` and `web` do; the plugin is installed in both on this machine.
#
# Usage:
#   bash scripts/smoke-notice.sh [profile] [identity]
#     profile   default: headless
#     identity  default: claude
#
# Env:
#   DSH_BIN   launcher to use (default: `dsh` on PATH, else the standalone
#             install at /Users/example/BigModel/LLM/tmp/dsh-standalone)
#
# @module dsh-agents-bridge/scripts/smoke-notice

set -u

PROFILE="${1:-headless}"
IDENTITY="${2:-claude}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_LINK="$DSH_HOME_DIR/profiles/$PROFILE/node_modules/dsh-agents-bridge"

if [ -z "${DSH_BIN:-}" ]; then
  if command -v dsh >/dev/null 2>&1; then
    DSH_BIN="$(command -v dsh)"
  else
    DSH_BIN="/Users/example/BigModel/LLM/tmp/dsh-standalone/node_modules/@deepseek-ai/dsh/lib/bin.js"
  fi
fi

printf 'profile   : %s\n' "$PROFILE"
printf 'identity  : %s\n' "$IDENTITY"
printf 'launcher  : %s\n' "$DSH_BIN"
printf 'plugin    : %s\n' "$PLUGIN_LINK"

if [ ! -e "$PLUGIN_LINK" ]; then
  printf '\nREFUSING: this profile does not load the plugin (%s is missing).\n' "$PLUGIN_LINK"
  printf 'Install it first, e.g.:  dsh plugin --profile %s add %s\n' "$PROFILE" "$(cd "$(dirname "$0")/.." && pwd)"
  exit 2
fi

# A one-shot prompt is a HEADLESS-shaped app feature: `web` boots a server and
# takes no task argument, so asking it for one would hang instead of failing.
case "$PROFILE" in
  web|desktop)
    printf '\nREFUSING: profile "%s" boots a server, not a one-shot task.\n' "$PROFILE"
    printf 'Use a headless-shaped profile (the `headless` profile is one), or drive\n'
    printf 'the same claim from a real session in that profile and watch for the notice.\n'
    exit 2
    ;;
esac

PROMPT=$(cat <<EOF
This is a smoke test of a local-agent delegation bridge. Follow the steps exactly and do nothing else.

1. Call agents_run ONCE with identity "$IDENTITY" and this prompt: Reply with exactly: SMOKE-OK
2. From now on you MUST NOT call agents_wait, agents_status, agents_output, agents_probe or job_output.
   Instead, wait by running the shell command: sleep 25
3. Then run: sleep 15  (once more, to give anything in flight time to arrive)
4. Answer three things:
   (a) Did any message appear in your context that you did NOT ask for? Quote it verbatim. If none appeared, answer NONE.
   (b) What job status did that message report (completed / failed / killed)?
   (c) List, in order, the tools you called.
EOF
)

LOG="$(mktemp -t dsh-notice-smoke.XXXXXX)"
printf '\n--- running (a fast model: ~1 min; a slow one can take several) ---\n'
NODE_BIN="${NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"

case "$DSH_BIN" in
  *.js) "$NODE_BIN" "$DSH_BIN" --profile "$PROFILE" "$PROMPT" >"$LOG" 2>&1 ;;
  *)    "$DSH_BIN" --profile "$PROFILE" "$PROMPT" >"$LOG" 2>&1 ;;
esac

printf '\n=== host lines that decide whether the path is live ===\n'
grep -E 'job registry available|session completion notices are on|no job registry available yet' "$LOG" || true

printf '\n=== the model'"'"'s answer (the notice must appear in (a) WITHOUT it polling) ===\n'
tail -30 "$LOG"
printf '\n(full transcript: %s)\n' "$LOG"
printf '\nINTERPRETATION\n'
printf '  A notice quoted in (a) + `session completion notices are on` above  -> the C path works.\n'
printf '  (a) = NONE, and no notices line                                  -> the profile has no job registry.\n'
printf '  (a) = NONE, but notices line present                             -> the seam registered a job and the\n'
printf '                                                                      host did not announce it: a real bug.\n'

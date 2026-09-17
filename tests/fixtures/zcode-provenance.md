# ZCode fixture provenance

- `zcode-turn-failed.ndjson` — **[proven]** verbatim stdout of a live run on
  this host, 2026-09-17:
  `env ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs -p "reply with exactly: ok" --output-format stream-json`
  (ZCode 0.16.5). This is the CONFIGURATION_ERROR terminal captured in
  `docs/findings-zcode-headless.md` §1/§4 (record 8). Contains a stack trace
  and a session id only — no credentials.
- `zcode-basic-turn.derived.ndjson` — **[derived/synthetic]**. The operator
  account on this host has no entitled model, so a SUCCESSFUL turn has never
  been captured (blockers record 8). This file exercises the envelope shape
  [proven] with lifecycle event names harvested from the 0.16.5 bundle strings
  (`turn.started`, `text.delta`, `tool.call.started`, `tool.call.completed`,
  `turn.completed`, `session.closed`) and payload fields as GUESSES. Tests
  over it pin only the lenient behavior: accumulation shapes documented in
  `src/drivers/zcode.ts` and the terminal-event boundary. When a real entitled
  run is captured, replace this file with the recording and move the guesses
  into a `*.derived` note.

# Decision: pi result / completion contract — agent writes result.json; forge attributes a missing one

**Date:** 2026-06-05
**Tickets:** #264 (Crawl exit — result-contract parity), #258 (Pi epic)
**Status:** decided + tested. Sibling to [pi prompt injection](./2026-06-05_pi-prompt-injection.md).

## The boundary: how pi output becomes forge `result.json`

forge decides a task's outcome by reading `/task/result.json` after the container
exits (see `invoke.ts` / `runNext.ts` post-exec): present + valid JSON → complete;
missing → failed `no_result_json`; unparseable → failed `result.json malformed`.

pi (`--mode json`) does NOT write `/task/result.json` on its own — it streams JSONL
events to stdout (`session` → `agent_start` → `turn/message_*` → `agent_end`) and
**exits 0 even when the provider call errors** (e.g. a 401 surfaces as an
`assistant` message with `errorMessage`, then a clean `agent_end`, exit 0).

### Success path — UNCHANGED from every runtime

The task package's output contract ("Write a single JSON object to
/task/result.json…") instructs the agent; pi's model writes the file via its
`write` tool, forge reads it, the task completes. This is byte-identical to how
claude-code and codex tasks complete — parity by construction, no special-casing.

### Failure path — deterministic attribution (the #264 change)

Because pi exits 0, a pi run that produced no usable `result.json` would otherwise
fall into forge's generic, silent `no_result_json` — ambiguous between "provider
errored", "container crashed mid-stream", and "agent ignored the contract". For
`runtime_kind: pi`, forge now derives an attributable reason from pi's structured
stdout (`src/v2/pi-result.ts`, `attributePiNoResult`), in priority order:

1. an `assistant` message carries `errorMessage` → `pi run failed: <errorMessage>`
   (the provider/model error, truncated).
2. no `agent_end` terminal event → `pi produced no completion event … truncated or
   the container crashed mid-run`.
3. clean `agent_end`, no error, still no file → `pi completed but wrote no
   /task/result.json (the agent did not honor the output contract)`.

The mapping is deterministic: the same pi stdout yields the same forge outcome,
independent of any live provider call. It is **completion/error attribution only**
— pi's token usage lives in the same JSONL but is parsed by #262 (still
`log_format: pi-jsonl` → "unsupported", fails loud), and this code never touches
`model_calls`. Provider-error → `model_error` event reclassification is #267.

## Why not synthesize a "complete" when the agent writes nothing?

Rejected. Deriving success from a clean exit would mask a no-op run and diverge
from the contract every other runtime is held to (agent must produce
`result.json`). #264 makes the *failure* honest and attributable; it does not
lower the bar for success.

## Out of scope (unchanged by this)

- pi-jsonl usage parser (#262); provider/profile binding (#265); OAuth (#266);
  error→`model_error` classification (#267); `models.json` local models (#268);
  provider-adapter generation (#283).

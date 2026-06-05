# Decision: pi prompt/context injection — `--append-system-prompt` + positional message + `--no-context-files`

**Date:** 2026-06-05
**Tickets:** #263 (decision + proof), #261 (the runtime that implements it), #258 (Pi epic)
**Status:** decided + validated against the real pi binary.

## Context

#263 asked how to map forge's `composeSystemPrompt` (agent seed + filtered
constraints) and the rendered task package into pi, and to prove forge's context
reaches pi **exactly once** — pi auto-loads context from `.pi/SYSTEM.md` /
`AGENTS.md` / `CLAUDE.md` (cwd + parents), so a naïve setup would deliver forge's
intent AND silently double-load the project's own `CLAUDE.md`.

Three candidate injection paths (from the ticket): write the composed prompt to
`.pi/SYSTEM.md` in the container; prepend it to the `-p` prompt; or use pi's
`--append-system-prompt`.

## Decision

The pi-apikey runtime (`seeds/runtimes/pi-apikey.yml`) uses:

- `--append-system-prompt "${SYSTEM_PROMPT}"` — forge's composed seed+constraints.
- the rendered task package as a **positional message** argument (not stdin).
- `--no-context-files` — pi does NOT auto-load project `CLAUDE.md`/`AGENTS.md`.
- `--no-session` — ephemeral; no session file written.

`--append-system-prompt` (NOT `--system-prompt`): pi's built-in system prompt
describes pi's own tool surface (`read`/`bash`/`edit`/`write`). `--system-prompt`
would REPLACE that, stripping the tool instructions the model needs to act.
Appending keeps pi's tool prompt and adds forge's role/constraints/task contract
after it. (This differs from how one might think about claude-code, but matches
how pi expects to be driven.)

This is the `prompt_strategy: message-arg` value in the #292 runtime metadata.

## Proof (deterministic, offline — `scripts/pi-context-proof.sh`)

pi was pointed at a local mock endpoint (a custom `models.json` provider — the
#268 mechanism used purely as a test seam) so the harness inspects pi's REAL
outbound request body. Distinct sentinels mark the system prompt, the task, and
BOTH project context files pi recognizes (`CLAUDE.md` and `AGENTS.md`):

| flag set | seed+constraints | task package | project CLAUDE.md | project AGENTS.md |
|----------|:---:|:---:|:---:|:---:|
| `--no-context-files` (forge), both files present | **1** | **1** | **0** | **0** |
| _control_ (no flag), each file alone | — | — | **1** | **1** |

So forge's seed+constraints and the task package each reach pi exactly once, and
`--no-context-files` is **load-bearing** — without it pi loads the project's
`CLAUDE.md`/`AGENTS.md` (the controls' 1s). Both files are asserted separately so a
pi regression that suppressed one but not the other is caught. (pi loads only the
first context candidate per directory, so each control isolates one file.) Re-run
the harness after bumping `PI_CLI_VERSION` to confirm the flag's semantics hold.

Forge-side, the docker command is guarded by unit tests in `src/v2/spawn.test.ts`
(exactly one `--append-system-prompt`, one positional package, `--no-context-files`
present, no stdin). The red read-only `/project` mount is unchanged (OS-level,
`PROJECT_MODE=ro`) and asserted for the pi runtime too.

## Out of scope (deliberately not closed here)

- Usage parsing of pi's JSONL (#262) — `log_format: pi-jsonl` still fails loud as
  unsupported until then.
- Result/completion contract parity (#264) — now decided, see
  [pi result contract](./2026-06-05_pi-result-contract.md).
- Generalizing provider/key beyond the anthropic-bound Crawl proof (#265),
  OAuth (#266), `models.json` local models (#268).
- `.pi/SYSTEM.md` as a generated provider adapter surface (#253) — a future
  alternative to `--append-system-prompt` if adapter generation lands.

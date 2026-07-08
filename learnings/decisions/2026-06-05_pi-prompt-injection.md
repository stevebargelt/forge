# Decision: pi prompt/context injection — `--append-system-prompt` + task-package delivery + `--no-context-files`

**Date:** 2026-06-05 (task-package delivery amended 2026-07-08, FG-497 — see
[Update](#update-2026-07-08-fg-497--task-package-delivery-moved-to-file-reference)
below)
**Tickets:** #263 (decision + proof), #261 (the runtime that implements it), #258 (Pi epic), FG-497 (task-package delivery amendment)
**Status:** decided + validated against the real pi binary. Task-package delivery
mechanism changed by FG-497; re-validated against the real pi binary on
2026-07-08 (see Update).

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
- the rendered task package, originally passed as a **positional message**
  argument (not stdin); **as of FG-497 (2026-07-08) this is a file reference,
  `@/task/package.md` — see [Update](#update-2026-07-08-fg-497--task-package-delivery-moved-to-file-reference)
  below.**
- `--no-context-files` — pi does NOT auto-load project `CLAUDE.md`/`AGENTS.md`.
- `--no-session` — ephemeral; no session file written.

`--append-system-prompt` (NOT `--system-prompt`): pi's built-in system prompt
describes pi's own tool surface (`read`/`bash`/`edit`/`write`). `--system-prompt`
would REPLACE that, stripping the tool instructions the model needs to act.
Appending keeps pi's tool prompt and adds forge's role/constraints/task contract
after it. (This differs from how one might think about claude-code, but matches
how pi expects to be driven.)

This is the `prompt_strategy: message-arg` value in the #292 runtime metadata.

## Proof (2026-06-05, original — deterministic, offline, `scripts/pi-context-proof.sh`)

**This section is the historical record of the original 2026-06-05 proof run,
which validated the task package as an embedded positional argv string. The
task-package delivery mechanism it validates was superseded by FG-497 on
2026-07-08 — see
[Update](#update-2026-07-08-fg-497--task-package-delivery-moved-to-file-reference)
for the current mechanism and its own re-run of this same harness.**

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

Forge-side, the docker command was guarded by unit tests in `src/v2/spawn.test.ts`
(exactly one `--append-system-prompt`, one positional package, `--no-context-files`
present, no stdin). The red read-only `/project` mount is unchanged (OS-level,
`PROJECT_MODE=ro`) and asserted for the pi runtime too.

## Update (2026-07-08, FG-497) — task package delivery moved to file reference

**What changed:** the rendered task package is no longer embedded in the
positional message argv. `invoke.ts` writes the rendered package to
`TASK_DIR/package.md` (already bind-mounted into the container at `/task` for
every runtime), and the pi runtime family (`seeds/runtimes/pi-apikey.yml`,
`seeds/runtimes/pi-oauth.yml`) now passes pi's `@file` message syntax,
`@/task/package.md`, as that same trailing positional argument — a file
*reference*, not the rendered markdown itself. `--append-system-prompt`,
`--no-context-files`, and `--no-session` are unchanged from the original
decision above.

**Why:** commit cfd996d (FG-497) stopped folding the full task into the
argv-borne composed system prompt after a large `forge invoke` task (e.g. a
review-loop reviewer packet over ~120KB) crashed the container at exec with
"argument list too long" — `--append-system-prompt` is a single argv string,
capped by Linux's `MAX_ARG_STRLEN` (131072 bytes). A follow-up review of that
range (commit 78bb8f4) found the pi runtime family had the identical exposure
one field over: the task package itself was still embedded as a positional
argv string, unbounded, so the same crash could still be triggered by a large
task package even with the system prompt fixed. pi's `@file` syntax lets the
CLI read the package from disk instead of argv, so argv stays small regardless
of task size. `buildDockerArgs` (`src/v2/spawn.ts`) additionally fail-fasts
on any single argv/env string over 120000 bytes, turning a would-be exec
crash into a labeled FG-497 error on the host.

pi's real `@file` processor (vendored `cli/file-processor.js`) does not inline
the referenced file's raw bytes into the outbound message as plain text — it
wraps them in a `<file name="/task/package.md">...</file>` element. That
wrapping is itself part of the delivery contract worth asserting: a pi
regression that stopped honoring `@file` syntax (and instead sent the literal
string `@/task/package.md` as a positional message) would not be caught by
"the task sentinel appears somewhere in the request," only by asserting the
sentinel arrives inside that specific wrapper.

**Re-proof:** `scripts/pi-context-proof.sh` was updated to assert the new
contract (task delivered by `@/task/package.md` file reference; sentinel
asserted in its wrapped `<file>` form, exactly once) and re-run against the
real pi binary in the agent image on 2026-07-08:

```
with --no-context-files (both files present): sys=1 task=1 claude=0 agents=0 wrapped=1
without --no-context-files (controls): claude=1 agents=1
PASS: forge context delivered exactly once; task package delivered via @file wrapping exactly once; --no-context-files suppresses both CLAUDE.md and AGENTS.md.
```

`wrapped=1` confirms the sentinel arrived exactly once inside pi's
`<file name="/task/package.md">` element — the actual `@file` delivery
contract, not just "the bytes are in there somewhere." `sys=1`/`task=1`
confirm forge's seed+constraints and the task package each still reach pi
exactly once under the new mechanism; `claude=0`/`agents=0` (treatment) vs.
`claude=1`/`agents=1` (controls) confirm `--no-context-files` is still
load-bearing. Forge-side, `src/v2/spawn.test.ts` now asserts the trailing
positional argument is the literal string `@/task/package.md` (not the
rendered package markdown) and that `buildDockerArgs` throws its FG-497 guard
on oversized argv/env strings.

Re-run the harness again after bumping `PI_CLI_VERSION` to confirm both the
`--no-context-files` and `@file`-wrapping semantics still hold.

## Out of scope (deliberately not closed here)

- Usage parsing of pi's JSONL — now done (#262): `log_format: pi-jsonl` selects
  pi's usage parser.
- Result/completion contract parity (#264) — now decided, see
  [pi result contract](./2026-06-05_pi-result-contract.md).
- Generalizing provider/key beyond the anthropic-bound Crawl proof (#265),
  OAuth (#266), `models.json` local models (#268).
- `.pi/SYSTEM.md` as a generated provider adapter surface (#253) — a future
  alternative to `--append-system-prompt` if adapter generation lands.

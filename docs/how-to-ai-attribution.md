# How-to: the AI-attribution toggle — project, host default (FG-799, FG-845, FG-853)

Forge suppresses AI-assistant attribution in git/GitHub messages by default.
`ai_attribution: suppress | allow` is resolved from three levels, in order: the
project's own `<project>/.forge/config.yml`, then a host-wide default in
`$FORGE_HOME/config.yml` (`~/.forge/config.yml` unless `$FORGE_HOME` is set), then the
built-in `suppress`. Absent at every level still reads as `suppress` (today's behavior;
upgrading forge changes nothing for an existing project or a host with no default set).
This forge repo itself stays `suppress`.

Inside an agent container `$FORGE_HOME` is not mounted, so the host level above isn't
directly readable there. A fourth, **carried** level stands in for it: at dispatch time
(both a workflow task and `forge invoke`), forge resolves `project → host → default`
on the host against the *durable* project — never the mounted clone — and hands the
container that answer as one environment value. Resolution inside a container is
therefore project file → carried value → host file (always absent there) → default; see
[Fail-closed, level by level](#fail-closed-level-by-level) and enforcement point 2
below. `FORGE_AI_ATTRIBUTION_CARRIED` is an internal contract between dispatch and the
in-container reader, not something an operator sets — use `forge config set
ai-attribution` (below) to change the mode; setting the env var by hand has no supported
effect outside a forge-managed container.

> The dashboard surfaces this toggle too (FG-845) — see [The dashboard path](#the-dashboard-path)
> below. Everything else in this document is the CLI path, which the dashboard shells out
> to rather than replacing.

## Set it

```bash
forge config set ai-attribution allow            # this project
forge config set ai-attribution allow --host     # the host default, beneath every project
forge config unset ai-attribution                # remove the project override; inherit the host default
forge config show                                # effective mode + source + file
forge doctor                                     # same line, alongside the rest of readiness
```

`forge config set ai-attribution [--host]` writes (or creates) the target file —
`.forge/config.yml` for the project, `$FORGE_HOME/config.yml` for `--host` — preserving
every other key already there (the backlog ticket prefix, `project_key`, etc.). Every
write is line-oriented: only the `ai_attribution:` line is added, replaced, or removed,
so hand-authored formatting, comments, and every other key survive untouched. `--host`
and `--project` are mutually exclusive. `forge config unset ai-attribution` removes the
project's key (it never touches the host file) so the project falls through to the host
default; unsetting an already-absent key is a no-op that says so. All three writes refuse
— and leave the file untouched — when the existing file can't be edited safely as a
single line (unparseable YAML, a flow-style mapping, a block-scalar value, more than one
top-level `ai_attribution:` line): edit the file by hand in that case. A write also
refuses, file untouched, when the target changed underneath it between the read and the
rename (another writer got there first — retry) or when the resulting
`config.ai_attribution_changed` audit event can't be recorded: the file edit is undone
and the command exits non-zero naming the audit gap (`forge: refused — the
config.ai_attribution_changed audit event could not be recorded (…); <file> is
unchanged`; `--json` reports `{ ok: false, reason: "audit_unrecorded", error }`) — the
change is never left applied without its audit record.

`forge config show` and `forge doctor` both print the same two lines:

```
ai attribution: <mode> (<source>)
  file: <path>
```

`<source>` is `project`, `host`, or `default` — or, run inside an agent container where
the mode came from the carried value dispatch handed in, `project (carried)`, `host
(carried)`, or `default (carried)`, naming where the *host* resolved it rather than
implying the container read its own host file (it has none). `file:` names the file the
mode came from — for a carried value, the host file it came from (or none, for a carried
`default`); for an uncarried `default` with nothing set at either level, there is no
file and that line is omitted. `forge config show --json` emits `{ "aiAttribution": {
mode, source, file, reason?, overridesHost? } }`.

## The dashboard path

Setup › Config's Sources table carries a "Git attribution" row (right after Model
policy), reading the same `describeAiAttribution` answer as `forge config show` — mode,
source tag (project override / host default / built-in default / fail-closed), the file
it came from, the host default beneath it (or "none"), the checkout it applies to, and
whether the rendered orchestrator block agrees with the resolved mode. Below the table, a
controls card offers two independent toggles, each a closed-registry act — Preview shows
the exact `forge config …` verb and the file it would change, Confirm runs it:

- **This project** — `suppress | allow | inherit host default`. `inherit` is `forge
  config unset ai-attribution`, removing the project's key so the host default (or the
  built-in) applies; `suppress`/`allow` are `forge config set ai-attribution <mode>`.
- **Host default** — `suppress | allow`, i.e. `forge config set ai-attribution <mode>
  --host`. Its footer names how many of the operator's projects currently inherit it.

Both routes (`POST /api/ai-attribution/project`, `POST /api/ai-attribution/host`) shell
the identical CLI verbs this document already describes — `--actor dashboard` so the
`config.ai_attribution_changed` event attributes the change to the surface it came
through — and write no file themselves; see `docs/SCHEMA-CONTRACT.md` for the route
contract. Setup › Projects lists each project's effective mode and source in a column, so
the whole portfolio is visible without opening Config per project.

**Propagation honesty.** The page states plainly that the git hook and the
`no-ai-attribution` constraint read the resolved value live on every run, but the
rendered orchestrator block in `CLAUDE.md` only catches up on the next `forge upgrade`.
When the block disagrees with the resolved mode, the row and the controls card both show
a "rendered block stale — run `forge upgrade`" notice instead of silently claiming
agreement.

## Fail-closed, level by level

Each level stands on its own: a level's file is consulted only if the level above it is
**absent** (no `ai_attribution` key at all, or the file doesn't exist). A level whose file
exists but can't be trusted **stops the resolution right there** rather than falling
through to the next level — a broken project file can never let a host `allow` through,
and a broken host file can never silently resolve to the built-in default while pretending
nothing is wrong:

- **Unreadable** (exists but can't be read — permissions, I/O error): fails closed to
  `suppress` at that level.
- **Present but unrecognized** (a top-level `ai_attribution:` key whose value isn't
  `suppress` or `allow` — misspelled, empty, a list) fails closed to `suppress` at that
  level. A **nested** `ai_attribution` (under some other top-level key) doesn't count as
  present at all — the level is absent and resolution falls through to the next one.
- **Duplicated** (more than one top-level `ai_attribution:` line — malformed YAML, and
  which one "wins" is ambiguous) fails closed to `suppress` at that level, whatever the
  values are.
- **The carried level** (inside an agent container only) fails closed the same way if
  `$FORGE_AI_ATTRIBUTION_CARRIED` is set but doesn't parse as
  `<mode>;source=<project|host|default>;file=<path>` — including a `default` source
  claiming `allow` (the built-in default is always `suppress`). Unlike the file levels,
  the carried level is never merely absent inside a container that has one: dispatch
  always sets it, even to carry a bare `suppress;source=default;file=`.

When a level fails closed, `forge config show` / `forge doctor` print the reason and the
file that stopped it instead of a `file:` line:

```
ai attribution: suppress (default)
  ⚠ /home/op/myproj/.forge/config.yml carries an unrecognized ai_attribution value (valid: suppress, allow); failing closed to suppress
```

When the project overrides a *different*, recognized host default, `forge doctor` adds a
second warning naming the host file and how to stop overriding it
(`forge config unset ai-attribution`).

## What each mode does, at each enforcement point

Three enforcement points read this same mode. There is no fourth place attribution is
decided.

**1. The `no-ai-attribution` force constraint** (`seeds/constraints/no-ai-attribution.md`).
Its frontmatter declares `enabled_when: { config: ai_attribution, equals: suppress }`.
`resolveEffectiveConstraints` (the host-union-project resolver `composeSystemPrompt` calls)
evaluates that toggle against the *resolved* mode — project value, falling back to the
host default, falling back to `suppress` — via the same `readAiAttribution`: under
`suppress` (including every fail-closed case) the constraint is injected into the agent's
prompt as before; under a resolved `allow` it is dropped from the effective set entirely,
and the drop is recorded as an auditable skip (`constraintsSkipped` on the compose result)
rather than silently omitted. This is a condition the host rule itself declares, not a
project override — a project still cannot delete, weaken, or redefine a host force rule
(FG-775 host-wins is unchanged; a project constraint file named `no-ai-attribution` is
still dropped on id collision). See [concepts.md → Constraint](concepts.md#constraint).

**2. The `commit-msg` git hook** (`scripts/git-hooks/commit-msg-no-ai-attribution`,
installed by `forge init`/`forge upgrade` into `<project>/.git/hooks/commit-msg`, and
installed as a self-contained file into every task clone per FG-685). Its first act is to
run the standalone reader `scripts/git-hooks/read-ai-attribution.mjs` (resolved as a
sibling of the hook's own real path, and materialized alongside it in a provisioned
workspace clone) under bare `node`. The reader carries an inline, test-pinned copy of the
same project → carried → host → default resolution the TypeScript side uses
(`src/v2/ai-attribution-parse.ts`'s `resolveAiAttributionLevels`) and prints `allow` or
`suppress` for the resolved mode — so quoted values, trailing comments, a root key with
leading indentation, a nested key, a malformed level, the carried value, and the host
fallback all resolve identically in the hook and in `forge config show`/`forge doctor`,
with no separate bash dialect to keep in sync. If it prints `allow`, the hook exits 0
immediately and nothing else runs. Otherwise (resolved `suppress`, including every fail-closed case, or the reader
printing anything else) it enforces: see the provider set and exemptions below. If `node`
isn't on `PATH` or the reader can't be found or run, the hook fails closed to `suppress`
and prints one stderr notice explaining why — a broken toolchain is never silently
permissive. The host level is read from `$FORGE_HOME` (default `~/.forge`) in the hook's
own process environment; on the operator's own checkout that's a real file. Inside an
agent task container, where `$FORGE_HOME` is not mounted, the hook instead consults
`$FORGE_AI_ATTRIBUTION_CARRIED` (FG-853) between the project file and the — there always
absent — host file: dispatch resolved the host's `project → host → default` mode against
the durable project on the host and passed it in as that one environment value, so a
host-wide `allow` reaches the clone's hook exactly as it reaches the operator's own, and
the clone's own project file, read first, still wins over it. A fail-closed stop at any
level — including an unparseable carried value — is reported on the hook's stderr,
naming the level that stopped it.

**3. The orchestrator block in `CLAUDE.md`.** The template
(`seeds/orchestrator-template.md`) carries the mode-specific bullet between
`<!-- forge:if ai_attribution=suppress -->` … `<!-- forge:endif -->` and
`<!-- forge:if ai_attribution=allow -->` … `<!-- forge:endif -->` markers; `forge init`
renders it against the project's resolved mode (project value, else the host default,
else `suppress`), keeping the block whose marker matches and
stripping every marker line from the output, so the rendered `CLAUDE.md` carries only the
one bullet for the mode in effect. `suppress` renders today's rule (widened to the full
provider set below); `allow` renders a one-line notice that attribution is fine in this
project. `forge init`/`forge upgrade` re-render on every run, so flipping the mode and
re-running picks up the change; editing `CLAUDE.md` between the
`<!-- forge:orchestrator-start -->` / `-end -->` markers by hand doesn't stick.

Launch carriers resolve the same conditionals with the same renderer, keyed to the project's mode: `forge claude` and `forge codex` never deliver both bullets or a `forge:if` marker. When the project's `CLAUDE.md` carries exactly the block this forge renders for the mode, `forge claude` appends nothing (that block is the single delivery path). A block that doesn't match — stale, edited, or rendered for the other mode — does not suppress the carrier: the rendered policy is appended and the mismatch is recorded as drift — fix with `forge upgrade`. The Codex carrier is published per mode by `forge upgrade`.

## The provider set (`suppress`)

Widened from Claude/Anthropic-only to every assistant forge runs: **Claude/Anthropic,
Codex/OpenAI/ChatGPT, Gemini, Copilot**. All three enforcement points name the same set — a
test asserts the constraint file and the orchestrator template list identical providers so
they cannot drift apart.

Rejected (case-insensitive):

- `Co-Authored-By:` trailers naming any of the above (any variant — `Claude Opus`, `Claude
  Sonnet`, `Claude Code`, etc.)
- `Generated with <tool>` boilerplate and any `🤖 …` signature
- Bare mentions of "Claude", "Anthropic", "Codex", "OpenAI", "ChatGPT", "Gemini", or
  "Copilot" in commit messages, PR titles, PR bodies, issue bodies, or issue comments

## Technical-identifier exemptions

These are allowed through even under `suppress` — they're legitimate technical
identifiers, not attribution prose:

- `CLAUDE.md` (the canonical project-setup filename)
- `CLAUDE_*`, `ANTHROPIC_*`, `OPENAI_*`, `CODEX_*`, `GEMINI_*`, `COPILOT_*` environment
  variable names (e.g. `CLAUDE_CODE_USE_BEDROCK`, `OPENAI_API_KEY`, `CODEX_HOME`,
  `GEMINI_API_KEY`)
- `.claude` / `.claude/` (config dir)
- `@anthropic-ai/*`, `@openai/*` package names
- Model ids: `claude-opus-*`, `claude-sonnet-*`, `claude-haiku-*`, `gpt-*`, `o<N>-*`,
  `gemini-*`
- `codex-subscription`, `codex-apikey`, and other `codex-*` runtime/identifier names
- `forge claude`, `forge codex` (forge subcommands wrapping the CLIs)
- `` `claude` ``, `` `codex` `` in backticks (literal binary names) and the bare lowercase
  CLI tool names themselves — capitalized "Claude"/"Codex" is still caught
- `--claude`, `--codex` (CLI flags)

## Bypass

`git commit --no-verify` still bypasses the hook exactly as before — this toggle doesn't
change that. The hook is defense-in-depth for the constraint, not an adversarial boundary;
see [concepts.md → Workspace isolation](concepts.md#workspace-isolation-worktree-mode) for
why the same is true of the clone-installed copy.

## Notes

- Switching modes doesn't retroactively touch git history — it only changes what's
  enforced going forward.
- `ai_attribution` is the only config `enabled_when` understands today; an `enabled_when`
  naming any other config key never matches (the constraint it's attached to is always
  skipped), by design — see [concepts.md → Constraint](concepts.md#constraint).

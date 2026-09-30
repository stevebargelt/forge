# How-to: the AI-attribution toggle — project, host default (FG-799, FG-845)

Forge suppresses AI-assistant attribution in git/GitHub messages by default.
`ai_attribution: suppress | allow` is resolved from three levels, in order: the
project's own `<project>/.forge/config.yml`, then a host-wide default in
`$FORGE_HOME/config.yml` (`~/.forge/config.yml` unless `$FORGE_HOME` is set), then the
built-in `suppress`. Absent at every level still reads as `suppress` (today's behavior;
upgrading forge changes nothing for an existing project or a host with no default set).
This forge repo itself stays `suppress`.

> The dashboard does not yet surface this toggle (Setup › Config row, Projects column,
> the two closed-registry controls). That's FG-845's second part, tracked separately —
> everything below is CLI-only today.

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
top-level `ai_attribution:` line): edit the file by hand in that case.

`forge config show` and `forge doctor` both print the same two lines:

```
ai attribution: <mode> (<source>)
  file: <path>
```

`<source>` is `project`, `host`, or `default`. `file:` names the file the mode came
from — for `default` with nothing set at either level, there is no file and that line is
omitted. `forge config show --json` emits `{ "aiAttribution": { mode, source, file,
reason?, overridesHost? } }`.

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
same project → host → default resolution the TypeScript side uses
(`src/v2/ai-attribution-parse.ts`'s `resolveAiAttributionLevels`) and prints `allow` or
`suppress` for the resolved mode — so quoted values, trailing comments, a root key with
leading indentation, a nested key, a malformed level, and the host fallback all resolve
identically in the hook and in `forge config show`/`forge doctor`, with no separate bash
dialect to keep in sync. If it prints `allow`, the hook exits 0 immediately and nothing
else runs. Otherwise (resolved `suppress`, including every fail-closed case, or the reader
printing anything else) it enforces: see the provider set and exemptions below. If `node`
isn't on `PATH` or the reader can't be found or run, the hook fails closed to `suppress`
and prints one stderr notice explaining why — a broken toolchain is never silently
permissive. The host level is read from `$FORGE_HOME` (default `~/.forge`) in the hook's
own process environment — inside an agent task container, where `$FORGE_HOME` is not
mounted, that level is simply absent and the project's own value (or the built-in
`suppress`) governs; the host default only reaches hooks running on the operator's own
checkout.

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

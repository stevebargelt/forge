# How-to: the per-project AI-attribution toggle (FG-799)

Forge suppresses AI-assistant attribution in git/GitHub messages by default. This is a
per-project toggle — `ai_attribution: suppress | allow` in `<project>/.forge/config.yml`,
absent = `suppress` (today's behavior; upgrading forge changes nothing for an existing
project). This forge repo itself stays `suppress`.

## Set it

```bash
forge config set ai-attribution allow      # or: suppress
forge config show                          # effective mode + where it came from
forge doctor                               # same line, alongside the rest of readiness
```

`forge config set ai-attribution` writes (or creates) `.forge/config.yml`, preserving
every other key already there (the backlog ticket prefix, `project_key`, etc. — this is a
read-modify-write, never a template overwrite). It refuses any value other than `suppress`
or `allow`. `forge config show` and `forge doctor` both print the same line —
`ai attribution: <mode> (<source>)` — where `<source>` is `.forge/config.yml` when the key
is present and recognized, or `default` when it's absent, malformed, or an unrecognized
value (the reader fails closed to `suppress` in all three of those cases — a broken config
can never silently read as `allow`).

## What each mode does, at each enforcement point

Three enforcement points read this same mode. There is no fourth place attribution is
decided.

**1. The `no-ai-attribution` force constraint** (`seeds/constraints/no-ai-attribution.md`).
Its frontmatter declares `enabled_when: { config: ai_attribution, equals: suppress }`.
`resolveEffectiveConstraints` (the host-union-project resolver `composeSystemPrompt` calls)
evaluates that toggle against the *project's* config: under `suppress` (or an absent
config) the constraint is injected into the agent's prompt as before; under `allow` it is
dropped from the effective set entirely, and the drop is recorded as an auditable skip
(`constraintsSkipped` on the compose result) rather than silently omitted. This is a
condition the host rule itself declares, not a project override — a project still cannot
delete, weaken, or redefine a host force rule (FG-775 host-wins is unchanged; a project
constraint file named `no-ai-attribution` is still dropped on id collision). See
[concepts.md → Constraint](concepts.md#constraint).

**2. The `commit-msg` git hook** (`scripts/git-hooks/commit-msg-no-ai-attribution`,
installed by `forge init`/`forge upgrade` into `<project>/.git/hooks/commit-msg`, and
installed as a self-contained file into every task clone per FG-685). Its first act is a
single grep of the repo's own `.forge/config.yml` for a top-level `ai_attribution: allow`
line — no YAML parser in bash. If it matches, the hook exits 0 immediately and nothing else
runs. Otherwise (absent config, or `suppress`) it enforces: see the provider set and
exemptions below.

**3. The orchestrator block in `CLAUDE.md`.** The template
(`seeds/orchestrator-template.md`) carries the mode-specific bullet between
`<!-- forge:if ai_attribution=suppress -->` … `<!-- forge:endif -->` and
`<!-- forge:if ai_attribution=allow -->` … `<!-- forge:endif -->` markers; `forge init`
renders it against the project's mode, keeping the block whose marker matches and
stripping every marker line from the output, so the rendered `CLAUDE.md` carries only the
one bullet for the mode in effect. `suppress` renders today's rule (widened to the full
provider set below); `allow` renders a one-line notice that attribution is fine in this
project. `forge init`/`forge upgrade` re-render on every run, so flipping the mode and
re-running picks up the change; editing `CLAUDE.md` between the
`<!-- forge:orchestrator-start -->` / `-end -->` markers by hand doesn't stick.

## The provider set (`suppress`)

Widened from Claude/Anthropic-only to every assistant forge runs: **Claude/Anthropic,
Codex/OpenAI/ChatGPT, Gemini, Copilot**. All three enforcement points name the same set — a
test asserts the constraint file and the orchestrator template list identical providers so
they cannot drift apart.

Rejected (case-insensitive):

- `Co-Authored-By:` trailers naming any of the above (any variant — `Claude Opus`, `Claude
  Sonnet`, `Claude Code`, etc.)
- `Generated with <tool>` boilerplate and any `🤖 …` signature
- Bare mentions of "Claude", "Anthropic", "Codex", "OpenAI", or "ChatGPT" in commit
  messages, PR titles, PR bodies, issue bodies, or issue comments

## Technical-identifier exemptions

These are allowed through even under `suppress` — they're legitimate technical
identifiers, not attribution prose:

- `CLAUDE.md` (the canonical project-setup filename)
- `CLAUDE_*`, `ANTHROPIC_*`, `OPENAI_*`, `CODEX_*` environment variable names (e.g.
  `CLAUDE_CODE_USE_BEDROCK`, `OPENAI_API_KEY`, `CODEX_HOME`)
- `.claude` / `.claude/` (config dir)
- `@anthropic-ai/*`, `@openai/*` package names
- Model ids: `claude-opus-*`, `claude-sonnet-*`, `claude-haiku-*`, `gpt-*`, `o<N>-*`
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

# forge — instructions for Claude Code sessions

This is the forge CLI repo. If you're a Claude Code session working in this directory, read this first.

## What forge is

A TypeScript CLI for orchestrating multi-agent workflows. Forge runs on the host. Each agent runs as an ephemeral Docker container (`agent-dev-worker` image). SQLite is the blackboard. The full design lives in the spine sketch at `~/OneDrive - Southern Glazer's Wine & Spirits/obsidian/stevieb-sgws/Harness Spine Sketch.md`.

## Session start: use `forge backlog`, don't read BACKLOG.md whole

`BACKLOG.md` at the repo root is the canonical task list. It is large (~170KB). **Use the `forge backlog` CLI** instead of reading the file directly — same data, ~30x less context.

Standard session-start sequence:
```
forge backlog notes show                    # narrative handoff from last session
forge backlog list --status active          # open tickets (titles only)
forge backlog show <id>                     # full body when you need one
```

`forge backlog --help` lists the rest (`file`, `close`, `move`, `notes add`, `notes replace`). Only read BACKLOG.md whole if you genuinely need to scan across many ticket bodies at once — typically you don't.

Sticky numbers (e.g. `#33`, `#41`) are stable across sessions and referenced from commit messages and ADRs. New tasks land via `forge backlog file "<title>"` (auto-assigns the next sticky); never renumber.

The TaskCreate harness tool is for ephemeral within-session working state. The durable record is BACKLOG.md (via `forge backlog`).

## Conventions

- TypeScript with strict mode and `noUncheckedIndexedAccess`. Run `npm run typecheck` before committing source changes.
- Module type is ES modules (`"type": "module"` in `package.json`). Always use `.js` import suffixes from TypeScript files.
- Workflow definitions are TypeScript files under `src/workflows/`. **Do not** introduce a YAML/JSON workflow loader. The `Workflow` type is the schema.
- Agents always run in containers. Forge itself never runs in a container. **One documented exception:** the human-led `ui-review` phase of `ui-design`, `ui-design-revise`, and `feature-ui-design-needed` workflows runs *outside* forge entirely — the human runs Pencil on their host (FORGE-DEC-014). Forge's role for design is to author the prompt (`prompt-author` agent in a normal container) and gate the artifacts the human produces. There is no agent-led UI design phase.
- Red agents always get read-only project mounts (`-v <project>:/project:ro`). This is OS-level enforcement; never relax it to a prompt instruction.
- Three similar functions are better than a premature base class. Don't introduce abstractions beyond what the spine sketch specifies.
- Default to no comments. Add a comment only when the WHY is non-obvious.
- **Don't estimate work in human-hours, days, or weeks.** I'm doing the work, not a human team — the unit doesn't apply and the framing leads to bad scoping. Talk about scope (small / medium / large change, isolated vs cross-cutting), risk (reversible vs not, schema change required), and dependencies between tasks. Never "this is a 2-week project" — that's noise.

## Auth modes (FORGE-DEC-007, updated by FORGE-DEC-013)

Three modes, auto-selected by env at run time:
- **bedrock**: `CLAUDE_CODE_USE_BEDROCK=1` + `AWS_PROFILE` set. Containers mount `~/.aws` read-only and read SSO cache directly; STS env vars are NOT snapshotted. A detached host-side watchdog (`scripts/run-sso-watchdog.sh`) keeps the SSO cache fresh. Source `. ./scripts/use-bedrock.sh` to arm. See FORGE-DEC-013.
- **anthropic-apikey**: `ANTHROPIC_API_KEY` set. Escape hatch.
- **anthropic-oauth** (default): credentials live in docker volume `forge-claude-oauth`, populated by `forge auth login`. Personal-Mac default; supports Opus 4.7 via Claude Pro.

The vault's DEC-006 (host file mount) does NOT work on macOS — Claude Code stores OAuth in the keychain there. The named-volume approach replaces it for forge.

## File layout

```
src/
├── cli/            CLI entry + commands (new, next, gate, show, status, auth, dashboard)
├── spine/          dispatch, next, spawn, spawnRed, gate, composeSystemPrompt, workflows, constraints
├── store/          SQLite schema + accessors per table
├── types/          Authoritative TypeScript types (matches the sketch)
├── util/           paths, ids, creds, sso-watchdog
└── workflows/      One file per workflow

seeds/              Default agent dirs and constraints; copied into ~/.forge/ by install-seeds.sh
docker/             Agent image
docs/               How-tos and concepts
learnings/          ADRs and patterns for forge itself
```

## What not to touch without a learnings entry

- The state-machine status values in `tasks.status` (`pending|running|awaiting_gate|awaiting_human_input|awaiting_red|complete|failed|blocked_by_red`). Adding a new status is a schema change and an ADR.
- The verdict aggregation rule in `gate.ts`: pass if all reds pass; fail if any authoritative; inconclusive otherwise. Specialist fails warn but don't block without rationale.
- The Docker invocation pattern in `spawn.ts`. Read DEC-004 (orchestrator on host, agents in containers), DEC-005 (Ubuntu base), DEC-006 (OAuth file mount), DEC-009 (UID 1000) before changing any of it.
- **Don't add a designer agent that runs Pencil headlessly.** FORGE-DEC-014 documents three independent reasons this fails in Pencil 0.2.5. The `prompt-author` agent (BACKLOG #53) is forge's role; the human runs Pencil on their host. Revisit only if Pencil ships auto-save AND a headless persistence path.

## Documentation

`README.md` is one-screen orientation. `docs/quick-start.md` is end-to-end. The four `how-to-*.md` files cover starting each workflow type and adding new agents/workflows. `docs/concepts.md` is the glossary.

If you change a CLI flag or rename a primitive, update the relevant doc in the same commit.

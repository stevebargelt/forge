# Repo guide

Volatile, repo-specific prose for people (and Claude Code sessions) working on the forge
codebase itself — what forge is, house conventions, auth modes, the `src/` layout, and what
not to touch casually. This document has an explicit maintenance owner (the
documentation-maintainer) so it can be corrected as the code changes; `CLAUDE.md` links here
rather than embedding this prose itself (FG-253/FG-347).

## What forge is

A TypeScript CLI for orchestrating multi-agent workflows. Forge runs on the host. Each agent
runs as an ephemeral Docker container (`agent-dev-worker` image). SQLite is the blackboard.
The full design lives in the spine sketch at `~/OneDrive - Southern Glazer's Wine & Spirits/obsidian/stevieb-sgws/Harness Spine Sketch.md`.

## Conventions

- TypeScript with strict mode and `noUncheckedIndexedAccess`. Run `npm run typecheck` before committing source changes.
- Module type is ES modules (`"type": "module"` in `package.json`). Always use `.js` import suffixes from TypeScript files.
- Workflow definitions are YAML files under `seeds/workflows/`, published into `~/.forge/` as an atomic seed generation by `forge upgrade` (FG-583). `install-seeds.sh` also refreshes a flat `~/.forge/workflows/` copy, but that copy is kept only for drift detection and `forge doctor` — dispatch reads exclusively from the published generation. Loaded by `src/v2/loader.ts` with Zod validation. Per-project overrides go in `<project>/.forge/workflows/<name>.yml`.
- Agents always run in containers. Forge itself never runs in a container. **One documented exception:** the design phase runs on the host via `forge design` — the user launches an interactive session with Pencil MCP in a separate terminal (FORGE-DEC-014). Forge's role is to author the prompt (`prompt-author` agent in a normal container), then hand off to the tracked `forge design` session. There is no agent-led UI design phase.
- Red agents always get read-only project mounts (`-v <project>:/project:ro`). This is OS-level enforcement; never relax it to a prompt instruction.
- Three similar functions are better than a premature base class. Don't introduce abstractions beyond what the spine sketch specifies.
- Default to no comments. Add a comment only when the WHY is non-obvious.
- **Don't estimate work in human-hours, days, or weeks.** I'm doing the work, not a human team — the unit doesn't apply and the framing leads to bad scoping. Talk about scope (small / medium / large change, isolated vs cross-cutting), risk (reversible vs not, schema change required), and dependencies between tasks. Never "this is a 2-week project" — that's noise.

## Auth modes (FORGE-DEC-007, updated by FORGE-DEC-013)

Three modes, auto-selected by env at run time (`src/util/creds.ts`):
- **bedrock**: `CLAUDE_CODE_USE_BEDROCK=1` + `AWS_PROFILE` set. Containers mount `~/.aws` read-only and read SSO cache directly; STS env vars are NOT snapshotted. A detached host-side watchdog (`scripts/run-sso-watchdog.sh`) keeps the SSO cache fresh. Source `. ./scripts/use-bedrock.sh` to arm. See FORGE-DEC-013.
- **anthropic-apikey**: `ANTHROPIC_API_KEY` set. Escape hatch.
- **anthropic-oauth** (default): credentials live in docker volume `forge-claude-oauth-v2`, populated by `forge auth login`. Personal-Mac default; supports Opus 4.7 via Claude Pro.

The vault's DEC-006 (host file mount) does NOT work on macOS — Claude Code stores OAuth in the keychain there. The named-volume approach replaces it for forge.

These are the container-agent credential modes. The interactive orchestrator session itself
(`forge orchestrator` / `forge claude`) resolves auth separately, per adapter — see
[How to: the interactive orchestrator launcher](how-to-orchestrator-launcher.md).

## File layout

```
src/
├── backlog/        Backlog accessors: structured + legacy parse, storage-mode/container-authority, config
├── campaign/        Campaign executor: drives multi-item campaigns via launch.ts, continuation adapter
├── cli/             CLI entry + commands (new, next, gate, show, status, auth, backlog, invoke, watch, route, ...)
├── done-audit/      Mechanical, IO-free done-audit evaluator for campaign items (FG-383)
├── notify/          Milestone notifications: ntfy + twilio delivery, consent, formatting
├── ops/             Operational incident detection + repair (orphan reconcile candidates)
├── orchestrator/    Provider-neutral interactive orchestrator adapter contract + shared launch primitive (claude-adapter, codex-adapter)
├── queue/           Long-lived dispatcher: decision (dispatch-cycle), execution lifecycle, and the durable controller (dispatcher-loop)
├── raci/            Routing policy: RACI parse/compile, route validate/explain, propose/apply, governance
├── readiness/       Mechanical, IO-free readiness preflight for backlog items (FG-382)
├── store/           SQLite schema + accessors per table (runs, tasks, events, gates, verdicts, model-calls, ...)
├── types/           Authoritative TypeScript types (matches the sketch)
├── util/            paths, ids, creds, auth-profiles, git-root, run-lock, process-identity, heartbeats
└── v2/              YAML-driven runner: dispatch, spawn, next, gate, reconcile, loader, compose, constraints, docs-impact, orchestrator resolve/capabilities, review pipeline

seeds/              Agent, constraint, runtime, workflow, codex, and skill seeds → ~/.forge/ via install-seeds.sh;
                    agent-protocols/ has no flat copy — only forge upgrade publishes it (FG-654)
docker/             Agent image
docs/               How-tos and concepts
learnings/          ADRs and patterns for forge itself
```

## What not to touch without a learnings entry

- The state-machine status values in `tasks.status` (`pending|running|awaiting_gate|awaiting_red|complete|failed|blocked_by_red|awaiting_recovery`). Adding a new status is a schema change and an ADR.
- The verdict aggregation rule in `gate.ts`: pass if all reds pass; fail if any authoritative; inconclusive otherwise. Specialist fails warn but don't block without rationale.
- The Docker invocation pattern in `spawn.ts` and `docker/agent-dev-worker.Dockerfile` — non-root UID 1000 agent user, Ubuntu 22.04 base, NOPASSWD sudo scoped to the node_modules shadow-volume chown. Read FORGE-DEC-011 (Docker project-dir mount can corrupt native node binaries) before changing the mount pattern, and FORGE-DEC-025 (containers run docker-detached, survive host-side parent death, FG-536) before changing the spawn lifecycle.
- **Don't add a designer agent that runs Pencil headlessly.** FORGE-DEC-014 documents three independent reasons this fails in Pencil 0.2.5. Design runs via `forge design` — a tracked host-side session the user drives interactively with Pencil MCP. Revisit only if Pencil ships auto-save AND a headless persistence path.

## Documentation

`README.md` is one-screen orientation. `docs/quick-start.md` is end-to-end. The `how-to-*.md` files cover starting each workflow type, adding new agents/workflows, and writing/running tests (`docs/how-to-testing.md`). `docs/concepts.md` is the glossary. This file (`docs/repo-guide.md`) is the volatile repo-orientation prose that `CLAUDE.md` links to rather than hand-carrying.

If you change a CLI flag or rename a primitive, update the relevant doc in the same commit.

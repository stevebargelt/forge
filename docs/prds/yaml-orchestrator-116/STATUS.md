# v2 status — end of pairing block 2026-05-13

Picking up where we left off. Branch: `yaml-orchestrator-116`.

## Commits on this branch (since main)

```
2ec915f v2: compose system prompt + task package framing
687ac25 v2: resolver + runtime YAML → docker args translator
c44feb2 v2: Zod schemas + YAML loader + all 7 drafts validating
f1e1445 v2: schema + workflow drafts + runner sketch (#116 design)
```

419/419 tests passing. typecheck clean.

## What got built

### Design layer (commit f1e1445)
- `SCHEMA.md` — full schema spec, two YAMLs (Workflow + Runtime), 4 open questions parked
- `RUNNER-SKETCH.md` — pseudocode for the runner; LoC estimate ~800
- `AGENTS.md` — agent-dir shape (unchanged from today: CLAUDE.md + settings.json)
- `README.md` — orientation
- 7 workflow drafts + 1 runtime draft, **all schema-validated**

### Code layer (commits c44feb2, 687ac25, 2ec915f)
- `src/v2/schema.ts` (~250 LoC) — Zod schemas for Workflow + Runtime with field-level refinements: duplicate IDs, depends_on/on_reject/fanout targets, cycle detection, manual-step rules, gate-verdict-requires-reds, default model alias requirement.
- `src/v2/loader.ts` (~75 LoC) — reads YAML from `~/.forge/` with project override at `<project>/.forge/`. Field-pathed Zod error formatting.
- `src/v2/resolve.ts` (~50 LoC) — `${VAR}` + `${VAR:-default}` substitution. expandTilde for `~/foo`.
- `src/v2/spawn.ts` (~110 LoC) — runtime YAML → docker argv. Implements all 4 auth modes (env-snapshot default, mount opt-in, apikey, oauth-volume).
- `src/v2/compose.ts` (~60 LoC) — system prompt composition. Reuses existing `src/spine/constraints.ts`.

Plus matching `.test.ts` files for each. Total v2 LoC: ~550 implementation + ~600 tests. PRD's 400-600 estimate landed close.

## What's next

The runner itself — `src/v2/runner.ts`. That's the topological-walk-with-parallel-within-wave loop, step dispatch with reds, fanout dispatch, manual-step handling. RUNNER-SKETCH.md has the pseudocode.

Then:
- `forge new` wiring to read inputs from workflow YAML's `inputs:` block
- Install layer (`seeds/agents/` → `~/.forge/agents/` already done; `runtimes/` is new)
- Cutover: delete `src/spine/{dispatch,spawn,spawnRed,next,composeSystemPrompt}.ts` and `src/workflows/*.ts`

## Open questions still unresolved (from SCHEMA.md)

1. `fanout.from_upstream.step` — explicit step name required, or "previous step" implicit? Drafts use explicit. Lean: keep explicit, it's unambiguous in DAGs.
2. `workflow_additions` template variable substitution? Today no, drafts assume no. Lean: keep no, agents read `inputs.*` directly.
3. `inputs.upstream[*]` in DAG world — direct deps only, or transitive? Lean: direct deps. Mirrors today's "previous phase."
4. Per-step result schemas via `result_schema:` block? Lean: defer to later, validation lives in the agent's CLAUDE.md today.

These don't block the runner; they're refinements that can settle as we wire it up.

## Decisions locked this block

- Per-project override: `<project>/.forge/workflows/<name>.yml` (matches workspace structure, allows multiple workflows per project)
- Reds block: list of dicts (explicit, extensible)
- Gate: step-level `gate: human|verdict|auto|none`
- DAG via `depends_on`; runner walks topologically with parallel-within-wave (parallel reds attach independently to a step)
- Manual steps: `manual: true` instead of `agents: []` (more explicit)
- Template syntax: `${VAR}` and `${VAR:-default}`; NOT Jeff's `{{VAR}}` (caught + fixed mid-session)
- Input names: lower-kebab (matches step IDs + CLI flag form; rejected snake_case `design_dir`)
- Deps: `zod ^4.4.3`, `yaml ^2.9.0` — installed, lockfile committed

## Findings worth keeping

- Jeff's runner: purely linear, zero concurrency. Schema has no parallel primitive.
- Terry's runner: also linear. **But** Terry's PM-prompt template explicitly emits a DAG with `depends_on` per work package. Schema declares deps; runner walks linearly in topological order. We're adding "parallel within wave" on top — minimal addition.
- Fanout is already in production in forge today (`investigation`, `codebase-assessment`). v2 schema models it via `fanout.from_upstream`, not invented.
- Container Chrome on `:9222` (from #128) is invisible to the runner — entrypoint script handles it.

## Quick smoke test for next session

```bash
cd ~/code/forge
git checkout yaml-orchestrator-116
npm run typecheck   # clean
npm test            # 419/419 passing
```

To see the runner skeleton come together, start with `RUNNER-SKETCH.md`. The
hard work is the topological walk + parallel-wave dispatch — everything else
is plumbing using the modules already built.

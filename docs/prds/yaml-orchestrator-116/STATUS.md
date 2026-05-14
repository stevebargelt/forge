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

Three parallel tracks. Pick the order that matches your appetite.

### Track 1 — Runner core
`src/v2/runner.ts`: topological-walk-with-parallel-within-wave, step dispatch with reds, fanout dispatch, manual-step handling. RUNNER-SKETCH.md has the pseudocode. Plus:
- `forge new` wiring to read inputs from workflow YAML's `inputs:` block
- Install layer (`seeds/agents/` → `~/.forge/agents/` already done; `runtimes/` is new)
- Cutover: delete `src/spine/{dispatch,spawn,spawnRed,next,composeSystemPrompt}.ts` and `src/workflows/*.ts`

### Track 2 — Orchestrator surface
- Write the orchestrator prompt template (adapted from Jeff's `project-orchestrator.md`, tuned for forge). Lives at `seeds/orchestrator-claude.md`.
- `forge init` command writes the orchestrator template into a project's `CLAUDE.md` (or appends to existing one).
- Audit `forge status` / `forge gate` / `forge next` CLI for stable JSON output mode (`--json` flag). Orchestrator needs this to parse status reliably.
- Document the orchestrator workflow in `docs/concepts.md` / `docs/quick-start.md` (or new `docs/how-to-orchestrator.md`).

### Track 3 — Agent rename pass
- Rename seed dirs: `architect → architecture-advisor`, `planner → tech-lead`, `implementer → engineer`, `verifier → qa-engineer`, `frontend-implementer → frontend-specialist`, `backend-implementer → backend-specialist`, `infosec-implementer → security-advisor`, `investigator → research-specialist`.
- Update all 7 workflow YAML drafts to reference new names.
- Update `specialistAgent()` callers + `_agentRefs.ts` discipline mappings.
- Add `agentic-platform-builder` seed for full-stack/cross-cutting work.
- Verify nothing in `src/spine/` hardcodes the old names that survives v2 cutover (most spine code dies at cutover anyway).

The rename touches the most files but is mechanical. Doing it before runner code is sane — keeps the v2 runner from being written against names that get renamed later.

## Open questions still unresolved (from SCHEMA.md)

1. `fanout.from_upstream.step` — explicit step name required, or "previous step" implicit? Drafts use explicit. Lean: keep explicit, it's unambiguous in DAGs.
2. `workflow_additions` template variable substitution? Today no, drafts assume no. Lean: keep no, agents read `inputs.*` directly.
3. `inputs.upstream[*]` in DAG world — direct deps only, or transitive? Lean: direct deps. Mirrors today's "previous phase."
4. Per-step result schemas via `result_schema:` block? Lean: defer to later, validation lives in the agent's CLAUDE.md today.

These don't block the runner; they're refinements that can settle as we wire it up.

## Decisions locked this block

### Schema mechanics
- Per-project override: `<project>/.forge/workflows/<name>.yml` (matches workspace structure, allows multiple workflows per project)
- Reds block: list of dicts (explicit, extensible)
- DAG via `depends_on`; runner walks topologically with parallel-within-wave (parallel reds attach independently to a step)
- Manual steps: `manual: true` instead of `agents: []` (more explicit)
- Template syntax: `${VAR}` and `${VAR:-default}`; NOT Jeff's `{{VAR}}` (caught + fixed mid-session)
- Input names: lower-kebab (matches step IDs + CLI flag form; rejected snake_case `design_dir`)
- Deps: `zod ^4.4.3`, `yaml ^2.9.0` — installed, lockfile committed

### Conversational entry — orchestrator pattern (locked 2026-05-13 late pairing)

**v2 is agent-driven, not flag-driven.** Adopted Jeff's project-orchestrator pattern after reading his repo + confirming the model. Mechanics:

- User runs `claude` in their forge project root. The project's `CLAUDE.md` (or a forge-provided template the user pastes into theirs) IS the orchestrator system prompt.
- Orchestrator classifies the user's request; for pipeline work, invokes `forge new <workflow> "title" --brief "..."` via Bash.
- `forge new` (host TS process, our v2 runner) walks the workflow YAML and dispatches per-step containers. Same path as today's `forge new` from a script.
- For gates, orchestrator queries `forge status`, reads upstream artifacts, decides whether to advance (`forge gate <task> --advance`) or escalate to the human.

**One layer fewer than Jeff.** Jeff has: Claude Code → `bash run-orchestrator.sh` → pipeline-runner-container → per-step containers. Forge has: Claude Code → `forge new` (host process, no wrapping container per FORGE-DEC-004) → per-step containers.

**No new CLI command needed.** The user just runs `claude`. No `forge chat` or `--add-dir` plumbing. The orchestrator agent prompt lives in the project's `CLAUDE.md`, auto-loaded by Claude Code from the working directory like any other project instructions file.

### Gate defaults — autonomous with explicit-opt-in for human (locked 2026-05-13)

**v2 default: `gate: auto` per step. Orchestrator decides whether to advance.** Matches Jeff's `approval: final` default (only the last step gates; others flow through). YAML can declare `gate: human` per-step explicitly when human taste is needed; `gate: verdict` stays for red-aggregation steps.

The orchestrator-as-gate-verifier pattern is proven (Jeff already does it — read approval-request.json, decide, write approval-response.json). For forge: orchestrator reads upstream artifact, forms an opinion, advances or escalates. Steven's discovered already-existing pattern: he was using me ad-hoc to verify planner output during v1 runs. v2 formalizes this — the orchestrator IS the verifier by default.

**Forge today has the opposite default** (5 human gates per feature run). v2 cutover flips this. Auditable record still exists in SQLite (every advance writes a gate row); just orchestrator-mediated instead of human-mediated for routine cases.

### Planner / tech-lead — stays, but reframed (locked 2026-05-13)

Confirmed Jeff has NO planner in his pipelines (`pm → arch → engineer → qa → ux-uat` is his full shape; engineer reads architecture and decides scope directly). But forge keeps a planner because:

- Forge's pipeline is more complex than Jeff's (reds, retries, DAG fanout aspirations) — more places for plans to go wrong
- The planner's output is a structured artifact the orchestrator can verify (Steven's actual v1 usage pattern)
- When #96 sub-shift 3 lands (DAG fanout in build), the planner emits the DAG — load-bearing

**Rename to `tech-lead` deferred — naming preference, not architectural. Will lock during agent-rename pass.**

### Agent renames — Jeff's vocab, partial adoption (locked 2026-05-13)

Adopt Jeff's naming for roles where it's clearly better; keep forge-specific names where the role doesn't exist in Jeff's world:

| Today | v2 |
|---|---|
| `architect` | `architecture-advisor` |
| `planner` | `tech-lead` |
| `implementer` | `engineer` |
| `verifier` | `qa-engineer` |
| `frontend-implementer` | `frontend-specialist` |
| `backend-implementer` | `backend-specialist` |
| `infosec-implementer` | `security-advisor` |
| `investigator` | `research-specialist` |
| `framer` / `synthesizer` / `recommender` / `assessor` / `reporter` / `prompt-author` | KEEP — forge-specific workflow roles, no Jeff equivalent |
| `red-wide` / `red-narrow` / `red-frontend` / `red-backend` / `red-security` | KEEP — forge's adversarial-review layer, no Jeff equivalent |

Plus add `agentic-platform-builder` for genuine full-stack/cross-cutting work (System Map, dashboard pill row, #128 were all cross-cutting). Wired via `discipline: platform` when DAG fanout lands.

**Decision deferred:** rename prompts vs. rename + evolve. Lean rename-only for v2 cutover; evolve prompts incrementally after.

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

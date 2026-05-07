# forge — backlog

Canonical task list for forge. Numbers are sticky across sessions and referenced from commit messages (e.g. `fixes #30`, `partial #25`). New items get the next available sticky ID and never get renumbered.

When you start a session, read this file. When you finish, update it: move closed tasks from "Active" / "In progress" to "Done (recent)" with their commit hash; rewrite "Notes for next session" with whatever the next session needs to know.

## Notes for next session

End of 2026-05-07 session. Four prior backlog items closed (#26, #29, #30 + blue follow-up, partial #25). New cred architecture (FORGE-DEC-013) shipped: SSO watchdog detached + PID-tracked, bedrock containers mount `~/.aws` + use `AWS_PROFILE` instead of snapshotted STS env vars. Validated end-to-end against an 89K-LOC ObjC iOS codebase via a real `codebase-assessment` run that produced a 22.5KB code review report.

**Suggested next-session priorities (top of Active list, in this order):**
1. **#41** auto-gate-on-terminal-phase — small bug, surfaced when reporter completed but run stayed `active` until next `forge next`. Low-friction fix, high-value cleanup.
2. **#40** batch-gate command — daily friction reducer; fanouts of 8 tasks need 8 separate gate commands today.
3. **#36** persist project_dir on runs — small, prereq for #35.
4. **#37** `forge advise` — small, gives users (and dashboard #35) one place to ask "what's next?"
5. Then any of the dashboard work (#34/#35) when there's a focused chunk of time.

**Validation still pending:**
- #32 (failed-result detection) — code shipped, didn't fire this run because the framer succeeded on retry. Wait for it to catch a real failure or contrive one.
- #25 (reject + `onReject` flow) — no workflow uses `onReject` today; can only validate after writing a workflow that does. Tracked under #25.

**Watchdog status:** the SSO watchdog ran cleanly during the validation run, persisted across multiple `forge next` invocations, stopped on run completion. The "no manual kill needed" goal is met.

## In progress

### #46 — Designer agent + Pencil integration + ui-design workflow
**Status:** v1 code shipped; awaiting live end-to-end run (the dashboard-redesign test).
**What's in:**
- `seeds/agents/designer/` + `seeds/agents/designer-export/` seeds.
- `seeds/agents/designer/skills/pencil-design/SKILL.md` (the Claude skill, baked into the designer image).
- `docker/agent-designer-worker.Dockerfile` + `docker/build-designer.sh` (FROM agent-dev-worker, adds Pencil CLI + skill).
- `src/types/index.ts`: `AgentRef.image` optional override; `WorkflowName` adds `ui-design` + `design-revise`.
- `src/spine/spawn.ts`: forwards `PENCIL_CLI_KEY` to the designer image only (3 unit tests).
- `src/cli/commands/new.ts`: `--brief` option + workflow name list updated.
- `src/workflows/ui-design.ts` + `src/workflows/design-revise.ts`. Single-task design phases (no fanout) — coherence comes from `pencil --in <prior>.pen` chaining within one task.
- **stream-json output mode for ALL agents** (not designer-specific). Surfaced when designer's first run hit the 5-min idle timeout: `claude --output-format json --print` buffers everything until the agent finishes — silent stdout for the entire run. With `--output-format stream-json --verbose --print`, Claude emits NDJSON in real time (system init, status, tool use, assistant text, then the final result envelope as the last line). The watchdog now sees continuous progress and only fires when the agent is genuinely stuck. The result envelope shape is unchanged, so `_readResultJson` works as-is; 4 new tests cover the NDJSON shape.
**What's not in (deferred):**
- Optional design phase on `feature-design-needed` (was task 10; deferred to its own follow-up after ui-design lands).
- Live run + screenshots — staged as the dashboard-redesign test.
**Test plan:** `forge new ui-design --project /Users/steven.bargelt/code/forge --brief "..."` redesigning the forge dashboard. 5 screens, single task in `design` phase, soft style constraints in brief.

## Active

### #25 — Validate reject + onReject flow end-to-end
**Why:** `onReject` is documented but no workflow uses it. The code path (rationale propagation into the remediation phase) was fixed in `d075f9f` but never exercised. Until a workflow uses it, we're trusting the unit tests.
**How to apply:** When writing a new workflow that needs branching on rejection (a natural fit for #42's how-to rewrite), exercise the path in a real run. Verify `inputs.rejectedRationale` and `inputs.rejectedTaskId` arrive at the remediation phase's tasks.

### #27 — LiteLLM + cost rollup
**Why:** `model_calls` table exists but is empty. No cost telemetry today; can't answer "what did this run cost?" or "which model was used per task?"
**How to apply:** Opt-in via `FORGE_USE_LITELLM=1` env var. Wire LiteLLM proxy responses to populate `model_calls` rows. Aggregate per-run/per-task costs for `forge status` and the dashboard.
Related: #38 (capture agent model on the task row) is upstream of this — once both land, dashboard task panes can show role + model + tokens + cost.

### #28 — Per-run constraint scoping (forge new --tag, tags: in constraint frontmatter)
**Why:** The `atlas-stack-rn` constraint fires on every `feature-design-needed` run regardless of project. Today the workaround is renaming the constraint file to `.disabled`, which is global. Real fix is per-run scoping.
**How to apply:** Add `--tag <tag>` to `forge new`. Add `tags: [...]` to constraint frontmatter. Constraints fire only when the run's tag matches one of the constraint's tags (or the constraint has no tags = global, current behavior).

### #33 — Resolve workflowAdditions vs base output schema conflict
**Why:** Hit a real failure: framer's base CLAUDE.md says output `{claims, experiments}` while `codebase-assessment.scope.workflowAdditions` says output `{lenses, priorities}`. The composed prompt had both schemas — the agent saw two contradictory contracts and asked for clarification instead of obeying either.
**How to apply:** Two design options to discuss before implementing:
1. `workflowAdditions` explicitly replaces the base schema. `composeSystemPrompt` emits a marker that overrides the base — agent obeys the most-specific schema.
2. Make workflows reference roles whose base CLAUDE.md already matches the workflow's schema (e.g. don't reuse `framer` for scoping if its schema is investigation-shaped).
Lean toward (1).

### #34 — Dashboard: human-readable result view with raw toggle
**Why:** Today the dashboard renders agent results as a raw JSON code block. For results with structure (lenses, findings, decisions), that's dense and hard to scan.
**How to apply:** Per-task view toggle. Default = human-readable: render headings for top-level keys, nested objects as sections, arrays as bullet/numbered lists, severity badges for findings, render markdown `report` fields as HTML (already partly works). Raw view = existing JSON code block. Toggle remembered in URL (`?view=raw`) so links can target either.

### #35 — Dashboard: gate buttons + run-next + "what's next" surfacing
**Why:** Dashboard is read-only today; all driving still happens in the CLI. From the dashboard you can see state but can't act on it. Five sub-pieces:
1. "What's next" banner per run (awaiting gate / running / blocked / complete).
2. Gate action buttons for `awaiting_gate` tasks (advance / request-changes / reject + rationale field).
3. "Run next phase" button that triggers `forge next`.
4. Project path stored on the run (#36).
5. Dashboard shells out to the `forge` CLI for actions; doesn't reimplement spawn/gate logic.
Localhost-only is the security model; document this.

### #36 — Persist project_dir on the runs table
**Why:** `--project` is required on every `forge next` today. Users have to remember the path each time; the dashboard can't know it. Prereq for #35.
**How to apply:** Add `project_dir TEXT` to the runs table. Populated on first `forge next --project ...`. Subsequent calls without `--project` use the stored value. New `--project` overrides and updates the stored value (warn on change).

### #37 — `forge advise` — print recommended next command for a run
**Why:** Users (and #35's dashboard) need a "what should I run next?" answer. Today that knowledge lives in my head when I'm pairing with the user.
**How to apply:** New CLI command `forge advise <run-id>`. Reads run state, picks the right action, prints the literal command to copy (`forge gate task-... advance` / `forge next ... --project ...`). Doesn't execute. Also reusable as the surfacing logic for #35.

### #38 — Capture agent model on the task row
**Why:** `AgentRef.model` is resolved at spawn time (BEDROCK_MAP / DIRECT_MAP / LiteLLM logic) but never persisted. Dashboard can show `agent_role` but can't tell which model actually ran.
**How to apply:** Add `agent_alias TEXT` (logical name like `spec-writer`) and `agent_model TEXT` (resolved id like `us.anthropic.claude-sonnet-4-6`) to the tasks table. Populate in `createPhaseTasks` and `spawnRed` from the AgentRef. Surface in dashboard task panes. Prereq for #27 cost rollups.

### #39 — Audit the spawn → DB pipeline for missing fields (meta-task)
**Why:** SQLite is supposed to be the canonical audit trail of a run, but several runtime-observable values never make it to the DB (resolved model #38, agent prose replies #32 partly, model_calls #27, container start time, watchdog state). Run an audit after #32/#38/#27 land to find what's still missing.
**How to apply:** Walk `spawn.ts`, `dispatch.ts`, `spawnRed.ts`, `gate.ts`. For each runtime-observable piece of state, decide if it belongs in the DB. Output is a punch-list of additional schema fixes, not a rewrite. Each surfaced item becomes its own task.

### #40 — `forge gate <run-id> advance` — batch-gate a fanout
**Why:** Fanouts produce N tasks (one per lens, per claim, per anything). Gating each one separately is friction. Validated as a real annoyance during the topaz-mobile review (8 lens assessors needing 8 separate `forge gate ... advance` commands).
**How to apply:** New form: `forge gate <run-id> advance` finds all `awaiting_gate` tasks in the run and applies the decision to each. Probably advance-only initially (request-changes/reject typically need per-task rationale). Could extend later with `--rationale` for uniform application.

### #41 — Auto-gate on terminal phase should mark run complete
**Why:** When the last phase has `gate: "auto"`, the task gets marked complete by `dispatch.ts` but `run.status` stays `active` until the next `forge next` is called. The user has to type `forge next` twice — once to dispatch, once to "discover" the run is done. Confirmed during topaz-mobile-review-v2.
**How to apply:** Either: (a) `dispatch.ts` calls `updateRunStatus(run.id, "complete")` and `stopSsoWatchdog()` when auto-gating a task whose phase has no successor; or (b) `next.ts` proactively checks at the top whether all tasks in the terminal phase are complete and finalizes there before doing anything else. (b) is cleaner — keeps the "run is done when no more work remains" invariant in one place.

### #42 — Rewrite docs/how-to-new-workflow.md with a workflow we don't already have
**Why:** Current example is `code-review` which duplicates the existing `codebase-assessment` workflow. The doc reads as a paper exercise. Replace with a workflow forge actually doesn't have, ideally one that exercises a primitive we've built but not documented (`onReject` branching, gate=verdict + fanout combo, multi-authority red panels).
**How to apply:** Brainstorm the right new workflow first. Candidates: a workflow that uses `onReject` (also closes #25 validation); a workflow with both authoritative and specialist reds across phases; a workflow that genuinely needs a new role (forces also exercising `how-to-new-agent.md`).

### #43 — Dashboard three-pane CSS layout
**Why:** Implementer built a drill-in flow (click run → see tasks → click task → see detail) instead of the three-pane simultaneous view the PRD intended. Functional but slower for comparisons. ~5 min CSS fix per the original handoff.
**How to apply:** `src/dashboard/html.ts`. Side-by-side panes for runs / tasks / task-detail.

### #44 — `npm test` glob portability inside containers
**Why:** `npm test` script uses a glob that doesn't expand the same way in container vs host shell. Implementer worked around it with explicit file paths during the dashboard run.
**How to apply:** Make the test script portable so it works in both bash and the agent container's environment.

### #45 — `forge auth status` warns on stale bedrock vars
**Why:** SSO sessions expire silently (1 hour at SGWS). The next spawn fails on auth. With FORGE-DEC-013 the watchdog usually prevents this, but `forge auth status` should still proactively detect-and-warn when bedrock creds are getting close to expiry, similar to the watchdog's threshold check.
**How to apply:** When `detectCredsMode()` returns `bedrock`, call the same `_sso_min_remaining`-style check the watchdog uses. If under some threshold (15 min?), print a warning.

### #46 — Designer agent + Pencil integration + ui-design workflow
**Why:** No way to produce visual UI artifacts from forge today. Pencil (`@pencil.dev/cli`) is a headless design tool that turns prompts into `.pen` files and exports them as images. We want a designer blue agent that uses Pencil to produce screen-by-screen designs, with humans gating revisions, and a final phase that exports HTML+Tailwind from the approved `.pen` files. Also wanted: a way to design new apps from scratch *and* revise existing app designs.
**How to apply:**
1. **New container image** `agent-designer-worker` (separate from `agent-dev-worker` to avoid bloating it with Pencil's deps). Includes Node, Claude Code CLI, `@pencil.dev/cli`. Mounts `forge-claude-oauth` so Pencil's inner Claude agent has auth (oauth-only — `ANTHROPIC_API_KEY` is against company policy). Reads `PENCIL_CLI_KEY` from host env (from `.env` for now; see #47 for proper secrets).
2. **Designer seed** `seeds/agents/designer/CLAUDE.md` + role-specific `system.md`. Job: take a brief, decide screen list, produce one Pencil prompt per screen, run Pencil, return paths to `.pen` + `.png` and a short rationale per screen.
3. **Three workflows:**
   - `ui-design` — standalone. Phases: `discover` (designer proposes screen list) → `design` (fanout, one task per screen) → `human-review` (awaiting_gate; revision = reject + rationale loop) → `export-code` (HTML + Tailwind v1; React Native deferred to #50).
   - `design-revise` — input: existing `.pen` file(s) + revision brief. Phases: `revise` → `human-review` → `export-code`.
   - Extend `feature-design-needed` with an optional design phase (gated by `withDesign: true` workflow flag).
4. **Revision loop:** reuse `awaiting_gate`; revision = reject + rationale (designer reads rationale, uses Pencil's `--in` flag to iterate). Hard reject still available for "way off base."
5. **CLI gate-and-rationale only for v1.** Dashboard review UI tracked separately as #48 — unblocks once forge can design its own dashboard via Pencil.
6. **Code export:** final phase reads approved `.pen` JSON (which is structured) and produces HTML+Tailwind. Pencil itself only exports to image/pdf, not code.

### #47 — Use `pass` for host-side secret storage (PENCIL_CLI_KEY, others)
**Why:** Plaintext secrets in `.env` are fine for a single-machine personal setup but not durable. Terry's repo (cite when implementing) demonstrates a `pass`-backed pattern. Forge will accumulate more secrets (Pencil key, future API keys, integration tokens) — get the pattern right once.
**How to apply:** Wrapper that resolves env vars from `pass` entries when configured, falls back to env. Document in `docs/auth.md` or similar. Roll forward existing `PENCIL_CLI_KEY` consumer from #46 to use it. Locate Terry's specific implementation before designing.

### #48 — Dashboard support for design review (image render, comments, approve/revise buttons)
**Why:** v1 of #46 ships with CLI-only gate-and-rationale. The intended UX is in-dashboard review — see the rendered design, comment, click approve or request revision with a rationale field. This is the right human review surface for design work.
**How to apply:** Overlaps with #34 (human-readable result view) and #35 (gate buttons). Render `.png` exports inline in task panes; comment thread tied to a task; approve/revise buttons that write back to the task as gate decisions. Sequence after #46 ships v1 so we have real designs to render — and use forge+Pencil to design the dashboard itself.

### #49 — Design-reviewer red agent (future investigation)
**Why:** Steven's call: skip reds for design work in v1 because aesthetic judgment is squishy. Worth revisiting once we have real human-review data — there may be objective things a red can catch (accessibility contrast, missing states, broken layout primitives, brand inconsistency).
**How to apply:** Investigate after a few `ui-design` runs ship and we see what humans actually flag. Could be one specialist red ("a11y") rather than an authoritative aesthetic judge.

### #50 — React Native code export from Pencil .pen files
**Why:** v1 of #46 only exports HTML+Tailwind. Mobile design eventually needs RN. Harder than HTML because RN's layout primitives don't map cleanly from a free-form design tool — Flexbox-only, no grid, different typography model.
**How to apply:** New phase or new `--target rn` flag on the `export-code` phase. Probably needs its own designer-export-rn role. Validate by exporting one screen end-to-end before committing to the approach.

## Done (recent)

### #25 — Propagate reject rationale to onReject phase + tell blues about retry inputs (partial)
**Closed:** 2026-05-06, commit `d075f9f`
**Followup tracked above:** end-to-end validation requires a workflow that uses `onReject`, which doesn't exist yet. See #25 in Active.

### #26 — Stuck-task detection via idle-stdout watchdog
**Closed:** 2026-05-06, commit `aca548e`
Added `startIdleWatchdog`. Container killed if no stdout for 5 min (configurable via `FORGE_AGENT_IDLE_TIMEOUT_MS`). Five unit tests.

### #29 — DB-lock contention between concurrent forge invocations
**Closed:** 2026-05-06, commit `7c87274`
Added 5s `busy_timeout` on the SQLite singleton. Optional `{readOnly: true}` flag on `getDb()`. `forge show` always read-only; `forge status` accepts `--read-only`. ADR FORGE-DEC-012 (commit `cc61d92`).

### #30 — Red agents told about /project mount (+ blues, follow-up)
**Closed:** 2026-05-06, commits `57d16ff` (reds) + `5a9ded1` (blues, follow-up)
Both red seeds and all 9 non-implementer blue seeds got a `## Reading the project` section. Validated against the topaz-mobile review: reds gave evidence-cited verdicts with file:line citations, framer + assessors all read the codebase.

### #31 — Document forge dashboard in README + docs/quick-start.md
**Closed:** 2026-05-07, commit `676a27e`
Also fixed stale bedrock instructions in quick-start.md that referenced the pre-FORGE-DEC-013 design.

### #32 — Fail tasks whose result.json is empty/non-JSON-text
**Closed:** 2026-05-07, commit `f7cd71c`
Discovered when the framer's first run produced prose instead of JSON and was silently marked complete. Two cooperating bugs: `readResultJson` returned the envelope when the inner `result` was prose; `spawn`'s `reportedStatus` defaulted to `"complete"` on missing status. Both fixed; reconcile got the same treatment. Nine new tests.

### FORGE-DEC-013 — Profile-mount + detached watchdog
**Closed:** 2026-05-06/07, commits `21e79de` + `93d6a8b` + `41e2e6b` + `f860dbc` + `e5755b9`
Bedrock containers now mount `~/.aws` read-only and use `AWS_PROFILE`; STS env-var snapshotting removed. Detached host-side SSO watchdog with PID-file lifecycle keeps creds fresh in the background, survives forge process exits, auto-stops on run completion. Drop-in of Terry's `run-sso-watchdog.sh` with attribution. ADR + index entry.

## Done (archived)

(Nothing here yet. Periodically promote items from "Done (recent)" once they're old enough that nobody references them.)

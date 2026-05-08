# forge — backlog

Canonical task list for forge. Numbers are sticky across sessions and referenced from commit messages (e.g. `fixes #30`, `partial #25`). New items get the next available sticky ID and never get renumbered.

When you start a session, read this file. When you finish, update it: move closed tasks from "Active" / "In progress" to "Done (recent)" with their commit hash; rewrite "Notes for next session" with whatever the next session needs to know.

## Notes for next session

**End of 2026-05-07 (late). Big architectural pivot on #46 — see FORGE-DEC-014.**

The full day was spent trying to put a designer agent in a container, driving Pencil headlessly. **It can't be done in Pencil 0.2.5.** Three independent dead-ends, each confirmed empirically:

1. `pencil --prompt` spawns an inner Claude that asks for permission and stalls in containers (no way to skip).
2. `pencil interactive`'s `save()` is a no-op — Pencil has no auto-save and no programmatic save (https://docs.pencil.dev/troubleshooting). The .pen file only persists when the human presses Cmd+S in VS Code.
3. Pencil's MCP server binary requires `--app <name>` pointing at a running Pencil GUI app; there's no such app in our container.

**Pivot: forge becomes a prompt-author for design, not a designer.** A new `prompt-author` agent (running in a normal forge container) interrogates the human and produces a `PROMPT.md` containing all the workflow rules we discovered. The human runs that PROMPT.md in their host's Claude Code with VS Code as the editor host. Pencil works perfectly there — produced 5 coherent screens with full design system in the validation runs at `~/code/forge-design/designs/`.

**Validation:** `~/code/forge-design/dashboard.pen` (not committed; in-VS-Code) plus the 5 PNG exports represent a real Lunaris-styled forge dashboard mockup. Quality is high enough to drive the dashboard rebuild (#34/#35/#48) directly.

**Architectural consequences:**
- Container-based designer code is now dead (the `agent-designer-worker` image, `designer` + `designer-export` seeds, `AgentRef.image` plumbing). Tracked as #58 (cleanup).
- The `ui-design` and `design-revise` workflows need a complete rewrite — no agent-led design phase, just `brief` (prompt-author, gate=human) + `review` (gate=human, captures artifact paths). Tracked as #54 + #55.
- The `prompt-author` primitive is reusable beyond design (marketing copy, code review prompts, architecture briefs). Tracked as #53.

**Suggested next-session priorities (top of Active list, in this order):**
1. **#53** Build the `prompt-author` agent seed + ui-design PROMPT.md template. The keystone of the new architecture. Validates everything FORGE-DEC-014 says.
2. **#54** Rewrite `ui-design` workflow to the new shape. Small, depends on #53.
3. **#56** Run a *second* Pencil pass to fill design gaps (run-next button, new-run flow, blocked_by_red variant, human-led-design dashboard screens). Cheap (~30 min in Pencil) and unblocks dashboard implementation.
4. **#57** Start interactive dashboard implementation against the now-complete design spec. Depends on #56.
5. **#58** Tear down container designer code in a clean cleanup commit.
6. Returning daily-friction items for any spare time: **#41** (auto-gate-on-terminal-phase), **#40** (batch-gate), **#36** (persist project_dir).

**Validation still pending:**
- #32 (failed-result detection) — code shipped, didn't fire this run because the framer succeeded on retry. Wait for it to catch a real failure or contrive one.
- #25 (reject + `onReject` flow) — no workflow uses `onReject` today; can only validate after writing a workflow that does. Tracked under #25.

**Watchdog status:** the SSO watchdog ran cleanly during the validation run, persisted across multiple `forge next` invocations, stopped on run completion. The "no manual kill needed" goal is met.

**Work-in-progress branch:** all #46 commits live on `designer-agent-46` (12 commits ahead of main as of 2026-05-07). Don't merge as-is — most become obsolete with #58. The few worth keeping (cherry-picks for main):
- `58480ec` "Improve Next: hints in CLI: include --project, copy-friendly layout" — pure CLI UX, no designer dependency
- `099d54e` "forge next: surface awaiting_gate / blocked_by_red after dispatch" — real bug fix, not designer-specific
- `b5d2acf` "Switch agent stdout to stream-json so the idle watchdog tracks live progress" — applies to all agents
- `9e8d466` "Disable idle watchdog for designer image; emit partial-message stream-json" — keep `--include-partial-messages`, drop the designer-specific `pickIdleTimeoutMs` once #58 lands
The rest (designer Dockerfile, designer seeds, MCP-server wiring, --custom flag instructions, etc.) all die with #58.

## In progress

### #46 — Designer agent + Pencil integration + ui-design workflow (SUPERSEDED by FORGE-DEC-014)
**Status:** Container-based v1 abandoned. Architectural pivot decided 2026-05-07. See [FORGE-DEC-014](learnings/decisions/2026-05-07_host-led-pencil-design.md). Replaced by **#53** (prompt-author seed) + **#54** (ui-design rewrite) + **#55** (design-revise rewrite) + **#58** (cleanup of container designer code).
**Why the pivot:** Pencil 0.2.5 has no headless save mechanism. `pencil --prompt` stalls on inner-Claude permissions; `pencil interactive --save()` writes 0 bytes; Pencil's MCP server requires a GUI app. The .pen file only persists when the human presses Cmd+S in VS Code. The new model has forge author the prompt and the human run it on the host, where Pencil works correctly.
**What survived (good for cherry-pick to main):**
- `--include-partial-messages` + `--output-format stream-json --verbose` in `spawn.ts` — keeps stdout flowing during long thinking turns. Belongs to all agents, not just designer.
- Idle watchdog opt-out via `pickIdleTimeoutMs(image, ...)` — useful pattern even outside designer (some long-running phase might want it later).
- CLI `Next:` hint improvements (`forge next` / `forge gate` / `forge new` printing the next command on its own line with `--project`).
- The reflection that **forge needs to surface awaiting_gate after dispatch when phases land in awaiting_gate immediately** (was a real bug, fixed).
**What dies (cleanup #58):**
- `docker/agent-designer-worker.Dockerfile`, `docker/build-designer.sh`
- `seeds/agents/designer/`, `seeds/agents/designer-export/`
- `AgentRef.image` plumbing in `spawn.ts` and dispatch.ts (only used by designer)
- `PENCIL_CLI_KEY` forwarding for the designer image
- `src/workflows/ui-design.ts` and `src/workflows/design-revise.ts` (rewritten under #54/#55)

## Active

### #53 — `prompt-author` agent seed + ui-design PROMPT.md template
**Why:** Per FORGE-DEC-014, forge's role in design becomes "author the prompt, the human runs it." The `prompt-author` agent is a generic prompt-elicitation primitive: interview the human about brief / screens / style / paths / constraints, fill the right template, output a `PROMPT.md` file path. ui-design is the first consumer; future consumers (marketing-copy, code-review, architecture-review) will use the same primitive with different templates.
**How to apply:**
- New seed: `seeds/agents/prompt-author/CLAUDE.md`. Interview structure: brief / screens (or sections) / style guidance / target paths / constraints / known gotchas. Output schema: `{status, promptPath: "...", brief, screens?, notes}`.
- New seed: `seeds/agents/prompt-author/templates/ui-design.md` — parameterized PROMPT.md. Variables: `{{target_pen_file}}`, `{{output_dir}}`, `{{screens_list}}`, `{{style_guidance}}`, `{{brief}}`, `{{file_naming}}`. Encodes: touch precondition, open_document + verify, filePath everywhere, find_empty_space_on_canvas, export+rename, loud Cmd+S warning, stat-verification step.
- A drafted, validated version lives at `~/code/forge-design/PROMPT.md` — use as the canonical reference when authoring the template.
- The agent runs in `agent-dev-worker` (no special image). Standard blue-agent shape.
Validated empirically tonight: this exact prompt produced a complete dashboard design in `~/code/forge-design/`.

### #54 — Rewrite `ui-design` workflow for the new architecture
**Why:** The current `src/workflows/ui-design.ts` (commit `d560b7b`) has phases (discover / design / export) that assume an agent-led design phase. Per FORGE-DEC-014 there is no agent-led design — only an agent-led brief + a human-led design. Workflow shape must change.
**How to apply:** Replace existing phases with:
- `brief` — agent: `prompt-author`, gate: `human`. Output: `{promptPath, brief, screens, notes}`. Human reviews the prompt + gates advance (or request-changes if the prompt isn't right).
- `review` — agent: none (manual phase, gate: `human`). The human runs PROMPT.md outside forge, comes back, gates advance with rationale that includes the artifact paths (`{penFile, pngFiles}`). Forge stores in gate.rationale; dashboard reads from there for #57.
- (Optionally a `code-export` phase later if HTML+Tailwind generation is wanted — but defer until someone actually needs it.)
Depends on: #53.

### #55 — Rewrite `design-revise` workflow for the new architecture
**Why:** Same pivot as #54 but for the iteration case. Input is a previously-saved `.pen` file plus a revision brief.
**How to apply:** Phases:
- `brief` — agent: `prompt-author` with the `ui-design-revise` template. Reads the prior `.pen` file path from inputs; produces a PROMPT.md that opens it via `--in` and applies the requested changes. Verifies the prior `.pen` is non-zero before generating (hard error if 0 — design source was lost).
- `review` — same as #54.
Depends on: #53.

### #56 — Second Pencil pass: design the missing screens
**Why:** The first dashboard design pass (tonight, in `~/code/forge-design/`) covered ~85% of the interactive surface. Five gaps remain:
1. **Run-row "Run next" button + run-level actions** (cancel, abandon, archive)
2. **`forge new` flow** (modal or sidebar palette for kicking off a workflow)
3. **`blocked_by_red` task detail variant** with "Force advance + rationale" override
4. **Human-led design phase screens** for the `ui-design` workflow itself: handoff view (PROMPT.md inline + Cmd+S reminder + "I've completed this" gate), review view (PNG gallery + Approve/Revise gate), complete view (read-only summary)
5. **`prompt-author` interview screen** — what the brief-author looks like in the dashboard (one or two human-facing question cards + answer area)

**How to apply:** Run the prompt-author flow (or just hand-write a focused PROMPT.md for now) targeting these 5 screens against the existing `~/code/forge-design/dashboard.pen`. The existing design system + components + Lunaris palette are already there — use `--in` to chain. Add the new screens on the canvas alongside the existing ones.
**Sequence:** Do this BEFORE #57. The chicken-egg problem (design → discover gaps → revise design → rebuild) is much cheaper paid in Pencil time than in TypeScript+CSS rework.

### #57 — Interactive dashboard v1 (gate buttons, run-next, design review)
**Why:** Today the dashboard is read-only. All driving still happens in CLI. Per dashboard-rebuild plan (#34/#35) and FORGE-DEC-014, the dashboard should be the primary UX. The design from #56 is the spec.
**How to apply:** Build against the screens from #56. Concrete pieces:
- POST endpoints in `src/dashboard/server.ts` for `/api/gate/<task>` (advance/reject/request-changes + rationale) and `/api/next/<run>` (shells out to `forge gate` and `forge next` CLI subprocesses — does NOT reimplement spawn/gate logic).
- Frontend: gate-decision UI matches the awaiting-gate detail screen design (Y1qtm.png from tonight). Localhost-only is the security model; document it in the dashboard server file.
- CSRF mitigation: require a small custom header on all mutating endpoints (e.g. `X-Forge-Request: 1`) so plain HTML form POSTs from other localhost contexts can't reach forge.
- Render PNGs from gate.rationale paths for design tasks (refines #48).
- "Run next" button on the run row (matches design from #56 gap #1).

Depends on: #56 (designs), #54 (ui-design rewrite for the design-task review screens to have something to review).
Replaces / refines / overlaps: #34 (human-readable result view), #35 (gate buttons + run-next + what's-next surfacing), #48 (design review). When #57 ships, those three become "done" by absorption.

### #58 — Tear down container-designer code (cleanup)
**Why:** Per FORGE-DEC-014, the container-based designer is dead. Several hundred LOC + image build infrastructure exists for it on `designer-agent-46` branch and shouldn't merge to main as-is.
**How to apply:** When #53/#54/#55 are in place, delete in one cleanup commit:
- `docker/agent-designer-worker.Dockerfile`
- `docker/build-designer.sh` (and the `designer-skills/` pattern in `.dockerignore`)
- `seeds/agents/designer/` (entire dir, including `skills/pencil-design/SKILL.md`)
- `seeds/agents/designer-export/` (entire dir)
- `AgentRef.image` field on the type + plumbing through `dispatch.ts`, `spawnRed.ts`, `_agentRefs.ts`, `spawn.ts`. The image-override unit test in `spawn.test.ts` goes too.
- The `PENCIL_CLI_KEY` env-var forwarding in `spawn.ts` (designer-image-conditional). Goes with the AgentRef.image cleanup.
- The `image` arg in `_buildDockerArgs` test fixture — simplify back to a single `agent-dev-worker` default.
**Keep:** `--include-partial-messages` and `pickIdleTimeoutMs(image, explicit)` if it's general — but `pickIdleTimeoutMs` was only special-cased for designer; once designer is gone, the function can simplify back to `resolveIdleTimeoutMs`. Decide at delete time.
**Test plan:** `npm run typecheck && npm test` must stay green. The cleanup is mechanical — no behavior change for any non-designer agent.

### #59 — Track Pencil release notes for auto-save shipping
**Why:** Pencil 0.2.5 has no auto-save (https://docs.pencil.dev/troubleshooting). Our PROMPT.md template has a load-bearing "Cmd+S to save dashboard.pen" warning + a stat-verification step. When Pencil ships auto-save, the warning becomes obsolete.
**How to apply:** Periodically run `npm view @pencil.dev/cli version` and check the changelog. When auto-save lands:
- Update the prompt-author template to drop the loud Cmd+S warning + the stat-verification step.
- Test that the .pen file persists without human Cmd+S in a real run.
- Update FORGE-DEC-014 with a "Revisited" note pointing at the simpler flow.
Lightweight: probably one check every couple of months unless we hear about it sooner.

### #60 — Use `pass` for host-side secret storage (was previously #47, kept here as it now applies to PROMPT.md design output)
**Why:** Same as the original #47 — secrets like `PENCIL_CLI_KEY` shouldn't sit in a `.env` file forever. With FORGE-DEC-014 the consumer of `PENCIL_CLI_KEY` moves *out* of forge entirely (it's used by the human's host-side Claude Code, not by a forge container). But forge still touches host-side env in `forge auth` and possibly in future host-side tools. Keeping the entry but renumbered to reflect the architectural pivot.
**How to apply:** When forge needs another host-side secret (e.g., for a future GitHub or Slack integration), build the `pass` wrapper then. Until then, this is dormant.
**Status of original #47:** content unchanged but no longer about PENCIL_CLI_KEY-in-container — it's about whatever host-side secrets forge accumulates next.

### #61 — Electron shell investigation (deferred)
**Why:** The dashboard is becoming forge's primary UX (see #57 + FORGE-DEC-014). At some point it should be a native app, not a localhost browser tab. Native menus, native shortcuts, OS notifications, no "is this exposed to the network?" question, no CORS dance.
**How to apply (when):** Don't rebuild the dashboard in Electron from scratch — wrap the existing thing. Once #57 ships and the SPA is mature:
- `BrowserWindow` loads `localhost:port` (or the bundled SPA HTML)
- Add native chrome (menubar, Cmd+G, Cmd+N, status indicator)
- Distribution is a separate problem (signing, auto-updater) — defer until forge has external users
**Revisit conditions:** the dashboard is doing 80%+ of forge's interaction surface, OR you want notifications/menubar/global shortcuts, OR you want to ship forge to anyone else. Until then, browser tab is fine.
Stays here so it's not forgotten.

### #62 — Design-task vs awaiting-gate: distinct gate-button copy
**Why:** Gate semantics differ between "agent did the work, you approve" and "human did the work, you confirm completion." The dashboard should reflect this distinction in button copy: agent-led phases say "Approve / Send back / Reject"; human-led phases (the `review` phase of ui-design / design-revise after the human ran PROMPT.md) say "I've done the work / I need to pause / I've decided not to do this." Same gate primitive, different verbs.
**How to apply:** Phase definition or task metadata indicates "human-led" vs "agent-led"; dashboard renders gate-button copy accordingly. Small but worth getting right early — it shapes how users mentally model the gate.
Belongs in #57's first cut.


**Why:** `onReject` is documented but no workflow uses it. The code path (rationale propagation into the remediation phase) was fixed in `d075f9f` but never exercised. Until a workflow uses it, we're trusting the unit tests.
**How to apply:** When writing a new workflow that needs branching on rejection (a natural fit for #42's how-to rewrite), exercise the path in a real run. Verify `inputs.rejectedRationale` and `inputs.rejectedTaskId` arrive at the remediation phase's tasks.

### #27 — LiteLLM proxy: route each task to the model best suited to it
**Why:** Today every task hits Anthropic-direct or Bedrock with whatever alias the workflow declared (`spec-writer` → Sonnet, `fast-orchestrator` → Haiku, `deep-thinker` → Opus). That hard-codes provider + family in the workflow. LiteLLM lets us declare model *capabilities* (cheap-fast, balanced, deep, cheap-summarize, etc.) and route per task without rewriting workflows. A reds panel might want a cheap fast model for triage and a stronger one for authoritative; a designer might want Opus for the discover phase and Sonnet for export. Today we can't express that without scattering provider IDs through the workflow files.
**How to apply:** Run a LiteLLM proxy locally (already partially supported via `FORGE_USE_LITELLM=1`). Define logical aliases in LiteLLM's config that map to the actual best model per task type. Expand `_agentRefs.ts`'s alias set so workflows can pick something more specific than the current three (`spec-writer` / `fast-orchestrator` / `deep-thinker`). Bonus, *not* the goal: LiteLLM also reports per-call cost — wiring that into the empty `model_calls` table gives us a cost view for free, but that's secondary to the routing capability.
Related: #38 (capture resolved model on the task row) is the audit-trail companion — once both land, the dashboard can show role + alias + resolved-model + tokens (+ cost when the bonus lands).

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

### #51 — Visual diff: implemented UI vs design artifact
**Why:** Once a workflow has both a Pencil-produced design (`.png` from #46) and the implemented UI (HTML from `designer-export`, or the actual running app), we can verify the implementation matches the design rather than trusting it. A specialist red, or a verification phase, can compare the two visually and surface deltas (missing components, off colors, off layout). Today nothing checks the round-trip.
**How to apply:** Two pieces:
1. **Headless screenshot of the implementation.** Use a Puppeteer-Core-driven Node CLI (Mario Zechner's pattern, https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/) baked into a `verifier` or new `designer-verifier` agent's container — five small scripts (`start.js`, `nav.js`, `eval.js`, `screenshot.js`, `pick.js`) that talk to a headless Chrome over the DevTools port. Tiny tool surface (~225 tokens of docs), no Playwright MCP server. Fall back to Playwright MCP only if some interaction can't be expressed in the CLI subset.
2. **Compare design.png ↔ impl.png.** Ship the two images to the agent and let it diff visually + textually. Initial pass is just "look at both and tell me if they match"; later we can layer pixel diff or component-tree diff.
**Sequence:** Lands after #46 v1 is solid. Likely a new optional phase in `ui-design` (`verify`) or a specialist red on the existing `export-code` phase. Discuss before implementing — the diff prompt and "match" criteria need calibration.

### #52 — Browser DevTools error capture for implementation review
**Why:** "Did the page render without console errors?" is a binary signal that catches a lot of broken builds. Same Puppeteer-Core CLI scripts as #51 — different question. Useful as a specialist red on any phase that produces runnable web UI (`export-code` from #46, future `feature-design-needed` builds that produce a page).
**How to apply:** Add an `eval.js`-style script that subscribes to `Runtime.consoleAPICalled` + `Runtime.exceptionThrown` over the CDP, navigates the page, waits for idle, and emits the error log as JSON. Wire into a red role (call it `console-checker` or fold into `verifier`). Treat as a specialist red — non-blocking warning unless rationale provided. Same blog-post primitives as #51, so build #51 first; this one is incremental.

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

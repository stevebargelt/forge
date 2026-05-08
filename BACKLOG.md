# forge — backlog

Canonical task list for forge. Numbers are sticky across sessions and referenced from commit messages (e.g. `fixes #30`, `partial #25`). New items get the next available sticky ID and never get renumbered.

When you start a session, read this file. When you finish, update it: move closed tasks from "Active" / "In progress" to "Done (recent)" with their commit hash; rewrite "Notes for next session" with whatever the next session needs to know.

## Notes for next session

**State at end of 2026-05-08 afternoon session:** main has #54 + FORGE-DEC-016 landed. ui-design workflow now has both `brief` and `review` phases. `forge submit` is wired. Dashboard renders manual-phase tasks. 171 tests passing. **End-to-end validation still owed:** a real `forge new ui-design "<title>" --design-dir ~/code/<dir> --brief "..."` run that walks brief → submit → review → gate. The mechanics are tested in isolation but no real run has touched the new code path yet.

**Top of the stack — pick from here:**

1. **End-to-end validate #54.** Run a real ui-design workflow. Confirm: brief produces PROMPT.md, dashboard renders it inline, human runs it on the host, `forge submit` validates, dashboard shows the .pen + PNGs + HTML, gate advance closes the run, gate reject loops back to brief with `inputs.rejectedRationale` populated. This also closes #25's pending validation.
2. **#55** — design-revise rewrite. Same two-phase shape as #54 (`brief` + `review`), different prompt-author template that opens a prior `.pen` and applies revisions. Mostly mechanical now that #54 is in place.
3. **#66** — dashboard new-run modal must require `--design-dir` for ui-design/design-revise. Becomes more important now that submit hard-errors on missing designDir.
4. **Run FOLLOWUP-PROMPT.md** through Pencil at the host to fill the 9 design gaps captured in `~/code/forge-design/FOLLOWUP-PROMPT.md`. Then wire the new screens into the dashboard.
5. **Dashboard followups #62-65** (gate-button copy, fresh-session warning, resizable panes, per-question gate UX). With #54 in, gate-button copy (#62) becomes more interesting since manual-phase gate semantics differ from agent-led ones.
6. **#48 image previews** — currently the dashboard shows PNG paths as text. To render actual previews we need a `/api/artifact?path=...` passthrough endpoint (browsers block `file://` from http-served pages). Whitelisted paths only (under `~/code/`). Small, deferred.

**Validation still pending:**
- #32 (failed-result detection) — code shipped, hasn't caught a real failure yet.
- #25 (reject + `onReject` flow) — code is exercised by the gate.test.ts manual-phase reject test, but a real ui-design reject hasn't run yet. Closes when #1 above lands.

**Watchdog status:** works.

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

### #54 — Rewrite `ui-design` workflow for the new architecture (DONE this session)
Closed in Done (recent) below. Validation: a real `forge new ui-design` run that goes brief → submit → review → gate. Reject path exercises #25 incidentally.

### #55 — Rewrite `design-revise` workflow for the new architecture
**Why:** Same pivot as #54 but for the iteration case. Input is a previously-saved `.pen` file plus a revision brief.
**How to apply:** Phases:
- `brief` — agent: `prompt-author` with the `ui-design-revise` template. Reads the prior `.pen` file path from inputs; produces a PROMPT.md that opens it via `--in` and applies the requested changes. Verifies the prior `.pen` is non-zero before generating (hard error if 0 — design source was lost).
- `review` — same as #54.
Depends on: #53.

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

### #63 — Dashboard handoff copy: tell humans to run PROMPT.md in a fresh session
**Why:** Discovered 2026-05-08 while running FOLLOWUP-PROMPT.md: a long structured prompt (multi-screen Pencil run) can silently drop later sections + end-of-prompt actions when the running Claude Code session compacts mid-task with stale context. The fix is run-time hygiene: open a fresh session before pasting. The model can't reliably know its own context budget; the human has to enforce the discipline.
**How to apply:** When the dashboard's awaiting-gate detail renders for a `prompt-author`-produced task (or any task whose result has a `promptPath`), include a load-bearing instruction near the gate buttons: "Run the PROMPT.md in a fresh Claude Code session (`/clear` or new terminal) before approving. Don't paste into a session already mid-task." Same copy on the design-handoff screen (#57's deferred screen 09 design). The PROMPT.md template itself already has this warning at the top (committed alongside this entry); the dashboard duplicates it where the human will actually see it at run-time.
Belongs in #57's next iteration alongside #62.

### #64 — Dashboard pane widths are fixed; full run names get clipped
**Why:** The three-pane layout in `src/dashboard/html.ts` uses `grid-template-columns: 280px 360px 1fr`. When run titles are longer than ~14 chars (kebab-cased ids like `run-test-prompt-author-v3-da7d57` are common), they truncate with `text-overflow: ellipsis`. There's no way to widen the sidebar to read the full id without DevTools. Annoying any time you need to reference a run id in a terminal command.
**How to apply:** Two reasonable options: (a) draggable resizers between panes — tracks divider positions in localStorage so widths persist across reloads; (b) hover/click tooltip showing the full title when an id is truncated. (a) is the right long-term answer; (b) is a 10-line fallback if (a) is too much for one pass. Either way, raise the sidebar's default minimum width from 280px to maybe 320px so the common case stops truncating.
Caught 2026-05-08 during #53 validation — Steven couldn't read the full `run-test-prompt-author-...` ids.

### #65 — Per-question UX for `openQuestions` at the gate
**Why:** Today `result.openQuestions` is a free-form array the agent emits to disclose every default it picked when the human didn't specify (style, screens, dimensions, etc.). At the gate, the human's only response surface is one rationale textarea — to correct any single default they have to write free-text addressing whichever one(s) were wrong. The agent re-runs and re-generates the whole PROMPT.md from the synthesized rationale. Works in 1-2 rounds in practice but the UX is clunky: no per-question response, no "ok / not ok" per item.
**How to apply:** When the dashboard's awaiting-gate detail renders a task whose result has `openQuestions`, render them as a checklist with three states per question (accept / change / explain) and a small inline text field for the change case. On submit, synthesize the gate rationale automatically from the per-question responses (e.g. "accepted #1, #3; changed #2 to: <text>; left #4 open") and POST to `/api/gate/:taskId` as today. The agent's re-run loop is unchanged — just a friendlier capture surface for the human.
Caught 2026-05-08 during #53 validation. Belongs in #57's iteration backlog alongside #62/#63/#64.

### #68 — `forge new --design-dir` should pre-create the conventional layout (DONE this session)
Closed in Done (recent) below — `forge new` now `mkdir -p`s `<designDir>/{designs,code}/` at run-creation time. Idempotent for shared-designDir reuse (#67).

### #69 — Prompt-author seed: hard-stop the human session if Pencil MCP is unavailable (DONE this session)
Closed in Done (recent) below — `seeds/agents/prompt-author/templates/ui-design.md` now has a PRECONDITION 0 step that tells the human's Claude Code session to refuse to proceed without `mcp__pencil__*` tools. Caught 2026-05-08: a session without the Pencil MCP started writing HTML files instead of failing fast, polluting `<designDir>/code/`.

### #67 — Per-app design corpus: encourage / enforce shared designDir within an app
**Why:** Today every `ui-design` run gets its own `--design-dir`. Each .pen file is a fresh document with no link to prior designs of the same app. If you design the forge dashboard at `~/code/forge-design/dashboard.pen`, then later add a widget to that dashboard, the widget design lives in a new .pen with no automatic access to the variable block or named components from the dashboard's .pen. Pencil 0.2.5 has no cross-file component import — components live inside their .pen file. Result: visual drift, redundant token redefinition, and the human has to keep "the dashboard's house style" in their head when running each new ui-design.
**Caught 2026-05-08:** running ui-design for a forge dashboard widget against a fresh `--design-dir ~/code/forge-stats-widget/`. Steven flagged that this should have been added to `~/code/forge-design/` so it could reuse the existing component library + variable block. The prompt-author had no way to know.
**Three shapes to consider (decide before implementing):**
1. **Convention only.** Document that ui-design runs for the same app share a designDir. Update prompt-author seed to ask "is this an addition to an existing design corpus? if so, point me at it." Cheapest, no code change.
2. **`forge new --inherit-from <other-design-dir>`.** New flag. The prompt-author template gets a step at the top: "open the inherit-from .pen first, copy variable block + named components into the new .pen, then proceed." Pencil supports this manually; agent automates the copy. Risky — node-copying across .pen files isn't a tested path in Pencil 0.2.5.
3. **Reuse the same designDir; .pen grows monotonically.** No flag needed. The existing prompt-author already supports an existing .pen (touch + open_document is idempotent; new screens go in empty canvas space via `find_empty_space_on_canvas`). Just teach the human (and the prompt-author seed) that the right move is `--design-dir` pointed at the existing corpus, not a new dir. Accepts the cost of larger .pen files in exchange for actual reuse.
**Lean toward (3) initially.** It's the cheapest honest answer and exposes whether the monotonic-growth cost is real before we build (1) or (2). (1) becomes the documentation form of (3). (2) only becomes worth building if Pencil ships better cross-file tooling AND we hit a case where one .pen is genuinely too big.
**Open question:** how does forge know when a designDir already has a .pen worth reusing vs an empty/abandoned scratch? Probably: the prompt-author can detect a pre-existing non-zero .pen at the conventional path, surface it in `openQuestions` ("found existing design at <path>; reuse?"), and let the human gate the call.

### #66 — Dashboard new-run modal — DONE this session (on `new-run-modal-66` branch)
Closed in Done (recent) below. All 6 workflows supported with conditional fields, server-side validation mirrors client, and POST /api/runs shells out to `forge new`.

### #25 — Validate `onReject` rationale-propagation end-to-end (legacy, partly obsolete)
**Why:** `onReject` is documented but no workflow used it as of 2026-05-07. The code path (rationale propagation into the remediation phase) was fixed in `d075f9f` but never exercised. **#54's `review` phase will exercise this path** — when the human rejects a design, `onReject: "brief"` loops back and the prompt-author re-runs with `inputs.rejectedRationale` populated. Once #54 ships and a real run rejects a design, this entry can close.
**How to apply:** Already covered by #54's review phase. Verify `inputs.rejectedRationale` and `inputs.rejectedTaskId` arrive at the brief phase's prompt-author task during the first real reject in a `ui-design` run.

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

### #46 — Designer agent + Pencil integration + ui-design workflow (SUPERSEDED)
**Status:** SUPERSEDED by FORGE-DEC-014. The container-based designer is dead — Pencil 0.2.5 has no headless save mechanism. Replaced by #53 (prompt-author seed) + #54 (ui-design rewrite) + #55 (design-revise rewrite) + #58 (cleanup of container-designer code).
**Original framing kept here for the audit trail; see In progress section above for the current #46 entry with the cleanup ladder.**

### #47 — Use `pass` for host-side secret storage (renumbered as #60)
**Status:** Renumbered as #60. The original #47 framing was "PENCIL_CLI_KEY in containers"; with FORGE-DEC-014 PENCIL_CLI_KEY moves out of forge entirely. The pass-based pattern is still wanted for whatever host-side secrets forge accumulates next; see #60.

### #48 — Dashboard support for design review (subsumed by #57)
**Status:** Subsumed by #57 (interactive dashboard v1) which renders PNG outputs from gate.rationale paths as part of the design review UI. The original #48 framing assumed the container designer (#46 v1); with the FORGE-DEC-014 pivot the design review surface lives in #57's gate UI for the `review` phase of ui-design / design-revise workflows.

### #49 — Design-reviewer red agent (future investigation)
**Why:** Steven's call: skip reds for design work in v1 because aesthetic judgment is squishy. Worth revisiting once we have real human-review data — there may be objective things a red can catch (accessibility contrast, missing states, broken layout primitives, brand inconsistency).
**How to apply:** Investigate after a few `ui-design` runs ship and we see what humans actually flag. Could be one specialist red ("a11y") rather than an authoritative aesthetic judge.

### #50 — React Native code export from Pencil .pen files
**Why:** v1 of #46 only exports HTML+Tailwind. Mobile design eventually needs RN. Harder than HTML because RN's layout primitives don't map cleanly from a free-form design tool — Flexbox-only, no grid, different typography model.
**How to apply:** New phase or new `--target rn` flag on the `export-code` phase. Probably needs its own designer-export-rn role. Validate by exporting one screen end-to-end before committing to the approach.

### #51 — `design-reviewer` agent: visual diff implemented UI vs design artifact
**Why:** With #54 shipped, every `ui-design` run produces a known artifact pair: `result.pngFiles` (the canonical design from Pencil) + `result.htmlFiles` (the HTML/Tailwind code-export from the same prompt). Implementation work that follows references those designs. Today nothing verifies the implementation actually matches the design — humans eyeball it and trust the agent. A `design-reviewer` agent closes that loop: screenshot the implementation, compare against the design PNG, surface deltas.
**Tolerance:** close, not pixel-perfect. The role's job is "would a reasonable designer say this matches?" — catches missing sections, wrong colors, wrong typography, broken layout primitives, missing states. Doesn't fail on a 4px gap or a slightly different shade. Output is a structured verdict + findings, not a binary diff.
**How to apply:**
1. **Capture mechanism — Puppeteer-Core CLI scripts in the agent container** (Steven's Q1 call 2026-05-08: container, not host — keeps the agents-in-containers invariant intact; chromium-headless adds maybe 100-200MB to the image, acceptable). Use Mario Zechner's pattern (https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/): five small scripts (`start.js`, `nav.js`, `eval.js`, `screenshot.js`, `pick.js`) that talk to headless Chrome over the DevTools port. Tiny tool surface (~225 tokens of docs), CLI over MCP. Fall back to Playwright MCP only if a specific interaction can't be expressed in the CLI subset.
2. **Compare design.png ↔ impl.png.** Ship both images to the agent; let it diff visually + textually. Initial pass = "look at both and tell me where they diverge"; later we can layer pixel diff or component-tree diff if false negatives accumulate.
3. **Targets:** v1 is web (headless Chrome). Electron renderer is Chromium-on-DevTools-protocol — same scripts work, modulo "how do we launch the app and find its DevTools port"; defer to v2. Mobile is genuinely different (no DevTools protocol; needs Maestro/Detox/native screenshotting); defer to v3, separate decision.
4. **Invocation shapes — three patterns the workflow can pick from:**
   - **Fanout-from-upstream.** A `verify` phase in `ui-design` (or a future `feature-implementation` workflow) declares `fanoutFromUpstream: { arrayKey: "pngFiles" }` and creates one design-reviewer task per PNG. Most natural fit for "as the work gets completed, the reviewer checks each screen." Already a forge primitive.
   - **Specialist red on an implementation phase.** When a phase produces runnable UI (e.g. `export-code` or a `feature-design-needed` build), attach `design-reviewer` as a specialist red. Non-blocking by default; failures warn the human at the gate.
   - **Ad-hoc spot check.** A future `forge review <run-id> --screen home` command could spawn a one-off task outside planned phases. Not supported today; build only if the fanout/red shapes turn out to be too coarse.
5. **Open question (defer):** how does the agent get the URL? Options: workflow-input field, `--target-url` on the invoking command, or upstream phase output. **Decided 2026-05-08 (Steven's Q2):** make this decision when we start developing — it's downstream of the agent's existence.
**Input contract (locked, given #54 shipped):** the agent reads `inputs.upstream[*].result.pngFiles` (canonical designs) and either `inputs.upstream[*].result.htmlFiles` (static HTML files to screenshot via `file://`) OR a `targetUrl` input (running app, web/Electron). Output: `{verdict: "pass"|"fail"|"inconclusive", confidence, findings: [{severity, summary, evidence, hypothesis}], notes}` — same shape as other reds.
**Sequence:** unblocked now that #54 is live. Worth a real `ui-design` run first (the in-progress validation) so we have a working artifact pair to test against — that's the natural input. Discuss before implementing: the diff prompt and "match" criteria need calibration.

### #51b — Plan the `design-reviewer` agent in detail (FORGE-DEC-017?)
**Why:** Splitting the planning question out so #51 doesn't grow into a multi-day item without a discussion checkpoint. Before any code lands, decide:
- Container shape: fork `agent-dev-worker` or new `agent-design-reviewer-worker` image? (Headless Chrome + the 5 CLI scripts is a clean separation; arguments cut both ways.)
- Diff prompt template: what does the agent read first (design PNG or impl screenshot)? How is "close enough" expressed in the system prompt?
- Calibration data: collect 5-10 (design, impl, expected verdict) triples from real runs as the validation set before declaring v1 done.
- Whether this warrants its own ADR (FORGE-DEC-017?) or is small enough to ship under #51's commit log alone.
Don't start until the calibration question has a plan — uncalibrated visual judges produce noise that erodes trust in the whole reds layer.

### #52 — Browser DevTools error capture for implementation review
**Why:** "Did the page render without console errors?" is a binary signal that catches a lot of broken builds. Same Puppeteer-Core CLI scripts as #51 — different question. Useful as a specialist red on any phase that produces runnable web UI (`export-code` from #46, future `feature-design-needed` builds that produce a page).
**How to apply:** Add an `eval.js`-style script that subscribes to `Runtime.consoleAPICalled` + `Runtime.exceptionThrown` over the CDP, navigates the page, waits for idle, and emits the error log as JSON. Wire into a red role (call it `console-checker` or fold into `verifier`). Treat as a specialist red — non-blocking warning unless rationale provided. Same blog-post primitives as #51, so build #51 first; this one is incremental.

## Done (recent)

### #66 — Dashboard new-run modal (full form, all 6 workflows)
**Closed:** 2026-05-08 afternoon, on branch `new-run-modal-66` (199 tests passing, +26 new).
**What shipped:**
- New `src/dashboard/workflowSchema.ts`: single source of truth for the modal — workflow specs (description + per-workflow required/optional fields), universal fields (title + project), validation (required + absolute-path + shell-meta loose mode per Steven 2026-05-08 call), and argv builder for `forge new`.
- New `GET /api/workflows` endpoint exposes the schema; modal fetches once and caches.
- `POST /api/runs` replaces the 501 stub: validates server-side, shells out to `bin/forge new` (per FORGE-DEC-015), parses `Created run <id>` from stdout, returns `{runId, summary}`. 400 + structured `errors[]` on validation failure (client maps these to per-field error rows). 500 + stderr on subprocess failure.
- Dashboard modal: workflow picker first, fields appear/disappear per workflow choice, per-field validation, error rows on the matching field, submit disabled while creating, success closes modal + selects the new run. Read-only fallback when not interactive.
- 26 new tests covering: schema validation per workflow + edge cases (relative paths, shell-meta in paths, whitespace), argv builder shape per workflow, server endpoint (CSRF, interactive, validation surfacing, argv shell-out shape per workflow, success runId parsing, error surfacing).
**Locked design decisions** (Steven 2026-05-08):
- (A) Schema lives in `src/dashboard/workflowSchema.ts`, dashboard-internal — CLI keeps Commander as its source of truth. Sharing would couple two consumers without enough payoff.
- (B) Loose path validation — must be absolute (`/` or `~`), no shell metacharacters. Existence is `forge new`'s job downstream (mkdir for designDir, mount for project).
- (C) Briefs/questions are textareas. No shell-quoting concerns since cpSpawn takes argv as an array.
**Open follow-up:** when `--design-dir` defaults to `~/code/<title-slug>/`, the modal could pre-fill it as the user types the title (live default-derivation). Current behavior: empty placeholder text. Cheap polish, defer.

### #68 — `forge new --design-dir` pre-creates the conventional layout
**Closed:** 2026-05-08, on `main` (alongside #54 smoke-test fixes).
`src/cli/commands/new.ts` now creates `<designDir>/`, `<designDir>/designs/`, and `<designDir>/code/` via `mkdirSync({recursive: true})` when designDir is set. Idempotent — reusing an existing designDir (per #67) leaves prior artifacts untouched. Caught during the v4 smoke test where the human session's PROMPT.md hit `mkdir -p` defensively at run time; cleaner to do this once at run creation so submit's existsSync checks have something deterministic to verify.

### #69 — Prompt-author seed: hard-stop on missing Pencil MCP
**Closed:** 2026-05-08, on `main` (seed change).
`seeds/agents/prompt-author/templates/ui-design.md` gains a PRECONDITION 0 step: verify `mcp__pencil__*` tools are connected before starting; if not, refuse to proceed and tell the human to reconnect. Caught 2026-05-08: a session ran the prompt without Pencil MCP attached and started writing HTML files as a fallback — wrong artifact type, would have hard-errored at `forge submit` because no .pen + no PNGs. Refuse + wait is the right shape, not improvise. Re-installed via `FORCE=1 scripts/install-seeds.sh`.

### #54 — `ui-design` review phase + manual-phase primitive
**Closed:** 2026-05-08 afternoon, on `main` (FORGE-DEC-016 + implementation).
**What shipped:**
- New task status `awaiting_human_input` added to `TaskStatus` union. Manual phases (`agents: []`) create exactly one task in this status; human transitions it via `forge submit`.
- New CLI: `forge submit <task-id> [--notes "..."]`. Validates `<designDir>/<title>.pen` non-zero + `<designDir>/designs/*.png` ≥ 1 + `<designDir>/code/*.html` ≥ 1. Hard-errors on missing `run.metadata.designDir` for `ui-design`/`design-revise`. Captures paths into `task.result` and transitions to `awaiting_gate`.
- `src/workflows/ui-design.ts`: `review` phase added with `agents: []`, `gate: "human"`, `onReject: "brief"`. Reject loops back to brief with `inputs.rejectedRationale` populated (exercises the #25 plumbing).
- Spine: `next.ts` recognizes `awaiting_human_input` (returns new `kind`). `dispatch.ts` no-ops on empty-agents phases. `advise.ts` recommends `forge submit`. `gate.ts` rejects `request-changes` on manual phases (would otherwise create a pending task with no agent to dispatch).
- Dashboard: `/api/submit/:taskId` POST endpoint shells out to `forge submit` (FORGE-DEC-015 pattern). Awaiting-gate detail for review tasks renders artifact paths (.pen, PNGs, HTML files). Awaiting-human-input detail renders the brief context (PROMPT.md inline, parameters, openQuestions, designDir) + "I'm done" submit button.
- New helpers in `util/paths.ts`: `briefPromptHostPath` + `sanitizeTitleForFilename` (extracted from `new.ts`).
- New event type `task.submitted` in the audit trail.
**Tests:** 22 new tests across manualPhase, submit, advise, gate, server. 171 passing total (was 149).
**Closes / exercises:** #25 (onReject end-to-end via the reject path — verified by gate.test.ts). #48's substance partially lands (text-only artifact list in dashboard; PNG image previews remain a future enhancement, blocked on the browser file:// → http page security boundary).
**Depends on / unblocks:** #55 (design-revise rewrite) is unblocked — same workflow shape with a different prompt-author template. #66 (dashboard new-run modal) becomes load-bearing because submit hard-errors on missing designDir.

### #57 — Interactive dashboard v1 (gate buttons, run-next, design review)
**Closed:** 2026-05-08, merged to main as `a8e1b0f` (merge of branch `interactive-dashboard-57`, branch commit `65eaae3`).
**What shipped:**
- Full reskin to the Lunaris designs at `~/code/forge-design/designs/01-08`. Three-pane layout. CSS variables sourced from the .pen file's variable block. Geist + Geist Mono via Google Fonts CDN.
- POST endpoints in `src/dashboard/server.ts` for `/api/gate/<task>`, `/api/next/<run>`, `/api/runs` (501 stub). All shell out to `bin/forge` per FORGE-DEC-015.
- Mutations gated behind `FORGE_DASHBOARD_INTERACTIVE=1` (read-only by default). CSRF = `X-Forge-Request: 1` header. Localhost-only.
- `GET /api/meta` reports the interactivity flag so the client renders gate buttons or copy-CLI fallbacks.
- `listRunsForDashboard` returns task counts via SQL JOIN.
- 11 new server tests on the branch.
**Screens shipped:** 01 run list, 02 task list, 03 generic detail, 04 design detail, 05 awaiting-gate, 06 run-row overflow, 08 blocked-by-red. Stub for 07 (new-run modal).
**Deferred to followups:** screens 09/10 (#54), 11 (#53), 12-20 (the 9 FOLLOWUP-PROMPT.md gaps). Dashboard polish #62-65. Real new-run modal pending `forge new` POST schema.
**Absorbs:** #34 (human-readable result view — partly), #35 (gate buttons + run-next), #48 (design review surface).

### #58 — Tear down container-designer code (cleanup)
**Closed:** 2026-05-07/08 overnight, commits `d15e741` + `a9d1b1e` + `40fe81b` on branch `designer-agent-46` (3 commits).
**What got deleted:**
- `docker/agent-designer-worker.Dockerfile`, `docker/build-designer.sh` (commit 1)
- `seeds/agents/designer/` (CLAUDE.md, settings.json, skills/pencil-design/SKILL.md), `seeds/agents/designer-export/` (commit 2)
- `AgentRef.image` field on the type + plumbing through `dispatch.ts`, `spawnRed.ts`, `spawn.ts` (commit 3)
- `DESIGNER_IMAGE` constant + the conditional `PENCIL_CLI_KEY` env-var forwarding (commit 3)
- `pickIdleTimeoutMs(image, explicit)` simplified back to `resolveIdleTimeoutMs(explicit)` (commit 3)
- `src/workflows/ui-design.ts`, `src/workflows/design-revise.ts` (commit 3 — workflow names still registered in WorkflowName for #54/#55 to re-add the files)
- 3 PENCIL_CLI_KEY tests + 2 pickIdleTimeoutMs tests, replaced with 3 resolveIdleTimeoutMs tests (commit 3)
- Dockerignore tightened back to just `agent-dev-worker.Dockerfile` + `corp-root.pem` (commit 1)
**Tests on branch after cleanup:** 110 passing. Typecheck green at every commit boundary.
**Branch disposition:** the `designer-agent-46` branch is no longer load-bearing once these commits are accepted. The few clean wins were cherry-picked to main during the same overnight session (`98b9ed5`, `a42f23c`, `e119bfc`). After merge, `git branch -D designer-agent-46` is safe.

### #56 — Second Pencil pass: design the missing screens
**Closed:** 2026-05-07. Validated by a live `MISSING-SCREENS-PROMPT.md` run against the existing `~/code/forge-design/dashboard.pen`.
**Output:** 6 new screens added (now 11 total in the .pen file). PNGs at `~/code/forge-design/designs/06-run-row-actions.png` through `11-prompt-author-interview.png`. The .pen file is 458 KB, saved to disk by the human after the run. The dashboard interactive surface is now fully specified — no anticipated rework when implementing #57.
**Coverage delivered:** run-row actions (3 states) with overflow menu, new-run modal with workflow typeahead + CLI-equivalent display, blocked_by_red detail with force-advance affordance, design-handoff view (PROMPT.md inline + loud Cmd+S warning), design-review view (PNG gallery + approve/revise gate), prompt-author interview (chat thread + structured Q&A current question card). All in Lunaris/Saturated-Code-Bridge style with the same component library as the original 5 screens.
**Storage:** ~/code/forge-design/ is the working dir, untracked by forge git. No remote (per Steven's call). Treat as canonical reference for #57's implementation.


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

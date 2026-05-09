# forge — backlog

Canonical task list for forge. Numbers are sticky across sessions and referenced from commit messages (e.g. `fixes #30`, `partial #25`). New items get the next available sticky ID and never get renumbered.

When you start a session, read this file. When you finish, update it: move closed tasks from "Active" / "In progress" to "Done (recent)" with their commit hash; rewrite "Notes for next session" with whatever the next session needs to know.

## Notes for next session

**State at end of 2026-05-09 overnight:** #71 (phase pill row + next-action preview) shipped on `phase-flow-71`. Designs from yesterday's session walked into a real implementation: server-side `phaseShape` array per run, client renders the pill row above the task list with status colors + fanout dot strips, advance-preview line below the rationale field on awaiting_gate detail. 233 tests passing (was 218 → 232 after server, 233 after fanoutConcurrency test). Smoke-tested against the existing investigation run (66 tasks, 21-dot fanout strip rendered as fanoutDots: 15 done, 6 failed). Single commit on `phase-flow-71`.

**Top of the stack tomorrow:**

1. **Visual review of #71.** API + tests are green; what's missing is your eyes on the actual rendered pill row + advance preview in a browser. Spin up the dashboard against the existing investigation run + the abandoned phase-flow run; verify the visual matches designs 21/22/23/26 closely enough. Specific things I haven't confirmed visually: (a) status-coded backgrounds read clearly at the pill scale, (b) the fanout dot strip stays readable for 20+ tasks, (c) the advance-preview line wraps cleanly when verbose.
2. **Decide on visual fixes / polish.** If the pill row looks good, push the commit to main as-is (or via PR). If not, BACKLOG entries to capture follow-ups + iterate.
3. **Restart on #92 architect scope.** Once #71 lands, the most leveraged next thing is the architect seed rewrite — every subsequent `feature*` run pays for the bad shape until that's fixed.
4. **Corpus consistency pass (#88).** Propagate the pill row into existing screens 02/03/05/08/etc so the design corpus matches reality. Do this BEFORE the next design-reviewer pass — otherwise it'd flag drift that's actually intentional.
5. **#93 reject-loop picker.** Open architectural call.
6. **Dashboard punch list (deferred from yesterday).** #89 drop-flag, #76 elapsed-timer, #62 gate-copy, #63 fresh-session, #64 tooltip+width, #75 markdown, #42 docs rewrite. None of these were touched overnight — the call was "do #71 first, no overnight punch list."

**Validation still pending:**
- #25 (reject + `onReject` flow) — still un-validated end-to-end.
- #32 (failed-result detection) — code shipped, hasn't caught a real failure yet.

**Branch state:** `phase-flow-71` ahead of main with #78 retry, #82 *.pen glob, gate-advance auto-chain, BACKLOG hygiene, three new entries (#92/#93/#94), and now **#71** — the biggest piece of dashboard UX shipped this week.

**Watchdog status:** works.

## Active

### #53 — `prompt-author` agent seed + ui-design PROMPT.md template
**Why:** Per FORGE-DEC-014, forge's role in design becomes "author the prompt, the human runs it." The `prompt-author` agent is a generic prompt-elicitation primitive: interview the human about brief / screens / style / paths / constraints, fill the right template, output a `PROMPT.md` file path. ui-design is the first consumer; future consumers (marketing-copy, code-review, architecture-review) will use the same primitive with different templates.
**How to apply:**
- New seed: `seeds/agents/prompt-author/CLAUDE.md`. Interview structure: brief / screens (or sections) / style guidance / target paths / constraints / known gotchas. Output schema: `{status, promptPath: "...", brief, screens?, notes}`.
- New seed: `seeds/agents/prompt-author/templates/ui-design.md` — parameterized PROMPT.md. Variables: `{{target_pen_file}}`, `{{output_dir}}`, `{{screens_list}}`, `{{style_guidance}}`, `{{brief}}`, `{{file_naming}}`. Encodes: touch precondition, open_document + verify, filePath everywhere, find_empty_space_on_canvas, export+rename, loud Cmd+S warning, stat-verification step.
- A drafted, validated version lives at `~/code/forge-design/PROMPT.md` — use as the canonical reference when authoring the template.
- The agent runs in `agent-dev-worker` (no special image). Standard blue-agent shape.
Validated empirically tonight: this exact prompt produced a complete dashboard design in `~/code/forge-design/`.


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



### #83 — PROMPT.md: count existing PNGs and use max+1 as starting number (immediate fix for #80)
**Why:** Caught 2026-05-08 mid-phase-flow run again. The brief mentioned "11 dashboard screens" (stale — actually 20) but Pencil-Claude has no way to verify; it inferred a starting number on its own and picked wrong (started at 12, would have clobbered existing 12-20). The "existing screens" count is unreliable as brief context — the corpus changes between runs and the brief is frozen at run-creation.

**Fix at the prompt-template level (cheap, ships now):** add a count step early in PROMPT.md. First Bash command after the precondition `touch`:
```bash
EXISTING_COUNT=$(ls <designDir>/designs/*.png 2>/dev/null | wc -l | tr -d ' ')
START_NUM=$((EXISTING_COUNT + 1))
echo "Existing PNGs: $EXISTING_COUNT. Starting new screens at $START_NUM."
```
Then the per-screen rename steps use `$(printf "%02d" $START_NUM)`, `$(printf "%02d" $((START_NUM + 1)))`, etc. instead of hardcoded `01`, `02`, etc. Pencil-Claude does the count itself; nothing inferred from brief context.

**Longer-term fix (#80 unchanged):** prompt-author should mount designDir read-only into its container and bake the actual starting number into PROMPT.md at author time. Cleaner because it's discovered once, not at run-time-on-the-host. But (#83) ships now; (#80) ships later.

### #80 — Prompt-author seed needs to read existing designDir before authoring (shared-corpus support)
**Why:** Caught 2026-05-08 mid-phase-flow run. The prompt-author seed assumes a fresh designDir and authors a PROMPT.md based on `<basename(designDir)>.pen` + screen numbering starting at `01-` + a static "N screens" framing pulled from the brief. With #67 (shared per-app corpus), every one of those assumptions breaks:
- Existing `.pen` file has a meaningful name (`dashboard.pen`), not the basename of the dir.
- Existing PNGs are numbered 01-20; the agent's `01-phase-pill-row-linear.png` would clobber.
- "Match the existing 11 screens" framing was stale (already 20 by run time). Cosmetic but misleading.
- The 0-byte `touch <basename>.pen` precondition created a useless second .pen file.
**How to apply:** Before authoring PROMPT.md, the prompt-author should:
1. Read the existing `.pen` file (any `*.pen` in designDir) and use its actual filename in the prompt.
2. Count existing PNGs in `designs/`; start new numbering at max+1.
3. Don't hardcode a screen count in the prompt body — say "the existing dashboard screens" or count at author time.
4. Skip the precondition `touch` step when an existing `.pen` is found.
5. Add a per-screen-pair Cmd+S reminder, not just an end-of-run warning. Pencil sessions crash mid-run (verified 2026-05-08); the loud end-of-run save is too late if the crash happens between screens 24 and 26 of a 26-screen design (which is exactly what just happened).
**Validation done so far:** prompt-author DOES tell Pencil to OPEN-the-existing-file and ADD frames (good — this part of the seed worked). Numbering and filename inference are the gaps.
**Composite with #79 + #82 (validator-glob-pen below):** these three together make shared-designDir reuse robust. Without all three, every reuse run hits a different sharp edge.

### #81 — Pencil MCP server stale-handle failure mode (workaround documented)
**Why:** Caught 2026-05-08 mid-phase-flow run. Pencil-Claude reported successful MCP calls (`open_document`, frame inserts, etc) and exported PNGs to disk, but the `dashboard.pen` tab in VS Code showed no dirty marker — meaning the in-memory edits were landing in *some* document, just not the one VS Code was showing. End-of-run Cmd+S did nothing because there was nothing dirty in the visible doc. Net result: PNGs exported, `.pen` source not updated, design lost on session close.

**Hypothesis:** Pencil's MCP server holds per-session in-memory document handles. If an earlier MCP call (or the `touch <wrong-name>.pen` precondition step that created an empty stub) activated a *different* in-memory document, subsequent calls with `filePath: <correct path>` silently routed to the stale handle instead of the file the human had open. The MCP tool reports success because it operated on *some* doc, just not the right one.

**Fix that worked:** restart VS Code → restart Claude session → re-run prompt. Cleared the handle map. Subsequent run shows dirty marker on `dashboard.pen` immediately on first MCP call (verified 2026-05-08).

**What forge / the prompt-author seed can't defend against:** this is Pencil-internal state. No external tool can introspect Pencil's MCP handle map. The seed's existing `get_editor_state` after `open_document` step is supposed to catch the wrong-active-editor case, but if MCP misroutes silently it would still report the right path.

**What the human can do:** watch the VS Code dirty marker as the live correctness indicator. If it doesn't appear within seconds of the first MCP call, the session is broken. Stop, restart VS Code + Claude, re-run.

**Add to PROMPT.md template:** a step early in the prompt that says "after the first `open_document` call, the human watching VS Code should see a dirty marker (●) appear on the target file's tab. If no marker appears within 10 seconds of the first edit, the MCP session is broken — restart VS Code and Claude, then re-run this prompt."

**Composite with #80:** #80's per-screen Cmd+S reminders are still good (Pencil sessions can also crash mid-run for unrelated reasons). The dirty-marker check is an *earlier* tripwire — catches the failure within seconds of starting, not after 24 screens of wasted work.

### #90 — Submit captures corpus-level artifacts, not run-level deliverables
**Why:** Caught 2026-05-08 reviewing phase-flow submit. The validator globs `*.png` / `*.html` across designDir/{designs,code}/ and stores all matches in `result.pngFiles` / `result.htmlFiles`. With shared-corpus reuse (#67), that's the *whole corpus*, not just this run's deliverables. The phase-flow run's review task captured 24 PNGs + ~25 HTMLs — 20 of each from earlier runs that have nothing to do with the phase flow widget. Architect agent reads `inputs.upstream[*].result.pngFiles` and gets the full list as input, including 20 unrelated screens.

**For this run it's fine** (architect needs full corpus context to integrate the new component into the existing dashboard). For other features where designDir has unrelated history, it'd be noise.

**Three options:**
1. **Snapshot at brief-time, diff at submit-time.** When `forge new` creates a run with `--design-dir`, snapshot the existing file list to `run.metadata.designDirSnapshot`. At submit, compute "new since snapshot" and store both: `result.allPngFiles` (full corpus) and `result.newPngFiles` (just this run's). Architect prompt could choose which to read.
2. **mtime threshold.** Submit only captures files newer than `run.createdAt`. Cleaner; doesn't require run-creation-time bookkeeping. Edge case: if the human iterates in Pencil for a long time and the corpus had files added meanwhile (e.g. another forge run finished mid-Pencil-session), they'd show up as "new." Probably rare enough to ignore.
3. **Leave as-is.** Architect prompt updated to "when there are 20+ artifacts, distinguish 'just this run' from 'pre-existing context' by looking at filename numbering patterns." Frail; punts the problem to the agent.

**Lean (2)** — mtime threshold. Simple, no schema change, agent gets clean input most of the time. Composite with #88 (corpus consistency) makes the corpus-vs-deliverable distinction operational at multiple layers.

**Sequencing:** wait until we see this become an actual problem in a real run. For phase-flow specifically, the full-corpus context is appropriate. Capture and defer.

### #88 — Corpus consistency: propagate new components into affected existing screens
**Why:** Caught 2026-05-08 reviewing phase-flow design output. The pill row (#71) is a new component that, once implemented, will appear above the task list in many existing dashboard screens — 02 (task-list), 03 (task-detail-generic), 05 (task-detail-gate), 08 (task-detail-blocked-by-red), 11, 17, 18, 19, 20, etc. The current design corpus shows those screens *without* pills (drawn pre-pill-row). After implementation: live dashboard shows pills everywhere, corpus shows pills in isolation only. Mismatch.

**The compounding problem:** when the design-reviewer agent (#51) runs comparing implementation screenshots against corpus PNGs, it'll see the pill row in production and not in the design — false-positive "regression" findings or, worse, calibration loss as it learns to ignore real differences. Every future cross-cutting component (notification toasts, status pills, search bars) creates the same drift.

**The right shape: a "corpus consistency pass" after any cross-cutting addition.**
- Different from `ui-design` (no new design) and `ui-design-revise` (revising one design).
- It's: "the new component X exists in screen Y; propagate it into every affected screen in the corpus." Pencil-Claude session that retrofits in place across N existing screens.
- Eventually maybe its own workflow primitive (`ui-design-propagate`?), or a documented post-design-run convention. For now, a manual pass after each cross-cutting design run.

**For the phase-flow run specifically (Steven's call 2026-05-08):** ship as-is; capture this as a real backlog item; do the propagate pass before #71 implementation lands so the corpus matches reality at implementation review time.

**Three implementation options when the time comes:**
1. **Full retrofit in Pencil** — update every affected screen in place. Honest corpus, real time cost. Right answer.
2. **Mark old screens explicitly stale** — annotate ("pre-pills version") to document the gap without fixing it. Cheap, keeps the gap visible. Stopgap.
3. **Versioned corpus** — tag the .pen at the pre-pills state in git, retrofit going forward, old version lives in git for archeology. Combines (1) with explicit version semantics.

Lean (1) when actually doing the work. (2) is a stopgap if the propagate session hasn't happened yet but you need to ship.

**Composite with #87:** the modify-in-place convention applies to propagation too — when the propagate pass updates screen 02 to show pills, screen 02 *becomes* the pills-version. The pre-pills version lives in git history, not as a parallel screen.

### #87 — Design corpus convention: modify-in-place + git, not add-new-screens for additions
**Why:** Caught 2026-05-08 — Steven: "I'm still curious why we didn't just modify 5." The current pattern adds a new screen for every addition (screen 23 added the preview-line treatment to the existing gate panel from screen 05, instead of editing screen 05). That preserves audit trail at the cost of:
- Duplicate frames in the .pen (the gate panel exists in 05 *and* 23)
- "Which is canonical?" ambiguity at implementation time
- Linear screen-count growth as the corpus iterates

**The right convention:** modify in place. Screen 05 *becomes* the gate-panel-with-preview. The .pen file is committed to git after each Pencil session (per `~/code/forge-design/` already being a git repo); commit history is the audit trail. To see "what did this screen look like before phase-flow added the preview?", `git log dashboard.pen` and check out the prior version.

**What this implies for forge / the prompt-author seed (#86 update):**
- When a brief is "add X to existing component Y," PROMPT.md says "edit screen Y in place" (with the screen name discovered from the corpus, per #80) — not "add a new screen for X."
- After each Pencil session, the human commits the corpus: `cd ~/code/forge-design && git add -A && git commit -m "<run-title>: <short summary>"`. Eventually automate this — `forge submit` could run the commit on success (or warn if the dir is dirty + uncommitted on next run).

**Counter-argument worth noting:** new screens preserve "before/after" side by side without requiring the reviewer to git-checkout. If the design intent really is showing variation/comparison (state-A vs state-B of the same component), separate frames are honest. But for additions ("here's where the preview line goes"), that's not comparison — that's the new canonical state.

**Pragmatic middle ground (Steven 2026-05-08):** when adding a new screen for an addition, **position it directly next to the original on the .pen canvas**. Spatial proximity inside the .pen is the audit trail — anyone opening the file sees `05-gate-panel` and `23-gate-panel-advance-preview` adjacent and immediately reads "this is the evolved version of that one" without git archeology. Cheaper than git-history awareness, more semantic than just "new screen far away on the canvas." The prompt-author seed (post-#86) should encode this: when designing an addition to existing component X, PROMPT.md tells Pencil to use `find_empty_space_on_canvas` *near* X's position rather than just any free space.

**Sequencing:** ship #80 + #83 + #86 first (the seed-side fixes); revisit this convention when those are real and we have a feel for whether new-screen-for-additions still creeps back in.

### #86 — Prompt-author seed: distinguish "new component" from "addition to existing component"
**Why:** Caught 2026-05-08 reviewing phase-flow design output. The brief asked for "next-action preview on the gate panel" — a single new element (an italicized line between rationale and buttons) added to the existing gate panel that already lives in the corpus (screen 05 `task-detail-gate.png`). The agent interpreted this as needing three separate gate-panel mockups (23/24/25), each showing a different preview-copy variant. Result: three near-identical full panels with slight variations + invented sections (GATE CONTEXT, AGENT MESSAGE) that weren't in the brief. The actual design content was one piece (preview line shape + placement) with three copy variants — should have been one annotated screen, not three.

**The shape of the bug:** the agent didn't know that the gate panel already exists in the design corpus, so it redrew it (with drift) instead of treating the brief as a tweak to an existing component. The prompt didn't say "the gate panel already exists; design only the addition."

**How to apply:** when authoring PROMPT.md for a shared-corpus run (per #67), the prompt-author should:
1. Read the existing PNGs/HTMLs in `<designDir>/code/` and `<designDir>/designs/`. Catalog what components already exist.
2. For each requested screen, decide: is this a *new component* or an *addition to an existing component*?
3. For additions, the PROMPT.md should explicitly say "the X component already exists in the corpus (see screen Y); design ONLY the addition (callout, annotation, single new element); do not redraw X." Optionally, ask the agent to design one annotated example + a sidecar showing copy/state variants of just the addition.
4. For new components, normal full-frame design as today.

**Composite with #80, #83:** the seed needs to read existing designDir state before authoring (#80), use existing PNG count for numbering (#83), AND distinguish new-vs-addition framing (#86). All three together make shared-corpus reuse work cleanly. Each one alone leaves drift.

### #85 — Graph view: full workflow visualization as a separate screen
**Why:** The phase pill row (#71) is the right shape for the always-visible header above the task list — compact, scannable, doesn't crowd the task list. But it can't show everything: branching (onReject loops back), fanout segment-by-segment over time, gate-decision history with rationale, the full topology of a complex workflow like `feature-ui-design-needed` (6 phases, mixed manual + agent + reds + onReject paths).
**What it is:** a separate dashboard screen — possibly a modal-style overlay, possibly a new pane under "View > Graph", possibly a new tab — that renders the *whole workflow* for the selected run as a node-and-edge graph. Each phase is a node; gates are decision points; onReject is a back-edge; fanout shows the cluster of parallel tasks with per-task status. Animated state transitions if it's not too much (a task moving from running → awaiting_red → blocked_by_red → forced-advance → complete tells a story; the pill row condenses that).
**Why a graph and not a Gantt or sankey:** Gantt is time-axis-first (right shape for "how long did each phase take"); sankey is flow-volume (right shape for "where does the data go"). Forge's interesting story is *control flow with branching* — onReject loops back, request-changes re-queues, retry creates a chain — that's a directed graph with cycles. Graph view is the honest shape.
**What it adds beyond the pill row:**
- Branching paths (onReject, request-changes, retry chains)
- Per-task status within fanout (the pill row condenses to N dots; the graph view shows each as a node with full hover state)
- Gate-decision audit thread overlaid on the relevant edge
- The "what's possible from here" question — looking at a phase, you see all its outgoing edges (advance + reject + request-changes), labeled with the consequence
**Caught:** 2026-05-08 reviewing screen 22 of phase-flow design run. Pill row is the right always-on header; graph view is the on-demand "show me everything" surface. Two different jobs, two different placements.
**Sequencing:** lands AFTER #71 (the pill row) is implemented and live. No point designing a graph view before the pill row is real — the pill row is the canonical workflow representation in the dashboard, and the graph view should reuse the same status colors, gate icons, and node treatments. Defer the design step until then.
**Open question:** is this its own ui-design run, or a phase added to the existing `forge phase flow visualization` corpus? Probably a separate run — different cognitive surface, different design language considerations (graph layout, edge routing, zoom, pan).

**Affordance for opening the graph view (Steven 2026-05-08):** add a small graph-icon glyph to the pill row strip — clicking opens the graph view as a modal/overlay. The pill row is the canonical surface; the icon is the launchpad. Don't retrofit into screens 21/26 from this design corpus — design the icon + its placement properly during the #85 pass. Plus a keyboard shortcut (probably `g` or `cmd+shift+g`).

### #84 — Document the two-channel feedback model for design workflows
**Why:** Caught 2026-05-08 — Steven's call when reviewing the phase-flow PNGs: "I'd argue that this is exactly what the human loop is for. I can work with claude/pencil to make the corrections." Right take, and worth pinning down so future sessions don't reflexively reach for forge-reject when the cheaper channel exists.

**Two distinct feedback channels in the design workflow:**

1. **Forge gate (reject + onReject)** — for *prompt-level* problems. The prompt-author made wrong inferences (wrong screens listed, wrong style, missing requirements, stale context like "11 screens" when there are 20). Reject loops back to brief; prompt-author re-runs with rationale. Heavy: full round-trip, new Pencil session needed afterward.
2. **In-Pencil iteration with Claude** — for *rendering-level* problems. The prompt was right; one specific element rendered wrong (e.g., fanout pill showing single-task-progress instead of N-task-parallelism). Open the frame, tell Pencil-Claude what to fix, save. No forge round-trip. Stays inside the human-led `ui-review` phase where the brief intended.

**Heuristic for which channel:** if the *brief* would change as a result of the fix, that's a reject. If only the *frame* would change, that's a Pencil iteration.

**Where this lives:**
- prompt-author seed should mention both channels in PROMPT.md output (so the human running PROMPT.md knows iteration during the session is normal/expected, not a sign that the prompt was wrong).
- ui-design workflow's gate-button copy (#62) might want different verbs to reflect this — "reject" reads heavy when the right move was iteration. Maybe a third option "back to prompt-author" or "this is a Pencil-iteration thing, just keep working."
- Documentation: a small section in `docs/concepts.md` or a new `docs/how-to-design-workflows.md` walking through the two channels.

Validates by experience: Steven shipped multiple in-Pencil corrections this session that would have been over-rejected through forge.
**Why:** Caught alongside #80. Validator looks for `<basename(designDir)>.pen`; with shared corpora the filename is meaningful (`dashboard.pen`), not derived. The seed-convention is too tight.
**How to apply:** `submitValidators.ts` — replace fixed-name lookup with `readdirSync(designDir).filter(f => f.endsWith('.pen'))`. Error if zero (with a clear "did Pencil save?" message); error if multiple (ambiguity, list found files); pass if exactly one. The non-zero check still applies. ~10 lines.

### #79 — Dashboard creds-mode parity: arm bedrock automatically + pre-flight check
**Why:** Caught 2026-05-08 mid-phase-flow run. `forge new` from the dashboard runs as a child of the dashboard process; the dashboard inherits the env it was forked with. If the user *didn't* `. ./scripts/use-bedrock.sh` before launching the dashboard, every run created from the modal is broken — agent containers start without AWS creds and fail Bedrock auth ~3 minutes in with a 403. CLI runs are fine because the user happens to source bedrock at the prompt; dashboard runs are silently broken with no way to arm bedrock from the modal.
**Symptom Steven hit:** task-brief-6cc6ca failed twice in a row with `403 The security token included in the request is expired`. Host AWS creds were valid; the dashboard process simply didn't have the bedrock env vars. Workaround: kill the dashboard, source use-bedrock.sh, relaunch the dashboard. Untenable.

**Two-part fix (real, not workaround):**

**Part A — auto-arm bedrock when AWS is configured.** Dashboard (and `forge` CLI more broadly) detects "this machine has AWS bedrock-style configuration" — heuristic: `~/.aws/config` exists AND the `AWS_PROFILE` env var is set OR a `default` profile exists with `sso_session` configured. When that's true, dashboard treats bedrock as the default mode regardless of whether `CLAUDE_CODE_USE_BEDROCK=1` was set in the launching shell. Effectively: if you have AWS configured for bedrock, you don't need to remember to source the script.
- Implementation lives in `util/creds.ts`. `detectCredsMode()` becomes a smarter detector. `CLAUDE_CODE_USE_BEDROCK=1` stays as a hard override (force on); `CLAUDE_CODE_USE_BEDROCK=0` stays as a hard override (force off). Otherwise auto-detect.
- Dashboard processes also need to launch the SSO watchdog if they detect bedrock — today the watchdog only starts via the run-time spawn flow. Auto-armed dashboard should kick off the watchdog the moment the first bedrock run is created, just like the CLI does.

**Part B — pre-flight check at run-creation.** When `forge new` resolves a Bedrock model id but `~/.aws/sso/cache/*.json` is empty or stale (token expired), refuse to create the run with a clear error: "Bedrock mode active but no valid SSO token; run `aws sso login --profile <name>` and try again." This surfaces the failure mode before spawning a doomed container 3 minutes later. Lives in `cli/commands/new.ts` between `loadWorkflow` and `insertRun`.
- Same check should happen at the modal POST handler — surface as a structured error to the dashboard so the toast says something actionable instead of "forge new exited 1."

**Combined effect:** if AWS is configured, bedrock works from the dashboard without ceremony. If AWS *isn't* configured (token expired, profile missing), the failure is surfaced at run-creation time with a clear remediation path instead of failing 3 minutes into the agent's first API call.

**Out of scope but worth noting:** picking creds-mode from the modal (option B from the discussion) is friction every time and not what we want. Auto-detect + pre-flight is the right shape.


### #76 — Elapsed time goes stale between polls (smart-refresh side-effect)
**Why:** #72's render-key skips renders when underlying task data doesn't change. ELAPSED is derived from `task.startedAt` + now() — only the wall clock changes every second, not the task data, so the skip kicks in and the displayed elapsed value freezes until something else triggers a render. Caught 2026-05-08 mid-phase-flow run.
**How to apply:** Don't defeat smart-refresh by forcing renders every N polls. Instead update *only* the elapsed cells via a separate `setInterval(updateElapsedCells, 1000)`. Tag each elapsed cell at render with `data-elapsed-task-id` + `data-started-at`; the interval walks those elements and rewrites text only — no DOM identity churn, polling stays smart. ~15 lines. Same pattern works for any future "ticks every second regardless of data" cell (countdowns, freshness indicators, etc).

### #77 — Evaluate Preact + htm for the dashboard
**Why:** Caught 2026-05-08 — Steven: "I think we need to start thinking about using React." The elapsed-time bug (#76), smart-refresh (#72), input-value preservation, form state across re-renders, scroll preservation, optgroup vs flat-fallback fork — all symptoms of hand-rolling reactive primitives. Each individually is <50 lines; cumulatively the dashboard's html.ts is ~2000 lines doing what a real reactive layer would do for free. The dashboard is forge's primary UX (FORGE-DEC-015); investing in the right tool compounds.
**Three options to weigh:**
1. **Stay vanilla, fix bugs as they come.** Cheap per-bug; cumulative cost grows linearly. Zero infrastructure change.
2. **Preact (~3KB) + htm (template-tagged-literal API, no build step).** Almost-React API; ~80% of the win at ~10% of the cost. Render functions become components; smart-refresh disappears; controlled inputs handle their own state. Could rewrite html.ts in stages without breaking the existing server template. ~1-2 days.
3. **Full React + Vite + build pipeline.** Splits forge into "CLI/spine + agents (TS, no build)" and "dashboard (TS, build)." Most power, but introduces a real build forge has avoided.
**Lean (2).** Bounded reactive needs (panes, not Slack), no build pipeline, real diffing without forge becoming a two-build-system project. (3) only if the dashboard genuinely needs first-class React features (Suspense, server components, big component libraries). (1) is fine for tonight; not fine for the long term given how the dashboard is growing.
**Decide cold, not in the middle of a phase-flow run.** Real cost-benefit numbers come from: counting how many lines in html.ts are reactive-primitive workarounds, prototyping one render-function-as-Preact-component, measuring the migration friction. Don't commit until those numbers exist.
**Revisit when:** another reactive-bug-of-this-shape lands AND the dashboard's html.ts crosses some threshold (3000 lines? more reactive workarounds than actual UI logic?). At that point (1) is paying real interest and (2) becomes obvious.

### #93 — Reject UX: choose where to loop back, not just trigger the workflow's fixed onReject
**Why:** Caught 2026-05-09 — Steven rejected architect output (wrong scope per #92, not a brief problem). Workflow's `onReject: "brief"` fired, spawning a fresh `prompt-author` brief task. But the brief was *fine*; the architect's seed was the problem. Looping to brief redoes work that was already correct, wastes tokens, and pollutes the corpus.

**The bug:** `onReject` is a single fixed target on the phase definition. The human at gate-reject time has no way to say "this output was wrong, restart from THIS phase, not the workflow's default." Today's only options are:
1. Reject → workflow's `onReject` target fires (fixed by config, may be wrong for this rejection)
2. Force-advance with rationale (admits the bad output into downstream phases — also wrong)
3. Manually mark the run abandoned via SQL (wasteful; loses audit trail)

**Two real shapes for the fix:**
- **(a) Picker at reject-time.** When the human clicks Reject in the dashboard, surface a phase picker: "redo from which phase?" Default to workflow's `onReject` target; allow override. The chosen phase becomes the parent for the new pending task.
- **(b) Multiple onReject targets per phase.** Workflow defines `onReject: ["brief", "architect"]` as valid options; human picks which fires. Less flexible than (a), but matches workflow-author intent (they know which targets are valid).

(a) is more flexible but harder to reason about ("what if the human picks an invalid loop target?"). (b) constrains to workflow-author-blessed targets. Lean (b) — workflows know their topology; humans pick from options the workflow validates.

**Composite with #92:** if architect is properly scoped (#92), most architect-rejects will be "your scope was wrong, redo architect with fixed expectations" — looping to architect is the right target. Today's onReject loops to brief. Different outcomes; different right answers depending on what failed.

**Caught the wrong way:** at 04:30 UTC, mid-run-shutdown. Architect output got rejected; brief re-spawned automatically; killed manually. Should have been: reject → "redo architect" picker → architect re-runs against the corrected seed.

### #94 — Retry button shouldn't appear on tasks failed via gate-reject
**Why:** Caught 2026-05-09 alongside #93. Architect task was rejected via gate; status flipped to `failed`. Dashboard's failed-task render (per #78) shows the "↻ Retry task" button. But retry on a *rejected* task means re-running the same agent with same inputs — reproduces the same output the human just rejected. Token waste.

**The fix:** dashboard's render distinguishes failure modes via the `gates` table. If the task has a gate row with `decision='reject'`, it failed by human decision, not by container crash or agent error. Don't offer retry. Maybe offer "clone with edits" or nothing at all (the workflow's onReject path already handled the loop).

**Where this lives:** `src/dashboard/queries.ts` — `getTaskDetail` already returns `gates`. Add a derived `failureMode: 'rejected' | 'crashed' | 'agent_error'` field. `src/dashboard/html.ts` — gate retryActionsSection on `failureMode !== 'rejected'`.

### #92 — Architect agent scope is wrong: tutoring the implementer instead of doing systems architecture
**Why:** Caught 2026-05-09 reviewing task-architect-c29474's output (run-forge-phase-flow-visualization-f55801). The architect produced 6+ "decisions" of the shape "PhaseShape is a plain serializable object, not a re-export of the Phase type" + "Pill-click sets state.phaseFilter; renderMiddle already re-runs on state change" + "Gate-panel advance preview is a pure client-side text function, not a server endpoint." These read like one Claude telling another Claude how to code — line-level guidance on type names, function names, file structure.

That is **not what a systems architect does**, and it's the thing Steven hates most about real-world architects who try to dictate code: "This pissed me off more than anything in the real world. Architects shouldn't tell engineers how to code."

**What systems architecture should be (Steven's framing, 2026-05-09):**
- "This is impossible because of constraint X" — surface real blockers
- "That would require 72 API calls and will be too slow" — surface scaling/performance limits
- "This couples to system Y in a way that breaks when Y evolves" — surface integration risks
- "The data shape implied here doesn't fit our database/transport" — surface data-flow problems
- Decisions about boundaries (where logic lives, who owns what state, which system is authoritative for X)
- Risks worth flagging that the implementer might miss (concurrency, security, audit, schema migrations)

**What the architect should NOT be doing:**
- Picking type names
- Choosing function names
- Specifying file structure
- Suggesting "do X this way, not that way" when both are valid
- Anything an engineer would do better with the code in front of them

**Where the bug lives:** the architect agent seed (`seeds/agents/architect/CLAUDE.md`). Today it says "produce decisions, components, interfaces" — which the agent is interpreting as "design the implementation in detail." Need to reshape the seed so the agent's output is closer to a risk-and-constraints report than a code design document.

**How to apply (seed update):**
1. Reframe the role: "You are a systems architect. Your job is to surface what would make this hard, slow, expensive, or impossible — not to design the implementation. The engineer is competent; respect that. If you find yourself naming functions or types, you've gone too far."
2. New output structure (proposed):
   - `risks` — what could go wrong, with severity and likelihood
   - `constraints` — hard limits the implementer must respect (data volume, API budgets, latency, security boundaries, schema-migration cost)
   - `boundaries` — where logic should live, who owns state, what's authoritative for what
   - `prior_art` — relevant existing patterns in the codebase or related systems
   - `open_questions` — things only the human can decide (what's the budget? which provider? how strict is X?)
3. Explicit anti-pattern list in the seed: "do not specify type names, function signatures, file paths, or 'do X this way' when both X and Y are valid choices."
4. Worked example in the seed showing a bad architectural output ("PhaseShape should be a separate type") next to a good one ("the dashboard API will leak internal types if you ship Phase directly — there's a real boundary discipline question worth deciding").

**Composite with #73 (reds-as-reviewer):** both #73 and #92 are "the agent has the wrong job description, not just a wrong prompt." Reds were reviewing the underlying subject instead of the work product; architects are tutoring the implementer instead of doing systems architecture. Same shape of category mistake, different agents. Worth fixing both with the same lens: define each agent's role by what *only it* can contribute, not by what's vaguely related to the phase name.

**Sequencing:** worth doing before more `feature*` runs land, since architect's wrong output shape compounds — the planner reads architect's output as input, and if the architect dictated implementation, the planner just tries to translate that into steps. Garbage propagates.

**Deeper framing (Steven 2026-05-09):** "It's a waste of tokens for one agent (using the same model) to tell another agent how to code." Same model + same context budget means architect-tells-implementer-how-to-code pays for two invocations to do work one would do better. The implementer has the *actual code* in front of it; architect is speculating in absentia.

The architect phase only earns its tokens by doing something the implementer *can't*:
- Look up at constraints / integration / scale / risk that the implementer's narrow code-focused view misses
- Surface "this is impossible because X" *before* the implementer wastes cycles on it
- Notice cross-cutting concerns (security, audit, migration) that show up only when you're not in the weeds

Implication: when an architect run produces output that's mostly code-design (type names, function signatures, "do it this way"), that's a signal the architect had nothing distinctive to contribute. Either the work doesn't need an architect phase, or the seed isn't enforcing the role distinction enough. **Future test:** add a quick post-run check — does the architect's output reference any project file, constraint, integration, or risk that an implementer wouldn't naturally consider? If not, the run was token waste regardless of seed quality.

This argues for: (a) tightening the architect seed per #92, (b) considering whether some workflows ship without an architect phase entirely (cheap features, refactors, isolated additions where the implementer's view is sufficient), and (c) making "skip architect" a workflow-level configuration, not just a different workflow choice.

### #91 — Reconcile bypasses gate=human on recovery
**Why:** Caught 2026-05-09 ~04:30 UTC during the architect phase of run-forge-phase-flow-visualization-f55801. The architect container exited cleanly + wrote 13KB of valid result.json, but the parent forge process never observed `close` (similar shape to #74). When reconcile recovered the orphan, it called `markTaskComplete` directly — skipping the `gate: "human"` step that the architect phase's config requires.

**The bug:** in reconcile.ts (lines ~75 + the no-reds branch), recovery → `markTaskComplete` regardless of phase.gate. For a `gate: "human"` phase that's wrong; for a `gate: "auto"` phase it's correct. The same logic in dispatch.ts's normal path (lines ~107-112) DOES check phase.gate — auto → markComplete, human → setStatus(awaiting_gate). Reconcile should mirror that.

**For phases with reds:** the right reconcile behavior is also more nuanced. If the phase has reds and they were never spawned (because the parent forge died before kicking them off), reconcile today doesn't spawn them either — it just marks complete. This means specialist reds get silently skipped on orphan recovery. For specialist (non-blocking) reds, that's mostly OK; for authoritative reds with gateOnVerdict, it's a real correctness issue.

**Three things to fix:**
1. `gate: "human"` recovery → `awaiting_gate` instead of `complete`. (Easiest.)
2. `gate: "auto"` recovery → `complete` (current behavior, correct).
3. Phase has reds + reds never ran → spawn reds during reconcile. Or, more conservatively, transition to `awaiting_gate` and let the human force-advance through; the missed reds are an audit gap that's surface-able. This is the harder design question.

**Manual recovery for the in-flight run (2026-05-09 04:30 UTC):** SQL `UPDATE tasks SET status='awaiting_gate' WHERE id='task-architect-c29474'` after reconcile flipped it to `complete`. Architect output landed correctly; just needs human gate.

**Composite with #74:** the orphan-detection problem is upstream (forge loses the docker child); the gate-honoring problem is downstream (reconcile's recovery logic). Fixing one doesn't fix the other. Both worth doing.

### #74 — Reconcile + watchdog can't catch zero-stdout orphans
**Why:** Caught 2026-05-08 on `task-investigate-dace4f`. Container apparently died (no `docker ps` output) but the task stayed `running` in the DB indefinitely. Three failure modes stacked:
1. **No container.stdout.log was ever written.** The task workspace had only the input files + an empty 0-byte `result.json`. Stdout never started flowing — possibly the container exited before producing any, or forge's `cpSpawn` parent process died before piping anything to disk.
2. **Reconcile doesn't catch this.** `reconcileRun` checks for non-empty `result.json` to decide "agent finished, forge lost track." Empty-but-existing `result.json` is treated as "still running, skip" — but here the container is genuinely gone.
3. **Idle watchdog can't fire.** The watchdog hooks `proc.stdout`. If the parent forge process (or its dispatch invocation) already exited, the watchdog isn't running anymore. If the container produced zero stdout AND its forge parent died, there's nothing watching.
**How to apply:** Three layered fixes worth considering:
1. **Reconcile sniffs for dead containers, not just non-empty result.json.** When status=running on disk but `docker ps` shows no matching container (forge could persist the container id at spawn time + check it on reconcile), mark failed with `container_crash`.
2. **Persist container id at spawn.** New column `tasks.container_id`. Lets reconcile check `docker inspect <id>` to detect "container is exited / dead / not running."
3. **Treat empty result.json + age beyond N minutes as a hard signal.** If a task has been "running" for over (say) 2× the idle-timeout AND result.json is 0 bytes AND no container is alive, declare it crashed.
**Recovery for the in-flight case:** SQL UPDATE the task back to pending + delete the empty result.json + `forge next` re-dispatches. Done manually for `task-investigate-dace4f` 2026-05-08.

### #73 — Reds-on-investigators: category mismatch; redirect parallel scrutiny to peer-investigation
**Why this is the wrong shape today, not a prompt-fix problem.** Caught 2026-05-08 mid-investigation run on `task-investigate-f6ed49`. Both red-wide and red-narrow returned `verdict: "fail"` with high-severity findings that *restated the investigator's own findings about the topaz codebase*, not critiques of the investigator's work. Initial diagnosis was "reds drifted out of scope; tighten their seed prompts." That's wrong — the deeper bug is in the verdict vocabulary itself.

**The verdict vocabulary is the real bug.** Everywhere else in forge, `fail` means "the thing being checked is broken" (an architect's design has problems; a build's diff fails review). For investigate, `fail` collapses three distinct things:
1. The investigator's evidence is weak (work-product critique)
2. The investigator's conclusion is wrong (judgment critique)
3. The underlying subject has problems (subject critique — what reds actually did)

No prompt-tightening fix makes that ambiguity go away. Even with crisp instructions, the human reading "fail" in the dashboard will instinctively read it as "the investigation got it wrong" — because that's what `fail` means everywhere else in the app. Painting prompts onto a category mistake is the wrong move.

**What we don't want to lose: parallel scrutiny on claims.** Steven's call (2026-05-08): "If we aren't going to use reds to investigate the investigators we should use reds to do investigation on the codebase." The *capacity* for two AI agents to scrutinize a claim from different angles is valuable. We just had it pointed the wrong direction (review-after-the-fact instead of investigate-in-parallel).

**Three architectural options worth weighing:**

**(A) Peer-fanout pattern (counter-investigator).** Drop reds from `investigate`. Add a second blue agent type — `investigator-counter` (or `devils-advocate`) — that runs in parallel for each claim. Same `inputs.claim`, opposite framing: "find what would refute this claim; gather evidence the original investigator might have missed." Both outputs become first-class inputs to `synthesize`. The synthesizer is *already* designed to weigh investigator outputs; it now weighs two sides instead of one. Synthesizer's verdict vocabulary stays its own (`supported / refuted / inconclusive` per claim, matching the investigator's own conclusion vocabulary, not pass/fail).
- *Pros:* Honest vocabulary. Right shape: investigation doesn't have a verifiable artifact to review, so reviewer is the wrong primitive. Each claim gets two angles instead of one + a noisy "did the work" check.
- *Cons:* Doubles compute on the investigate phase (16 claims → 32 blues). New agent seed. New workflow primitive (two parallel blues per claim, not just blue + reds).
- *Open question:* Does the counter run literally the same input or does it get a slight prompt twist? E.g. `inputs.claim` plus a hint "your job is to find evidence this is wrong"?

**(B) Co-investigator pattern (different lenses, no opposition).** Like (A) but the second blue isn't framed as devil's advocate — it's just a second investigator with a different *lens* (e.g. one prioritizes code, one prioritizes documentation; one looks for happy path, one looks for edge cases). The synthesizer weighs both for completeness, not opposition.
- *Pros:* Less adversarial framing; less risk of artificial disagreement when both would naturally agree.
- *Cons:* More subtle to define lens distinctions; risk of two blues just doing the same work twice if their prompts don't actually diverge.

**(C) Drop reds from investigate, don't replace.** Cleanest if peer-fanout turns out not to be worth the compute cost. The synthesizer is currently the only layer that weighs evidence; let it do that job alone.
- *Pros:* Minimal change, immediately stops the confusion.
- *Cons:* Loses parallel scrutiny entirely. Single-investigator runs become single-point-of-failure for each claim's evidence quality.

**(D) Different verdict vocabulary per phase.** Reds on investigate use `corroborates / contradicts / inconclusive` instead of `pass / fail`. Verdict aggregation rules in `gate.ts` have to know what each vocabulary maps to (does "contradicts" block the gate? probably not the same way "fail" does). Bigger change; possibly the right long-term answer if forge accumulates more phase types where pass/fail doesn't fit.
- *Pros:* Solves the vocabulary problem head-on. Lets reds stay structurally similar to today.
- *Cons:* Schema change for `Verdict.verdict` (maybe a `kind` field). `gate.ts`'s aggregation rule fragments per kind. Multi-vocabulary makes the dashboard more complex.

**Lean toward (A)**, but worth thinking about (B) and (D) before deciding. (C) is the fallback if (A) doesn't work in practice.

**Things that need to be decided before implementing any of these:**
1. Does the workflow shape need a new primitive ("two parallel blues with shared input, both contribute to upstream"), or can we model peer-fanout with the existing fanout machinery (e.g. by spawning two blues from the same fanout input)?
2. Does the synthesizer's prompt need to know "you're reading two views of each claim now" explicitly, or can we just rename the input field?
3. For peer-fanout: does the counter run BEFORE the original investigator (giving the original a chance to address known counter-arguments), AFTER (so it can react to the original's evidence), or strictly in parallel (independent)? Strictly parallel is cleanest; the others introduce ordering coupling.
4. Cost-of-change: dropping reds from investigate touches the investigation workflow file + the dashboard's red-rendering paths. Not large, but worth catching `forge advise` and the verdict-aggregation paths in tests.
5. Does this same problem exist in `feature-ui-design-needed.architect`? Probably not — architect produces a verifiable artifact (decisions/components/interfaces) that reds can review against the brief. The pattern fits there. Validate by example.

**What to do for the in-flight run:** advance `task-investigate-f6ed49` with rationale ("reds restated investigator findings; advance"). Specialist reds with `gateOnVerdict: false` mean the fail is informational. Do this for every investigate task in this run. Don't change workflows mid-run.

**Side issue, separate fix already shipped:** verdict cards now render `red task: <id>` so the human can copy/reference reds for troubleshooting. Doesn't fix the vocabulary issue but helps debug confusing verdicts in the meantime.

### #75 — Dashboard: markdown rendering for prose result fields
**Why:** #34's pretty result view splits prose on blank lines and renders paragraphs — fine for plain prose, but agent recommendations + reports often emit markdown (headings, bold, fenced code, lists). Currently those render as literal text (`# Heading` shows the hash). Caught 2026-05-08 on `task-recommend-071478`'s `recommendation` field — a thoughtful markdown report rendered as a wall of paragraphs with literal `##` headings.
**How to apply:** When a string value's content looks like markdown (heuristic: presence of `^#` lines, `**bold**`, ` ``` ` fences, `- ` / `* ` list markers, `[link](url)` patterns above some threshold), pipe through a small markdown renderer. Browsers don't ship one; either add a tiny single-file markdown lib (~5KB), or write a focused renderer for the subset agents actually emit (headings, bold, code, fenced blocks, ordered/unordered lists, paragraphs). Defer images and tables. Keep the raw toggle so users can see source markdown.
**Detection:** simplest = check for `^#{1,6}\s` or fenced `^```` early in the string. False positives are cheap (rendering plain prose through markdown is mostly idempotent); false negatives leave the existing paragraph render in place.
**Side note:** currently the recommendation field is the only place this matters in practice. Could even gate by field name (`recommendation`, `report`, `summary`) rather than content sniffing.

### #67 — Per-app design corpus: encourage / enforce shared designDir within an app
**Why:** Today every `ui-design` run gets its own `--design-dir`. Each .pen file is a fresh document with no link to prior designs of the same app. If you design the forge dashboard at `~/code/forge-design/dashboard.pen`, then later add a widget to that dashboard, the widget design lives in a new .pen with no automatic access to the variable block or named components from the dashboard's .pen. Pencil 0.2.5 has no cross-file component import — components live inside their .pen file. Result: visual drift, redundant token redefinition, and the human has to keep "the dashboard's house style" in their head when running each new ui-design.
**Caught 2026-05-08:** running ui-design for a forge dashboard widget against a fresh `--design-dir ~/code/forge-stats-widget/`. Steven flagged that this should have been added to `~/code/forge-design/` so it could reuse the existing component library + variable block. The prompt-author had no way to know.
**Three shapes to consider (decide before implementing):**
1. **Convention only.** Document that ui-design runs for the same app share a designDir. Update prompt-author seed to ask "is this an addition to an existing design corpus? if so, point me at it." Cheapest, no code change.
2. **`forge new --inherit-from <other-design-dir>`.** New flag. The prompt-author template gets a step at the top: "open the inherit-from .pen first, copy variable block + named components into the new .pen, then proceed." Pencil supports this manually; agent automates the copy. Risky — node-copying across .pen files isn't a tested path in Pencil 0.2.5.
3. **Reuse the same designDir; .pen grows monotonically.** No flag needed. The existing prompt-author already supports an existing .pen (touch + open_document is idempotent; new screens go in empty canvas space via `find_empty_space_on_canvas`). Just teach the human (and the prompt-author seed) that the right move is `--design-dir` pointed at the existing corpus, not a new dir. Accepts the cost of larger .pen files in exchange for actual reuse.
**Lean toward (3) initially.** It's the cheapest honest answer and exposes whether the monotonic-growth cost is real before we build (1) or (2). (1) becomes the documentation form of (3). (2) only becomes worth building if Pencil ships better cross-file tooling AND we hit a case where one .pen is genuinely too big.
**Open question:** how does forge know when a designDir already has a .pen worth reusing vs an empty/abandoned scratch? Probably: the prompt-author can detect a pre-existing non-zero .pen at the conventional path, surface it in `openQuestions` ("found existing design at <path>; reuse?"), and let the human gate the call.


### #25 — Validate `onReject` rationale-propagation end-to-end (legacy, partly obsolete)
**Why:** `onReject` is documented but no workflow used it as of 2026-05-07. The code path (rationale propagation into the remediation phase) was fixed in `d075f9f` but never exercised. **#54's `review` phase will exercise this path** — when the human rejects a design, `onReject: "brief"` loops back and the prompt-author re-runs with `inputs.rejectedRationale` populated. Once #54 ships and a real run rejects a design, this entry can close.
**How to apply:** Already covered by #54's review phase. Verify `inputs.rejectedRationale` and `inputs.rejectedTaskId` arrive at the brief phase's prompt-author task during the first real reject in a `ui-design` run.

### #27 — LiteLLM proxy: route each task to the model best suited to it
**Why:** Today every task hits Anthropic-direct or Bedrock with whatever alias the workflow declared (`spec-writer` → Sonnet, `fast-orchestrator` → Haiku, `deep-thinker` → Opus). That hard-codes provider + family in the workflow. LiteLLM lets us declare model *capabilities* (cheap-fast, balanced, deep, cheap-summarize, etc.) and route per task without rewriting workflows. A reds panel might want a cheap fast model for triage and a stronger one for authoritative; a designer might want Opus for the discover phase and Sonnet for export. Today we can't express that without scattering provider IDs through the workflow files.
**How to apply:** Run a LiteLLM proxy locally (already partially supported via `FORGE_USE_LITELLM=1`). Define logical aliases in LiteLLM's config that map to the actual best model per task type. Expand `_agentRefs.ts`'s alias set so workflows can pick something more specific than the current three (`spec-writer` / `fast-orchestrator` / `deep-thinker`). Bonus, *not* the goal: LiteLLM also reports per-call cost — wiring that into the empty `model_calls` table gives us a cost view for free, but that's secondary to the routing capability.
Related: #38 (capture resolved model on the task row) is the audit-trail companion — once both land, the dashboard can show role + alias + resolved-model + tokens (+ cost when the bonus lands).

### #28 — Per-run constraint scoping (forge new --tag, tags: in constraint frontmatter)
**Why:** The `atlas-stack-rn` constraint fires on every `feature-ui-design-needed` run regardless of project. Today the workaround is renaming the constraint file to `.disabled`, which is global. Real fix is per-run scoping.
**How to apply:** Add `--tag <tag>` to `forge new`. Add `tags: [...]` to constraint frontmatter. Constraints fire only when the run's tag matches one of the constraint's tags (or the constraint has no tags = global, current behavior).

### #33 — Resolve workflowAdditions vs base output schema conflict
**Why:** Hit a real failure: framer's base CLAUDE.md says output `{claims, experiments}` while `codebase-assessment.scope.workflowAdditions` says output `{lenses, priorities}`. The composed prompt had both schemas — the agent saw two contradictory contracts and asked for clarification instead of obeying either.
**How to apply:** Two design options to discuss before implementing:
1. `workflowAdditions` explicitly replaces the base schema. `composeSystemPrompt` emits a marker that overrides the base — agent obeys the most-specific schema.
2. Make workflows reference roles whose base CLAUDE.md already matches the workflow's schema (e.g. don't reuse `framer` for scoping if its schema is investigation-shaped).
Lean toward (1).


### #39 — Audit the spawn → DB pipeline for missing fields (meta-task)
**Why:** SQLite is supposed to be the canonical audit trail of a run, but several runtime-observable values never make it to the DB (resolved model #38, agent prose replies #32 partly, model_calls #27, container start time, watchdog state). Run an audit after #32/#38/#27 land to find what's still missing.
**How to apply:** Walk `spawn.ts`, `dispatch.ts`, `spawnRed.ts`, `gate.ts`. For each runtime-observable piece of state, decide if it belongs in the DB. Output is a punch-list of additional schema fixes, not a rewrite. Each surfaced item becomes its own task.

### #42 — Rewrite docs/how-to-new-workflow.md with a workflow we don't already have
**Why:** Current example is `code-review` which duplicates the existing `codebase-assessment` workflow. The doc reads as a paper exercise. Replace with a workflow forge actually doesn't have, ideally one that exercises a primitive we've built but not documented (`onReject` branching, gate=verdict + fanout combo, multi-authority red panels).
**How to apply:** Brainstorm the right new workflow first. Candidates: a workflow that uses `onReject` (also closes #25 validation); a workflow with both authoritative and specialist reds across phases; a workflow that genuinely needs a new role (forces also exercising `how-to-new-agent.md`).

### #45 — `forge auth status` warns on stale bedrock vars
**Why:** SSO sessions expire silently (1 hour at SGWS). The next spawn fails on auth. With FORGE-DEC-013 the watchdog usually prevents this, but `forge auth status` should still proactively detect-and-warn when bedrock creds are getting close to expiry, similar to the watchdog's threshold check.
**How to apply:** When `detectCredsMode()` returns `bedrock`, call the same `_sso_min_remaining`-style check the watchdog uses. If under some threshold (15 min?), print a warning.

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
   - **Specialist red on an implementation phase.** When a phase produces runnable UI (e.g. `export-code` or a `feature-ui-design-needed` build), attach `design-reviewer` as a specialist red. Non-blocking by default; failures warn the human at the gate.
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
**Why:** "Did the page render without console errors?" is a binary signal that catches a lot of broken builds. Same Puppeteer-Core CLI scripts as #51 — different question. Useful as a specialist red on any phase that produces runnable web UI (`export-code` from #46, future `feature-ui-design-needed` builds that produce a page).
**How to apply:** Add an `eval.js`-style script that subscribes to `Runtime.consoleAPICalled` + `Runtime.exceptionThrown` over the CDP, navigates the page, waits for idle, and emits the error log as JSON. Wire into a red role (call it `console-checker` or fold into `verifier`). Treat as a specialist red — non-blocking warning unless rationale provided. Same blog-post primitives as #51, so build #51 first; this one is incremental.

## Done (recent)

### #89 — Drop FORGE_DASHBOARD_INTERACTIVE feature flag (always on)
**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (228 tests passing — net -5 vs post-#71's 233 because the 4× "503 when not interactive" tests + the meta-default-false test became obsolete and got dropped).
- `src/dashboard/server.ts`: dropped `isInteractive()`, dropped the 503 read-only branch in `handlePost`. `/api/meta` returns `{ interactive: true }` unconditionally for backwards compat with any browser tab still loaded from before this change.
- `src/dashboard/html.ts`: dropped `renderReadOnlyNewRun` + every `if (!state.interactive)` branch (retryActionsSection, submitActionsSection, gateActionsSection, openNewRunModal, sidebar's "+ New run" button). `state.interactive` field stays on the state object but is fixed at `true` — kept as a noop because it participates in the smart-refresh keys (#72) and ripping it out of every key would be a larger churn for zero functional gain.
- `src/dashboard/server.test.ts`: removed the 5 obsolete tests + the env-var setup/teardown lines that were noops post-flag.
- CSRF header check (`X-Forge-Request: 1`) stays — the actual defense against drive-by browser POSTs.
- No documentation changes needed; the README + docs didn't mention the flag.

### #71 — Dashboard: phase pill row + advance-preview line
**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (233 tests passing, +15 new).
**What shipped:**
- **Server: `src/dashboard/phaseShape.ts`** — pure helper that builds a `PhaseShape[]` from a `Workflow` + the run's tasks. Per-phase: `name`, `agentRoles`, `gate`, `isManual`, `hasFanout`, `fanoutConcurrency`, `fanoutFromUpstream`, `hasReds`, `redsAuthority`, `redsGateOnVerdict`, `onReject`, plus dynamic `status` (attention-ranked) + `taskCounts` + `fanoutDots` (per-task status array for fanout phases, in creation order). Excludes red-prefixed agentRole tasks from phase aggregates — reds don't pull a phase back to running once their blue is done.
- **Server: `getRunWithShouldPoll` is now async** and returns `phaseShape: PhaseShape[]`. Loaded via `loadWorkflow(run.workflow)` per request — workflow files are TS imports already cached by Node, so the cost is one Map lookup. Tolerates unknown workflow names (e.g. legacy runs after a rename) by returning an empty phaseShape rather than 500. Updated `server.ts` and the existing `queries.test.ts` for the async signature.
- **Client: pill row above the task list.** New CSS classes for phase pills (status-coded background + border; 7 statuses match the design's status key: pending, done, running, awaiting_gate, awaiting_human_input, awaiting_red, blocked_by_red/failed). Each pill: gate icon (👤 manual / ⚡ agent), phase name, gate-type sub-label (◎ human / ⚡ auto / ⚖ verdict), trailing ✓ when done, trailing colored dot when phase has reds (red for authoritative, warning for specialist). Fanout pills expand to show a row of small colored dots (one per task) + a summary like "×4 running" / "16/20 done · 4 failed". Click a pill toggles `state.phaseFilter`; the task list filters to that phase + a clearable chip appears in the TASKS header.
- **Client: `describeAdvanceConsequence(currentTask)` advance-preview.** Italicized one-line summary rendered below the gate-actions row on awaiting_gate detail. Four flavors: (1) terminal — "Advancing also finalizes the run."; (2) human-led next-phase — "Advancing puts this run into awaiting_human_input. You'll need to run the PROMPT.md..."; (3) fanout next-phase — "Advancing creates 16 investigate tasks (one per claim from frame-question), running 4 at a time. Reds: specialist."; (4) plain agent — "Advancing dispatches the architect phase (architect). Reds: specialist." Reads the upstream task's `result[arrayKey]` to surface the actual fanout count when the phase is fanout-from-upstream.
- **Smart-refresh integration:** middle render-key now includes `phaseShape` (slimmed) + `state.phaseFilter`. Detail render-key includes `phaseShape` so the advance-preview line refreshes when the next-phase shape changes. `selectRun` clears `phaseFilter`.
- **Tests:** 13 new in `phaseShape.test.ts` (linear / fanout / reds / status aggregation / red-prefixed exclusion / fanoutConcurrency / fanoutFromUpstream / onReject); 1 new in `queries.test.ts` (phaseShape returned). +2 from prior counts elsewhere = 233 passing total (was 218 at start of session).
- **Smoke:** spun up the dashboard against `~/.forge/forge.db` and inspected `/api/runs/<id>` for both an investigation run (4 phases, fanout dots = 21-task strip) and the abandoned phase-flow run (6 phases, mix of done/failed/pending with reds on architect+build). PhaseShape builds correctly across both. HTML payload includes 56 hits for the new CSS classes — the styles + render code shipped to client.
**Designs referenced:** `~/code/forge-design/designs/21-phase-pill-row-linear.png`, `22-phase-pill-row-fanout.png`, `23-gate-panel-advance-preview.png`, `26-run-pane-composite.png`. Visual review still pending — Steven gates the corpus-consistency pass (#88) on his eyeballs first.
**Out-of-scope by design:**
- **Drill-in pane on fanout-pill click (granularity 3 from the BACKLOG entry).** Punted; existing task-list filtering is the v1 drill-in.
- **Sankey/DAG view (#85).** Different surface; the BACKLOG entry is explicit about lands-after-#71.

### #46, #47, #48 — closed earlier, retroactively recorded
- **#46** (Designer agent + Pencil integration) — SUPERSEDED by FORGE-DEC-014, container-based v1 abandoned. Cleanup landed under #58 (commits `d15e741`, `a9d1b1e`, `40fe81b` on `designer-agent-46`, merged into main as `e744e18`).
- **#47** — renumbered as #60 (host-side secret storage via `pass`). Original framing was PENCIL_CLI_KEY-in-containers; container designer is dead so the secret-storage need shifts.
- **#48** (Dashboard support for design review) — substance landed in #57 (interactive dashboard v1) and #54 (manual-phase ui-review with artifact-path render). Image preview deferred — needs `/api/artifact?path=...` passthrough endpoint.

### #35, #36, #37, #38, #40, #41, #43, #44 — closed earlier, retroactively recorded
- **#35** (Dashboard gate buttons + run-next + what's-next surfacing) — closed by `interactive-dashboard-57` merge (`a8e1b0f`) shipping the v1 interactive dashboard.
- **#36** (project_dir on runs table) — closed `4c216a0`.
- **#37** (`forge advise` command) — closed `23797fa`.
- **#38** (capture agent_alias + agent_model on tasks) — closed `91de39d`.
- **#40** (`forge gate <run-id> advance --all`) — closed `756dcde`.
- **#41** (auto-finalize run when terminal phase auto-gates) — closed `9201bc2`. Plus a follow-up fix for the human-gate-on-terminal-advance path (closed `09889cf`).
- **#43** (three-pane CSS layout) — closed by the dashboard reskin in `interactive-dashboard-57` (commit `65eaae3`, merged as `a8e1b0f`).
- **#44** (npm test glob portability) — closed `4ab9c17`.



### #82 — `forge submit` validator: glob `*.pen` instead of fixed filename
**Closed:** 2026-05-08 evening, on branch `phase-flow-71` (218 tests passing, +2 new).
- `submitValidators.ts` no longer derives the .pen filename from `basename(designDir)`. Now it `readdirSync(designDir).filter(f => f.endsWith('.pen'))` — exactly one matches → use it; zero → "No .pen file found, did Pencil save?"; multiple → "Multiple .pen files found: <list>; move/delete extras and re-submit."
- The non-zero size check still applies (catches Pencil-saved-empty-file failure mode).
- Fix unblocks shared-corpus reuse (#67) where the .pen filename is meaningful (e.g. `dashboard.pen`) rather than derived from the directory name.
- New tests: "designDir doesn't exist" + "multiple .pen files" + "any .pen filename works." Existing test for "throws on missing .pen" updated to the new error message; existing "basename-not-title" test rewritten as "any-filename-works" to pin the new contract.
**Caught:** 2026-05-08 — the phase-flow run had `dashboard.pen` (the existing dashboard corpus) but submit was looking for `forge-design.pen` (basename of designDir). Hard-error every time without manual rename or env-var hack.

### #78 — `forge retry` + dashboard retry button (insert-new shape, audit-preserving)
**Closed:** 2026-05-08 evening, on branch `phase-flow-71` (216 tests passing, +13 new).
- **Audit-preserving shape (Steven's call mid-implementation):** retry doesn't mutate the failed task in place — it creates a *new* task row with a fresh id, same phase/role/inputs/agentAlias/agentModel, `parentId` pointing at the failed one, status `pending`. The original stays `failed` forever as the audit record. Mirrors `request-changes` semantics in gate.ts. Cascading retries form a walkable chain via parentId.
- New `src/spine/retry.ts`: `retry(taskId)` returns `{task, newTask}`. Status guard: only operates on `failed`. Logs `task.retried` event with `newTaskId` + `previousError` for audit.
- New CLI: `forge retry <task-id>`. Prints both ids (failed + new pending).
- New POST endpoint `/api/retry/:taskId` shells out to `bin/forge retry` per FORGE-DEC-015. CSRF + interactive gates apply.
- Dashboard:
  - Failed tasks show an alert banner with the error + a "↻ Retry task" button in a new section above the inputs.
  - `taskHeaderSection` renders `RETRY OF <id>` (when current task has a same-phase non-red parent) and `RETRIED AS <id>, ...` (when same-phase non-red children exist with this task's id as parentId). Clickable — selectTask navigates the chain.
  - Smart-refresh detail key includes a "chain signal" (parent + child statuses) so retry-creating-a-new-row triggers a re-render even though `td.task` itself didn't change.
- 13 new tests across spine + server. Spine tests cover: original-stays-failed, new-pending-with-parentId, inheritance of phase/role/inputs/model, fresh composedSystemPrompt slot, cascading chain, both rows persist.
**Caught:** 2026-05-08 — `task-brief-6cc6ca` failed with AWS auth expiry. First fix was mutate-in-place; mid-review Steven called out that audit history should be preserved. Insert-new is the right shape.
**Out-of-scope:** rerun-on-complete (different semantics — user wants a different result from same inputs; needs design before implementing).

### #70 — Workflow rename refactor + composed feature-ui-design-needed + awaiting_red status
**Closed:** 2026-05-08 evening, on branch `workflow-rename-70` (203 tests passing).
**What shipped:**
- **Renames** (disambiguating "design" — was overloading system-architecture and UI/UX):
  - `feature-design-needed` → `feature` (the no-UI variant; CLI / API / library / refactor work)
  - `feature-design-provided` → `feature-ui-design-provided` (added architect phase at front; was missing — Steven 2026-05-08: architecture review is universal across feature work)
  - `design-revise` → `ui-design-revise` (new file; the old design-revise.ts was already deleted under #58)
  - `investigation.frame` phase → `frame-question` (was ambiguous in dashboard rendering)
  - `ui-design.review` phase → `ui-review` (consistency with composed workflow)
- **New workflow file:** `feature-ui-design-needed` — composed shape: brief → ui-review → architect → plan → build → verify. Mixes manual + agent + reds + onReject branching. Forge's most complex workflow shape. The architect's onReject loops back to `brief` (revise the design first per Steven Q2).
- **FORGE-DEC-017 + new task status `awaiting_red`** — honest vocabulary for "blue done, reds running, gate not yet decided." Was being collapsed into `complete` which was a lie. Wired through dispatch.ts (sets status), next.ts (surfaces kind), advise.ts (informational, ranks after running), reconcile.ts (skips), CLI status icon (⏵), dashboard badge tone + sort rank (peer of running).
- **Architect seed updated** — reads `inputs.upstream[*].result.{htmlFiles,pngFiles}` when present; treats the design as canonical UI; surfaces design/code conflicts as architectural decisions. Re-installed via FORCE=1 install-seeds.sh.
- **Phase data migration in db.ts** — UPDATE runs SET workflow on the rename pairs, UPDATE tasks SET phase for `frame`→`frame-question` and `review`→`ui-review`. Idempotent. No alias map (Steven 2026-05-08: "we need to wait for my current test run to complete! Solves it no?" — yes; in-flight migration not needed if no in-flight runs).
- **Modal grouping** (Steven Q3): WORKFLOW_GROUPS introduced (Build features / Design UI / Investigate or audit), rendered as native `<optgroup>`s in the picker. WORKFLOW_ORDER derived from groups so they stay in sync.
- **Tests:** advise.test, fanout.test, reconcile.test, composeSystemPrompt.test, manualPhase.test, submit.test, gate.test, constraints.test, server.test, workflowSchema.test all updated for the new names. New tests for awaiting_red in next.test + advise.test. 203 passing total (was 199).
- **CLAUDE.md updated** — state-machine status list, design-workflow exception list.

### #55 — ui-design-revise workflow rewrite
**Closed:** 2026-05-08 (rolled into #70). New `src/workflows/ui-design-revise.ts` registers the same two-phase shape as `ui-design` (brief + ui-review). The brief phase's prompt-author seed gets a workflowAdditions hint pointing at a (future) `templates/ui-design-revise.md`; until that template exists, the standard ui-design template works for revise too — the prompt-author can adapt based on the brief saying "revise X."

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

### #34 — Pretty/raw result view toggle
**Closed:** 2026-05-08, on branch `new-run-modal-66`.
Per-task toggle in the OUTPUT header. Pretty mode walks the result object structurally — top-level string keys become labeled paragraph blocks (split on blank lines so `\n\n`-separated prose reads naturally); arrays of strings become numbered lists; arrays of objects become sub-cards; paths get monospace styling; nested objects render with a left border. Raw mode is the original JSON code block with `white-space: pre-wrap` so it word-wraps too. Toggle state is stored in a closure-scoped Map keyed by task id — survives polling re-renders, lost on full page reload (good enough). Caught when the synthesizer's 3-key output (architecturalImplications + antiFindings + openQuestions) was unreadable as a single JSON wall.

### #72 — Dashboard: smart-refresh
**Closed:** 2026-05-08 afternoon, on branch `new-run-modal-66`.
**What shipped:** Each render function (`renderSidebar`, `renderMiddle`, `renderDetail`) computes a render key from the data + selection state it would draw, and bails out if the key matches the last render. Polling ticks that bring back unchanged data become silent — DOM is untouched, scroll/input/focus/animation/selection state preserved automatically. JSON.stringify-based; cheap because pane data is bounded.
**Why this fix replaces the band-aids:** Previously we patched scrollTop preservation and input-value preservation as scoped fixes for symptoms (scroll-jump on red-verdict reading; textarea wipe mid-typing). Each new form interaction would have needed its own preservation logic. Smart-refresh ends the entire class — when nothing's changed, nothing re-renders. The scroll/input preservation patches stay in place as a second layer (handle the case where data DOES change but the user has unsubmitted state).
**Caught:** 2026-05-08 — three distinct polling-induced bugs in an afternoon (scroll-jump, textarea-wipe, middle-column scroll-jump). Steven's call: stop patching, do this right.

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
- New CLI: `forge submit <task-id> [--notes "..."]`. Validates `<designDir>/<title>.pen` non-zero + `<designDir>/designs/*.png` ≥ 1 + `<designDir>/code/*.html` ≥ 1. Hard-errors on missing `run.metadata.designDir` for `ui-design`/`ui-design-revise`. Captures paths into `task.result` and transitions to `awaiting_gate`.
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

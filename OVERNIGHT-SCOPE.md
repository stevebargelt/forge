# Overnight scope — 2026-05-07 → 08

This file briefs a fresh Claude Code session on the work Steven and I agreed to before he went to bed. **Read this whole file before starting any work.** When done, delete this file in your final commit (it's not durable documentation — the durable record is BACKLOG.md + the ADRs).

## Mandatory reading order before doing anything

1. `CLAUDE.md` — has the conventions including the host-led-design exception and the "no human-time estimates" / "do mechanical work overnight" rules.
2. `BACKLOG.md` — current state. The Notes-for-next-session section names the priorities; #46 in In progress is SUPERSEDED with cherry-pick guidance for the branch we're on.
3. `learnings/decisions/2026-05-07_host-led-pencil-design.md` — FORGE-DEC-014, the architecture pivot.
4. `learnings/decisions/2026-05-07_interactive-dashboard.md` — FORGE-DEC-015, the dashboard architecture (shell out to forge CLI, localhost-only + custom-header CSRF mitigation, defer Electron, vanilla JS in v1).
5. `~/.claude/projects/-Users-steven-bargelt-code-forge/memory/MEMORY.md` — Steven's persistent memory pointers, especially `feedback_overnight_loop.md` (do mechanical work overnight even if gnarly) and `project_pencil_pivot_dec014.md` (today's pivot summary).
6. `~/code/forge-design/designs/01-run-list.png` through `11-prompt-author-interview.png` — the 11-screen dashboard design. **Read every PNG.** They are the spec for the reskin work below. The .pen source is at `~/code/forge-design/dashboard.pen` (458 KB, saved on disk).
7. `src/dashboard/html.ts` — the current 456-line server-rendered HTML. You'll be rewriting this from scratch.
8. `src/dashboard/server.ts` and `src/dashboard/queries.ts` — current dashboard server + SQLite queries. Read but don't restructure unless needed.

## Branch strategy

Work happens on **two branches**, both starting from current state:

- `designer-agent-46` (existing) — for #58 cleanup. Already has all the container-designer commits + tonight's documentation work. Land #58 cleanup here.
- `interactive-dashboard-57` (NEW, branch from `main`) — for the dashboard reskin + interactivity. **Branch from main, not from designer-agent-46.** Main has none of today's work; we want a clean base for the dashboard rewrite.

Cherry-picks land on `main` directly.

## Work plan, in order

### Phase 1: cherry-pick clean wins to main (~15 min, 3 commits)

These commits on `designer-agent-46` are not designer-specific and should land on main now:

1. `58480ec` "Improve Next: hints in CLI: include --project, copy-friendly layout"
2. `099d54e` "forge next: surface awaiting_gate / blocked_by_red after dispatch"
3. `b5d2acf` "Switch agent stdout to stream-json so the idle watchdog tracks live progress"

For each:
```bash
git checkout main
git cherry-pick <hash>
# resolve conflicts if any (unlikely — these touch independent files)
npm run typecheck && npm test    # must stay green
```

If any of the three has a conflict because it depends on later branch work, skip it and note in the commit log. Don't force resolutions.

After all three cherry-picks, push `main` is **deferred** — Steven will review in the morning and push if happy. Leave main with the three commits added.

### Phase 2: container-designer cleanup on `designer-agent-46` (~5 commits)

Per BACKLOG #58. On the `designer-agent-46` branch:

1. **Delete the designer image** — `docker/agent-designer-worker.Dockerfile`, `docker/build-designer.sh`. Update `docker/.dockerignore` to drop the designer-skills allowlist (revert to just `agent-dev-worker.Dockerfile` + `corp-root.pem`).
2. **Delete the designer seeds** — `seeds/agents/designer/` (whole dir including skills/) and `seeds/agents/designer-export/`.
3. **Drop AgentRef.image plumbing** in `src/types/index.ts` (remove the optional `image` field), `src/workflows/_agentRefs.ts` (remove the third arg to `agent()`), `src/spine/dispatch.ts` (remove `image: agent.image` from spawn call), `src/spine/spawnRed.ts` (same), `src/spine/spawn.ts` (remove `image` from `SpawnOptions`/`DockerArgsInput`, remove the conditional PENCIL_CLI_KEY forwarding, remove `pickIdleTimeoutMs` and revert to `resolveIdleTimeoutMs`).
4. **Update spawn unit tests** — drop the image-override test, drop the PENCIL_CLI_KEY tests (3), drop the pickIdleTimeoutMs tests (2). The remaining tests should still pass; if any reference `image` in the input fixture, simplify.
5. **Delete the old workflow files** — `src/workflows/ui-design.ts` and `src/workflows/design-revise.ts` (current shape is wrong). Also remove `ui-design` and `design-revise` from `WorkflowName` in `types/index.ts` and `VALID_NAMES` in `workflows.ts` and `cli/commands/new.ts`. **WAIT** — actually, leave the workflow names registered but delete the workflow files. We'll re-add the workflow files in the morning when #54/#55 ship. If type errors complain about missing files, comment out the names with a TODO. **Decision deferred to runtime — do whichever leaves typecheck green.**

Each step should be its own commit. Typecheck must stay green between commits. Tests must stay green between commits.

After cleanup, run `git log --oneline designer-agent-46 ^main` and update BACKLOG #58 with a "closed: <commit hash>" note (do this as a final commit on the branch).

### Phase 3: interactive dashboard reskin on `interactive-dashboard-57` (the big one)

Branch from main (post-cherry-pick) to a new branch `interactive-dashboard-57`. Then rewrite `src/dashboard/` to match the new designs.

**Target screens** (8 of 11; the other 3 require #54 to be live):

| Screen | Design PNG | Status |
|---|---|---|
| Run list | 01-run-list.png | Required |
| Task list per run | 02-task-list.png | Required |
| Generic task detail | 03-task-detail-generic.png | Required |
| Design-task detail | 04-task-detail-design.png | Required (degrades gracefully if no design data) |
| Awaiting-gate detail (the keystone) | 05-task-detail-gate.png | Required |
| Run-row actions overflow | 06-run-row-actions.png | Required |
| Blocked-by-red detail variant | 08-task-detail-blocked-by-red.png | Required |
| New-run as a CLI-copy button | derived from 07-new-run-modal.png | Stub — see below |

**Skip:**
- 07 full new-run modal (needs `forge new` POST endpoint with multi-field form — defer to daytime). Ship a "+ New run" button in the runs-list header that opens a tiny help popover showing the equivalent CLI command. User clicks "Copy" and runs in a terminal. Real modal in a follow-up.
- 09, 10 (design-handoff, design-review) — need ui-design workflow rewritten first.
- 11 (prompt-author interview) — needs ui-design workflow rewritten first.

**Approach:**

1. **Save the old html.ts** as `src/dashboard/html.legacy.ts` with a one-line comment "kept for reference; remove after 57 ships." Don't delete yet.
2. **Build a new html.ts from scratch.** Structure it as small render functions (one per screen variant), not one big string. Use template literals; no framework. Match the designs faithfully — palette, typography, density, badge taxonomy, layout.
3. **Add CSS variables for the Lunaris palette** in a `<style>` block at the top of the rendered HTML. Source the values from the .pen file's variables (you can read them via Read on `~/code/forge-design/dashboard.pen` and grep — it's JSON). Use Geist Mono via Google Fonts CDN; Geist for sans.
4. **Add the POST endpoints in server.ts** (refer to FORGE-DEC-015 for the sketch):
   - `POST /api/gate/:taskId` — body `{decision, rationale?, force?}`. Spawn `forge gate` subprocess. Return JSON with the result. Stream stdout/stderr to the response or buffer it.
   - `POST /api/next/:runId` — body `{project?}`. Spawn `forge next` subprocess.
   - `POST /api/runs` — stub for now: just echo back the equivalent CLI command. Don't spawn `forge new` until the new-run modal exists.
5. **CSRF mitigation** — every mutating endpoint requires `X-Forge-Request: 1` header. Set it from the client-side JS.
6. **Feature flag interactivity behind `FORGE_DASHBOARD_INTERACTIVE=1` env var.** When unset (default), the POST endpoints return 503 with a "set FORGE_DASHBOARD_INTERACTIVE=1 to enable" body. The reskin is always visible (it's pure cosmetics + structure); only the buttons-do-things part is gated.
7. **Vanilla JS** for the client side. Inline `<script>` blocks at the bottom of each screen variant. No bundler. Match how the existing dashboard works.
8. **Do NOT change `queries.ts`** unless absolutely required. If a screen needs data we don't have (e.g. the gate audit thread), check what's already exposed first. If something's genuinely missing, add a single new query function with a tight scope.

**Test plan:**
- Typecheck must stay green throughout.
- Existing tests must stay green. Add new tests for the new POST endpoints (mock the subprocess; verify the right CLI args are constructed and the X-Forge-Request header is checked).
- The dashboard server starts cleanly (`forge dashboard`) and serves the new HTML.
- With `FORGE_DASHBOARD_INTERACTIVE=1`, click a gate button and verify it shells out to `forge gate` correctly. (Manual test note for morning Steven — don't try to automate this overnight.)

**Commit strategy:**
- Commit per screen + commit per architectural piece. Maybe 8-12 commits.
- Each commit message should reference the design PNG it implements (e.g. "Reskin run-list to match design 01-run-list.png").
- The first commit (palette + typography + the legacy.ts rename) sets up everything else; subsequent commits implement screens incrementally.

### Phase 4: post-flight (~10-15 min)

When phases 1-3 are done:

1. **Update BACKLOG.md** — mark #57 in In progress with a manifest of what shipped (which screens, what's behind the feature flag, what's deferred). Mark #58 closed with the commit hash range.
2. **Update Notes-for-next-session** at the top of BACKLOG with: "End of overnight session. Cherry-picks landed on main. #58 cleanup done on `designer-agent-46`. #57 v1 (reskin + interactive backbone) live on `interactive-dashboard-57`. Next: validate prompt-author seed (#53), wire up #54/#55, then unblock the deferred screens 07/09/10/11."
3. **Write `~/code/forge-design/FOLLOWUP-PROMPT.md`** — see Phase 5 for what goes in it.
4. **Delete this `OVERNIGHT-SCOPE.md` file** in a final commit. It's done its job.
5. **Final summary message** — recap what was done, list anything skipped or deferred with reasons.

### Phase 5: design-gap discovery + optional design execution (Steven's last request before bed)

Steven asked for two things on top of the implementation work:

**5a. If you find design gaps while implementing the 8 screens**, capture them in `~/code/forge-design/FOLLOWUP-PROMPT.md`. Examples of what counts as a gap:
- A status code or task state the existing 11 designs don't cover (e.g., "what does a `pending` task with no started_at yet look like?")
- A screen variant the brief didn't anticipate (e.g., the empty-state when a user has zero runs)
- Visual elements that don't render coherently when wired to real data (e.g., a verdict card with 0 findings — the design assumes ≥1)
- Something the implementation needs that the design just doesn't show

Don't invent design choices to fill gaps — capture them and let Steven run them through Pencil in the morning. The FOLLOWUP-PROMPT.md should be in the same shape as `~/code/forge-design/MISSING-SCREENS-PROMPT.md` (which Steven ran successfully) — point at the existing dashboard.pen, list the missing screens with one paragraph each, include the standard WORKFLOW REQUIREMENTS block (touch precondition, open_document, filePath everywhere, find_empty_space_on_canvas, export+rename, the loud Cmd+S warning).

Always write FOLLOWUP-PROMPT.md, even if you think you covered everything — it can simply say "no gaps found; here's a prompt for a third pass if you want one." Easy for morning-Steven to discard.

**5b. (Optional, do this only if MCP is connected and reliable.)** If the Pencil MCP server is connected in your session (check via tool availability — `mcp__pencil__open_document` etc. should be in your toolset; if not, skip this entire substep), you may **run the FOLLOWUP-PROMPT.md yourself**. The catch: you cannot trigger Cmd+S from any tool you have. So:

- DO: produce designs, export PNGs (these persist on disk), update the in-memory dashboard.pen.
- DO: include in the final summary message a note: "I ran the followup prompt; PNGs are at `~/code/forge-design/designs/<new-names>.png`; dashboard.pen has updated content in-memory but is UNSAVED — please Cmd+S in VS Code first thing."
- DO NOT: attempt AppleScript / osascript / xdotool / pyautogui or anything else that simulates a Cmd+S keystroke. The risk of misfiring into the wrong app is bad. Steven explicitly approved this constraint before going to bed.
- DO NOT: claim the .pen is saved. It is not, until Steven Cmd+Ses.

If MCP isn't connected, just leave FOLLOWUP-PROMPT.md on disk and note "MCP not connected; I didn't run the prompt — Steven, run it in the morning."

If MCP is connected but a tool call fails partway, capture what got produced (any successfully-exported PNGs survive on disk) and document the failure mode in the final summary. Don't retry indefinitely; one retry max, then move on.

This whole substep is a stretch goal. The implementation work in phases 1-3 is the priority. Don't sacrifice phase 1-3 quality to attempt phase 5b.

## Hard constraints (non-negotiable)

- **Typecheck green at every commit boundary.** `npm run typecheck` after every commit.
- **Tests green at every commit boundary.** `npm test` after every commit. If a test breaks, fix it or revert before moving on. Never have a red commit.
- **No package additions.** No `npm install <new-thing>`. Vanilla JS, vanilla Node, what's already in package.json.
- **No schema migrations.** SQLite schema in `src/store/` doesn't change. If something needs a schema change, document it as a follow-up entry in BACKLOG and skip the screen.
- **No commits to main directly.** Cherry-picks only. All new work on the two branches.
- **No deletes that aren't reversible.** `git mv` over `git rm`+create. Keep `html.legacy.ts` until Steven says drop it.
- **No pushes to remote.** Steven reviews and pushes himself in the morning.
- **No skipping the BACKLOG update.** It's how morning Steven knows what happened.
- **No AppleScript / osascript / keyboard-simulation tools** to trigger Cmd+S in VS Code, or any other app. Steven explicitly considered this and ruled it out — the risk of misfiring into the wrong app while he's asleep is unacceptable. Pencil .pen files stay unsaved when this overnight session ends; morning-Steven Cmd+Ses to persist. PNG exports do persist via `mcp__pencil__export_nodes` and don't need Cmd+S.

## When to stop and write a TODO instead

If you hit any of these, document and skip:

- A schema change becomes necessary
- A package install becomes necessary
- A test breaks and you can't see why in 10 min
- A design choice has multiple reasonable interpretations and the wrong one would be hard to revert
- You finish phase 3 and have time to do phase 5 work — instead of starting #54 (which needs Steven's interactive validation), update BACKLOG with what you'd do next, commit, stop.

## Final-summary template

When you wake morning-Steven up with your final message, include:

1. Branch summary: which branches touched, how many commits each, current head hash.
2. Cherry-picks: which landed on main, any conflicts skipped.
3. #58 status: closed or in-progress, what was deleted.
4. #57 v1 status: which screens shipped, screenshots not possible from MCP-less session — describe what each screen looks like in 1-2 lines.
5. What was deferred and why (link to BACKLOG entries).
6. Anything that surprised you (tests that needed fixing, design ambiguity, unexpected tooling behavior).
7. Suggested first action for morning-Steven: probably "run `FORGE_DASHBOARD_INTERACTIVE=1 forge dashboard` and see what landed."

## Notes for fresh-session-me

- Steven explicitly told me to default to "do the work, even if gnarly" overnight. Don't hold back. He'd rather have something to react to than walk into a clean tree.
- The 11 dashboard PNGs are GOOD. Trust them. Don't second-guess the visual choices unless they actively conflict with what forge can show (e.g. screen 07 is a modal we can't fully implement tonight — that's the only one we degrade).
- If something is ambiguous and can be resolved by reading the .pen file directly: do that. The file is at `~/code/forge-design/dashboard.pen` (458 KB JSON). It has the actual color values, font sizes, spacing tokens.
- Use `Read` (not `Bash cat`) on the .pen file. It's JSON; can be parsed.
- Tests live in `src/**/*.test.ts`. Pattern is node:test. The `dashboard/server.test.ts` file exists; extend it.
- I am allowed to commit. I am allowed to refactor. I am allowed to make taste calls. Steven will tell me what to change in the morning.
- I am NOT allowed to push to remote, alter schemas, install packages, or skip the BACKLOG update.

Go.

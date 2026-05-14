# forge — backlog

Canonical task list for forge. Numbers are sticky across sessions and referenced from commit messages (e.g. `fixes #30`, `partial #25`). New items get the next available sticky ID and never get renumbered.

When you start a session, read this file. When you finish, update it: move closed tasks from "Active" / "In progress" to "Done (recent)" with their commit hash; rewrite "Notes for next session" with whatever the next session needs to know.

## Notes for next session

**State at end of 2026-05-13 (late).** `red-arrow-127` branch has three new commits ready to merge: `8e7306c` (#121 env-snapshot auth), `ec6a519` (#127 red arrow dotted tether), `fc59414` (verifier seed tighter render-check). `main` is at `520dd5b` (#128 container browser-tools). 355/355 tests passing on the branch.

**What shipped today (2026-05-13) — big day:**
- **#105** System Map view (replaces old graph view). Commit `5a44588`, merged to main as `6a1b6aa`.
- **#114** mount `--design-dir` read-only at `/design` inside containers (commit `414b29b`).
- **#113** discipline reds gate the parent like wide/narrow (commit `79d6edf`).
- **#126** host-side pi-skills/browser-tools install + validation (no forge code change).
- **#128** forge container-side browser-tools migration + Playwright MCP teardown (commit `520dd5b` on main).
- **#127** red→parent arrows now render as dotted magenta tether (commit `ec6a519` on `red-arrow-127`). **First forge run that exercised #128 end-to-end** — produced the change, verified via browser-tools screenshot.
- **#121** env-snapshot bedrock auth (commit `8e7306c` on `red-arrow-127`). Landed earlier than the planned v2/#116 timing because it was the actual blocker on the #127 run.
- **Verifier seed iteration** (commit `fc59414`) — first verify pass on #127 reasoned its way out of the render-check ("just CSS values"); the seed copy was rewritten as a hard file-extension rule with explicit anti-pattern callout. Second verify pass invoked browser-tools 22 times.
- **#129** spun out as future feature (shareable agent-skills pattern; placeholder).

**Pending next-session action: merge `red-arrow-127` → `main`.** Fast-forward or `--no-ff`, your call. After merge: only `main` remains.

**Top of the active stack now:**
1. **#116** — **Forge v2.** YAML-driven orchestrator replaces the TypeScript spine. Keep SQLite + dashboard + gate.ts + reconcile.ts. PRD at `docs/prds/yaml-orchestrator-116.md`. Big-bang, TypeScript runner, YAML in both `~/.forge/` and `<project>/.forge/` with override. Closes #106 (provider abstraction) as a side effect. Paired Steven+Claude work, not a forge run.
2. **Auth fix cluster (REDUCED IN URGENCY by #121 landing).** **#117** watchdog default profile hardcoded wrong, **#118** watchdog has no log, **#119** manual `aws sso login` leaves STS cache stale, **#120** `forge auth status` is shallow. All still real bugs, but they apply only to mount-mode (now opt-in via `FORGE_AUTH_MODE=mount`). Decide whether each is worth fixing or just deprecating mount mode further.
3. **#115** dashboard task list smart-refresh gap. Two cases (task.started transition + new task creation). Composite with #77 (Preact migration).
4. **#112** transactional dispatch + gate writes. Worth landing before #116 since the runner's gate-decision-write boundary references this pattern.
5. **#125** implementer seeds don't mention `forge-test` — ~10 lines in 4 seed files. Caught during #105.
6. **#107** reds-during-reconcile design conversation. Architectural question, not implementation-ready.
7. **#96 sub-shifts 3+4+5** (implementer fanout + orchestrator). **Absorbed by #116** — v2 makes DAG-driven implementation fanout the default model.
8. **System Map polish:** **#124** drag-overrides Map LRU cap, **#123** a11y posture. (#127 closed today.)
9. **#129** — shareable agent-skills pattern (future). Placeholder.

**New issues caught during the #127 run, worth filing as their own tickets if not already:**
- **Bedrock concurrency starvation.** 5 reds dispatched in parallel; red-security's container produced zero stdout for 5 minutes, idle-watchdog killed it. Verdict defaulted to `inconclusive`. Probably Bedrock throttling at the account-quota tier with no client-visible retry signal. Worth filing — small surface, recurring pattern likely.
- **Dashboard server doesn't auto-restart on file change.** Verifier on #127 found that `host.docker.internal:8022` still served pre-diff code because `tsx` reloads on file changes but the bundled CLIENT_JS that ships to the browser doesn't reload until the dashboard process restarts. Verifier pivoted to a synthetic cytoscape render to validate. Worth filing — interferes with live-diff visual verification.

**Useful runtime state:**
- `agent-dev-worker:latest` was rebuilt during #111 to bake `forge-test`.

**Honest flags:**
- **System Map renderer pass on 2026-05-13** was iterative — the agent build phase shipped a working data layer + a broken renderer (didn't open in a browser, didn't compare to design). The verify phase only tested the new file; full design fidelity came from a manual iteration session with Playwright + screenshots. **Lesson for #116:** verify-phase for UI work needs eyes-on-the-render, not just tests-green.
- **#25 + #32 still un-validated end-to-end** (reject/onReject flow, failed-result detection).
- **The #105 forge run was forge running on forge itself** — second time (#91 was first). Worked, in a "5 retries on the planner phase + 4 of 5 reds failed in build" sense. Real architectural value at architect + planner; red review caught real renderer bugs but with a lot of noise (3 of 5 reds raised partly-wrong findings). The pattern works; the cost is real.

**Local-only files (gitignored):** none currently.

**Branch hygiene:** All branches deleted 2026-05-13 after the System Map merge — only `main` remains.

## Active

### #116 — Forge v2: YAML-driven orchestrator, keep SQLite + dashboard
**Why:** Caught 2026-05-12. Steven's been carrying a "too complicated" feeling about the TypeScript control system for a while; this session surfaced the shape that resolves it. Two reference repos — `~/code/de-dev-adx-example-workspaces/jeffs-workspace-boilerplate/` and `~/code/local-adx-workspace-2/multi-agent-package/` — already run a productized version of the model Steven wants: `pipeline.yml` per project, `runtime-*.yml` per provider, agent markdown under `agents/<role>.md`, a small executor reading YAML and spawning containers. Jeff's model is deployed across 8+ live projects (analysis-code, mysg, atlas-hq, sgws-ops-dashboard, etc.) — not a sketch.

**The hybrid.** Take Jeff's *shape* (declarative YAML, small executor); keep forge's *correctness layer + UX* (SQLite, dashboard, gate logic, reconcile, transactional writes). Workflows become YAML files. Providers (claude-bedrock, claude-oauth, claude-apikey, future codex/openai) become runtime YAML files. Agents stay markdown + settings.json, just relocate to `~/.forge/agents/`. The runner becomes ~400-600 lines of TypeScript that walks YAML steps and writes to the existing SQLite tables. Closes #106 (provider abstraction) as a side effect — adding a provider becomes a YAML file, not architecture work.

**Decisions locked 2026-05-12:**
- **Big-bang migration.** New branch `yaml-orchestrator-116`. TS spine code paths gone at land; YAML runner is the only orchestrator. No flag, no dual-path.
- **TypeScript runner**, not Python. Keep forge mono-language; borrow Jeff's shape, not his language.
- **YAML lives in both places with override**: `~/.forge/workflows/` + `<project>/.forge/pipeline.yml` (last-one-wins by filename match). Same for agents and runtimes.

**What stays.** SQLite schema, dashboard, gate.ts (verdict aggregation, force-advance, blocked_by_red), reconcile.ts (orphan recovery, transactional writes #109, #112 if landed), constraints.ts (file-based constraints with frontmatter unchanged), the agent seed structure (just moved from `seeds/` to `~/.forge/agents/` at install time).

**DAG-driven implementation fanout is in scope** (added 2026-05-13). v2's build phase is a step DAG, not a static agent list. Planner emits `depends_on` + `discipline` + `files_modified` per step; runner walks the DAG, parallelizes where deps allow, routes each step to the matching specialist implementer (frontend / backend / infosec / general). This **replaces #96 sub-shifts 3+4+5** — the fanout-in-build vision lands as the v2 default, not a v1 primitive. Specialist red seeds (#96 sub-shift 1, shipped 2026-05-09) and specialist implementer seeds (#96 sub-shift 2, shipped 2026-05-09) become v2 building blocks.

**What goes.** `src/spine/{workflows,dispatch,spawn,spawnRed,next,composeSystemPrompt}.ts` (replaced by the runner + YAML loading). `src/workflows/*.ts` (translated to YAML). `src/util/creds.ts` (its detection logic moves into runtime YAML).

**PRD:** `docs/prds/yaml-orchestrator-116.md` — full scope, reading list, architectural angles for the architect.

**Sequencing.** This starts *after* #105 (System Map) lands and merges. The System Map is in-flight as of 2026-05-12; v1's dashboard work should land in main before v2 starts replacing the spine underneath it. #112 (transactional dispatch + gate writes) should also land first if possible — those transaction patterns become reference for the runner's gate-decision-write boundary.

**Not running through forge.** Considered + rejected 2026-05-12. Three reasons: (1) forge v1 is the executor for v2's build — implementer mid-run editing the spine that's dispatching it is a real deadlock risk; (2) the hard work is design (YAML schema, runtime resolution, phases-vs-steps), not implementation, and the PRD already captures the framing — architect's value-add is weakest on already-thought-through problems; (3) step boundaries for a rewrite are themselves architectural decisions; planner would produce a decomposition but probably not the right one. Paired Steven+Claude session work instead, with small translation tasks possibly farmed out to agents once the schema is locked.

**Caught:** 2026-05-12 — during architecture discussion after the System Map planner output rejection.

### #129 — Shareable agent-skills pattern (future feature)
**Why:** While doing #126 (pair-coding side) on 2026-05-13, the pattern surfaced as something with reach beyond forge. The combination of Mario's Skills-format choice + the symlink-on-host / bind-mount-in-container duality is generally useful — any tool the human and an agent both want (screenshot, eval, search, transcript, calendar) wants both surfaces. The natural product is something like "use Mario's tools from this repo, with a small install dance for both surfaces."

**Not designed yet — this is a placeholder.** Open shape questions:
- Is the deliverable a new repo (`forge-skills`, `agent-browser-stack`), a documented section in forge README pointing at pi-skills, or something else?
- Provisioning model: `install.sh` that takes a list of skills + lays down host symlinks + npm-installs + emits a container mount manifest? A YAML config that forge v2's runtime YAML (#116) consumes? Both?
- What's forge-specific vs. general: `spawn.ts` mount injection and v2 runtime YAML wiring are forge-specific. The Skills-format choice, host-symlink/container-mount duality, and pi-skills install dance are general.

**Don't extract prematurely.** Ship #128 (forge container-side use) first. When a second consumer appears (another project, another team, someone else hitting the same Playwright-MCP token-tax pain), revisit and extract.

**Composes with #116 (forge v2):** runtime YAML may be the natural home for "this runtime gets these skills mounted." That's where to design provisioning if the answer becomes "config-driven."

**Caught:** 2026-05-13.

### #125 — Implementer seeds don't mention `forge-test`; tests fail mysteriously in build phase
**Why:** Caught 2026-05-13 reviewing the System Map (#105) build phase output. The implementer ran `npm test` inside its container, got 203 pass / 143 fail (better-sqlite3 ELF mismatch — host's darwin-arm64 binary doesn't load on container's linux-amd64), and reported them as "pre-existing failures unrelated to this change." On the host they're 345/345 green.

**Root cause:** `seeds/agents/verifier/CLAUDE.md:28-38` documents `forge-test` (the wrapper that rebuilds better-sqlite3 in `/tmp/forge-work` per #111), but **none of the implementer seeds do**. Today's implementer happened to use forge-test for the new targeted test file (it discovered the wrapper somehow) but reverted to `npm test` for the full-suite check. Result: misleading failure numbers in result.json, confused agent narrative, no actual regression.

**Affected seeds:**
- `seeds/agents/implementer/CLAUDE.md`
- `seeds/agents/frontend-implementer/CLAUDE.md`
- `seeds/agents/backend-implementer/CLAUDE.md`
- `seeds/agents/infosec-implementer/CLAUDE.md`

**How to apply:** Copy the forge-test block from `seeds/agents/verifier/CLAUDE.md:23-40` (the "When running tests inside this container" section) into each implementer seed under its own testing guidance. Same language, same examples, same caveat about infra-vs-test failures. Plus an explicit "never run plain `npm test` — always `forge-test`" sentence; explicit-by-prohibition matches how #92 (architect scope) was tightened to good effect.

**Why this is worth doing right now (not waiting for #116):** every build phase between today and v2 hits this same gap. The fix is ~10 lines in 4 files. Low risk, high signal-to-noise improvement in result.json narratives. In v2 (#116), the per-runtime guidance might move to a different place (runtime YAML? per-step task_file?), but the *content* survives — agents need to know about forge-test regardless of how the orchestrator dispatches them.

**Caught:** 2026-05-13 — build phase result.json analysis.

### #124 — System Map drag-overrides Map grows unbounded across run switches
**Why:** Caught 2026-05-13 by red-build-337afd during System Map (#105) red review (severity: low). Module-level `dragOverrides = new Map()` is keyed by runId — opening the System Map on run A, dragging some nodes, closing, opening on run B, repeat — each runId accumulates its own inner Map of `{taskId → {x,y}}` and never gets cleaned up. Across a long dashboard session viewing many runs, the outer Map grows. Functionally fine: entries are tiny objects, no perceptible memory pressure even with hundreds of runs. But it's bounded-by-the-user's-patience, not bounded-by-anything-meaningful.
**How to apply:** A few options worth weighing:
- Cap the Map to N most-recently-used runs (10? 20?) with a simple LRU. Cheap.
- Clear entries on `loadRunDetail` for runs other than the current one. Simpler — only the current run keeps its drag state. Slightly worse UX (switching back to a run you previously organized loses your layout).
- Persist drag positions to DB per-run instead of in-memory. Counter to the explicit "drag-stable per-run-while-viewing only" decision in #105's PRD. Not the right move.
Lean LRU at 10 runs. Caps without forcing UX loss.
**Caught:** 2026-05-13 — red review of System Map build.

### #123 — Dashboard a11y posture: System Map (and broader dashboard) lacks focus indicators, aria-labels, non-color status signals
**Why:** Caught 2026-05-13 by red-build-5b7129 during System Map (#105) red review. Six findings on the System Map specifically: filter chips lack visible focus indicators for keyboard navigation; modal is a keyboard trap with no visible escape path in keyboard focus order; HTML node labels signal status via color only (no secondary indicators / no sufficient text contrast); filter chips + close button lack aria-labels; cytoscape canvas container is a generic div with no accessible semantics or labeling; progress bar has no accessible text alternative. **All legitimate**, but **not System-Map-specific** — this is the broader dashboard's a11y posture, which has never been audited. The findings would surface on any other dashboard view too.

**Why not blocking #105:** the PRD didn't require a11y; the dashboard's existing surfaces have the same gaps; an a11y pass is a cross-cutting concern that deserves its own dedicated work, not a dashboard-feature-by-dashboard-feature bolt-on.

**How to apply (when):**
- Audit the dashboard as a whole, not the System Map in isolation. Pill row, task list, task detail, gate UI, run-new modal, auth indicator — every interactive surface gets the same treatment.
- Focus indicators: `:focus-visible` styles via CSS for all interactive elements. Not specific to one view.
- aria-labels on icon-only buttons + dynamic regions on the live-updating task pane.
- Keyboard navigation map: confirm tab order makes sense, Esc closes modals, no traps.
- Color + non-color status signaling: status badges already carry text ("complete" / "running"), so much of the color-only finding is incorrect-on-inspection — but the System Map's node label is the most color-heavy, would benefit from a glyph or text-label secondary signal.

**Sequencing:** post-#105 cleanup. Probably 1-2 days of focused work; not urgent, not in scope until a real user with an accessibility need surfaces.

**Caught:** 2026-05-13 — red review of System Map build.

### #122 — Dashboard request-changes doesn't auto-dispatch the replacement task
**Why:** Caught 2026-05-13 during System Map (#105) planner iteration. Workflow: click "Request changes" with rationale on the planner output. Spine inserts a new pending task for the same phase per `gate.ts:173-179` (re-queue with rationale injected as `inputs.requestedChanges`). Expected: dashboard automatically dispatches the new task (same way #108 chained gate-advance into `forge next`). Actual: the new task sits at `pending` until the human clicks "Run Next" a second time. Two clicks for what should be one action.

**Why this is a real bug, not a UX preference:** Request-changes IS the human's "redo this" decision. There's no second decision pending; nothing else the human reasonably wants to do between "request changes" and "dispatch the redo." The two-click pattern adds friction without adding choice.

**How to apply:** Look at how #108 wired advance auto-dispatch — same hook, same pattern. The dashboard's `/api/gate/:taskId` handler returns `nextTasks` from `gate()`; for advance, the dashboard chains into `next()`. The request-changes branch returns the replacement task in `nextTasks` too but the dashboard doesn't follow up. Probably 5-10 lines in the dashboard's gate handler — same auto-dispatch hook, just trigger on request-changes too.

**Doesn't apply to:**
- `reject` — that loops to a *different* phase via `onReject`; auto-dispatching could surprise the human (different phase, different agent, may want to pause).
- `advance` — already auto-dispatches per #108.
- `request-changes` to a manual phase — these throw at the spine layer per `gate.ts:152-157` so they can't reach this path.

**Composite with #115** (middle pane misses task.created): if #122 ships first, the request-changes flow becomes "click, see new task running" — which only works correctly if the middle pane actually shows the new task. #115 fixes the rendering gap; #122 closes the auto-dispatch gap. Both needed for the flow to feel right end-to-end.

**Not relevant for #116:** in the YAML orchestrator, request-changes is probably just a step-re-spawn, not a separate task-row insertion + dispatch. This is a v1 patch.

**Caught:** 2026-05-13 — after iterating planner output three times on System Map run.

### #120 — `forge auth status` is shallow + the underlying health probe is local-clock-only
**Why:** Caught 2026-05-13 during diagnosis of #119. `forge auth status` for bedrock mode prints only `Auth mode: bedrock` + `AWS_REGION: us-east-1` — no SSO expiry, no STS cache state, no actual probe of whether the chain works. **Two bugs underneath:**

1. **CLI doesn't call the existing `getAuthState()` probe.** `src/cli/commands/auth.ts:103-128` reads `process.env.CLAUDE_CODE_USE_BEDROCK` and stops. The richer probe (`src/util/creds.ts:514` `getAuthState()`) checks SSO session expiry, parses the profile, returns `health: ok|expired|missing` + a `remediation` string. The dashboard's auth indicator (#97) uses it. The CLI doesn't. One-line fix: replace the dumb printing in `auth.ts:103-128` with a call to `getAuthState()` and a structured print of its fields.

2. **`getAuthState()` itself only checks the local clock**, not whether the credentials actually work. The bedrock branch (`creds.ts:516-542`) reads `~/.aws/sso/cache/*.json`, extracts `expiresAt`, returns `health: ok` if not clock-expired. That misses the failure mode from #119: AWS revokes the credential chain server-side when a new SSO session is minted; the old token's expiresAt is still in the future, so the probe says "ok" while STS returns 403.

**How to apply:**
- **#120a (small):** wire `auth.ts status` to `getAuthState()`. Print mode + health + identity + remediation + expiresAt + watchdog status + STS cache mtime. Cheap, makes the CLI useful immediately, doesn't fix the deeper probe gap but at least surfaces what we know.
- **#120b (bigger):** make `getAuthState()` actually exercise the chain when called explicitly. Two options:
  - (i) Call `aws sts get-caller-identity --profile <p>` as part of the probe. Adds ~500ms but is the only way to know whether the chain works. Probably too expensive for the dashboard's frequent-poll path; gate behind an explicit `--deep` flag or only run in the CLI's `status` command.
  - (ii) Compare STS cache mtime against SSO session token mtime. If SSO session is newer, the STS cache is stale (per #119's diagnosis). Doesn't catch *all* failure modes but catches the common one without hitting AWS.

Lean (i) for the CLI's `status` command (run once, user-initiated, the cost is acceptable). Lean (ii) for the dashboard's polled indicator (cheap, catches the common case).

**Composite with #117 / #118 / #119:** all four are auth-failure failure modes. #117 (wrong watchdog profile) prevents prevention; #118 (no log) hides the evidence; #119 (manual SSO leaves STS cache stale) is the runtime symptom; #120 is "forge can't even tell you what's wrong." Fix all four and the SSO auth path becomes honest.

**Caught:** 2026-05-13 — alongside #117/#118/#119 in same diagnosis session.

### #117 — SSO watchdog default profile is hardcoded and wrong for most setups
**Why:** Caught 2026-05-13. `scripts/run-sso-watchdog.sh:33` defaults `SSO_WATCHDOG_PROFILE` to `adx-dev-sso`. Steven's actual setup uses `adx-dev` (the sso-session is named `adx-dev`, the profile is `adx-dev`, no `-sso` suffix anywhere). The watchdog has been running overnight (PID 64730, started May 12 20:20) but refreshing the wrong profile name — `aws sso login --profile adx-dev-sso` fails because that profile doesn't exist in `~/.aws/config`. Watchdog's `stdio: 'ignore'` in `src/util/sso-watchdog.ts:42` swallows the error output, so the failure was invisible.

**How to apply:** Two options worth weighing:
- (a) Default `SSO_WATCHDOG_PROFILE` to `${AWS_PROFILE:-adx-dev-sso}` in the script. Simplest — the watchdog inherits whatever the user's shell already set, falling back to today's default only when AWS_PROFILE is unset.
- (b) `src/util/sso-watchdog.ts` reads `process.env.AWS_PROFILE` at spawn time and passes it to the script as `SSO_WATCHDOG_PROFILE=<value>` in the child env. Marginally cleaner separation (script doesn't read env directly, forge controls the value).

Lean (a). Minimal change, matches how the user already authenticates, no schema change.

**Caught:** 2026-05-13 — diagnosing task-plan-7acda2 auth failure on the System Map (#105) run.

### #118 — SSO watchdog has no log file; failures are invisible
**Why:** Caught 2026-05-13 alongside #117. `src/util/sso-watchdog.ts:42` spawns the watchdog with `stdio: 'ignore'`. Any output the script produces (the `echo "[watchdog] ..."` lines for SSO-OK / refresh-attempt / refresh-failure) goes to `/dev/null`. When something goes wrong (wrong profile per #117, AWS CLI not installed, network blip), there's no on-disk record. Yesterday's #117 failure was undetectable until the container errored, which itself took hours.

**How to apply:** Redirect the watchdog's stdout+stderr to a log file at `~/.forge/sso-watchdog.log` (or one log per runId, rotating). Trade-offs:
- Single log: simpler; tail-able; old runs' entries linger
- Per-run log: cleaner audit per run; more files; harder to grep across history

Lean single log with a length cap (truncate-on-start or rotate at N MB). The script already prints timestamps, so a single log is grep-friendly.

Implementation: in `src/util/sso-watchdog.ts`, replace `stdio: 'ignore'` with `stdio: ['ignore', logFd, logFd]` where `logFd` is `openSync('~/.forge/sso-watchdog.log', 'a')`. Add a `forge auth watchdog-tail` CLI subcommand or similar so the user can read it without remembering the path.

**Caught:** 2026-05-13 — same diagnosis session as #117.

### #119 — Manual `aws sso login` invalidates forge's STS cache but forge doesn't notice
**Why:** Caught 2026-05-13. Failure mode: SSO session aged out overnight (watchdog wasn't refreshing per #117), Steven did `aws sso login --profile adx-dev` manually at 06:33 PDT. New SSO session minted. But `~/.aws/cli/cache/<hash>.json` still held STS credentials derived from the *old* SSO session — clock-valid (`Expiration: 2026-05-13T19:12:27Z`) but actually revoked by AWS the moment the new session was created. Container at 06:34 read the stale-but-clock-valid STS creds, sent them to Bedrock, got 403 "security token expired" on the first request and every retry. The container itself can't refresh — `~/.aws` is mounted read-only.

**How to apply:** Three layers worth considering:
1. **Pre-flight check in `forge new` / `forge next`:** beyond the existing #79 SSO-expiry check, verify the STS cache's underlying SSO session is the *current* one. Compare STS cache file mtime against SSO session token mtime: if SSO is newer, the STS cache is stale. Either fail the pre-flight with a clear message ("STS cache stale — run `aws sts get-caller-identity --profile $AWS_PROFILE` then retry") or auto-trigger STS re-derivation by calling that command from forge itself before spawn.
2. **Document the gotcha in `forge auth status`:** if mismatch detected, surface it: "⚠ STS cache predates current SSO session — derive fresh creds with `aws sts get-caller-identity --profile $AWS_PROFILE`."
3. **Container-side detection:** the agent gets 403 on first call; the agent could re-read the STS cache (still won't help since :ro mount), or forge could detect 403-on-first-call in container.stdout and surface it differently from "the agent itself errored" — currently the task just fails with no signal to the human that it was an auth-stale issue, not an agent issue.

Lean (1) + (2). The container can't fix this from inside; forge has to either catch it pre-spawn or guide the human to fix it pre-spawn.

**Composite with #117 + #118:** all three are SSO/STS auth-failure failure modes. #117 prevents the watchdog from doing its job; #118 hides the evidence; #119 is what happens when the human manually papers over the gap. Fixing #117 + #118 reduces how often #119 fires; fixing #119 makes the auth-stale state recoverable without container failure.

**Caught:** 2026-05-13 — root-cause analysis of why task-plan-7acda2 failed despite a fresh `aws sso login`.

### #115 — Dashboard task list middle pane misses task-state transitions (smart-refresh gap)
**Why:** Caught 2026-05-12 during the System Map (#105) forge run. Two distinct cases, same underlying gap:

1. **Status transition.** Clicked "Run Next", architect task transitioned pending → running. Task pane (right) showed running correctly; task list (middle) stayed at `pending`.
2. **New downstream task.** Gate-advanced the architect, next-phase task was created via `createPhaseTasks` (gate.ts:120). Task pane reflected the new task; task list (middle) didn't show it until hard refresh.

Both self-correct on Cmd+R. DB state is honest; the middle pane's smart-refresh (#72) is dropping at least two event classes: `task.started` and `task.created`.
**How to apply:** Audit the middle pane's event subscriptions / render trigger. Likely one of:
- Smart-refresh only listens for run-level events (run.created / run.completed), not task lifecycle
- `task.started` + `task.created` events are emitted but the SSE/poll-derived state-update doesn't reach the middle-pane render path
- The middle pane renders from a snapshot computed once at run-open time; subsequent task list changes don't invalidate the snapshot
The two cases share a root cause — the middle pane isn't subscribed to the task-list-changed signal. Fix the subscription, both cases resolve.
**Composite with #77:** exactly the failure mode #77 (Preact + htm) calls out — html.ts hand-rolling reactive primitives, missing edges between event and re-render. Fixing in place is fine; eventually #77 makes this class of bug structurally impossible.
**Caught:** 2026-05-12 — during the #105 forge run.

### #112 — Transactional dispatch + gate writes (reconcile-half landed as #109)
**Why:** Caught 2026-05-12 alongside #109. The reconcile-half of "wrap multi-write per-task sequences in a transaction" shipped on `951824e` (3 writes per task, fault-injection tests, full rollback semantics). The same shape exists in:

- **`src/spine/dispatch.ts:107-128`** — the happy-path tail after the agent container exits. Two writes (setTaskStatus + logEvent), or four if reds get spawned. Trickier than reconcile because the writes flank an async `spawnRed()` call; the transaction boundary has to wrap **only** the writes, not the docker work. Possible split: pre-spawn writes in one txn, post-spawn writes in another.
- **`src/spine/gate.ts:96-122` + `:166-178`** — advance + reject paths. `gate.ts:96-122` performs `insertGate` + `setTaskStatus` + `createPhaseTasks` (which calls insertTask N times) + maybe `updateRunStatus` for terminal phases. All synchronous, all should be one transaction so an advance that fails to create downstream tasks rolls back the gate decision too.

**Why this didn't ship with #109:** scope. #109 as originally filed listed three paths; the right thing in practice was to focus the fault-injection harness on the orphan-recovery path (where the failure mode is most visible — `reconcile` is what re-runs after a crash, so any non-atomicity there gets stuck on retry). Dispatch + gate are less commonly the recovery point: if dispatch fails mid-writes, the next `forge next` re-dispatches; if gate fails mid-writes, the human re-clicks. But the cleanliness argument still stands — these should be wrapped.

**Approach (mirrors #109):**
- Use `getDb().transaction(() => { ... })()` around each multi-write sequence.
- Sprinkle a `_fault(at)` test hook at named points so tests can inject failures without monkey-patching the store.
- Tests: fault-injection rollback + retry-pin (next call after a transient fault recovers cleanly).

**Acceptance:**
- Dispatch's post-spawn write block + (if applicable) its red-spawn-followup writes are each transactional.
- Gate's advance + reject paths are each one transaction covering all writes including createPhaseTasks.
- Each path has at least one fault-injection test asserting rollback + one retry test asserting subsequent recovery.

**Out of scope:**
- Wrapping the async spawn/spawnRed calls themselves (they take minutes; a sync better-sqlite3 transaction would hold the DB lock the whole time).
- Cross-task transactions (one big txn spanning many tasks). Per-task boundaries are the right granularity.

**Caught:** 2026-05-12 — scope-split from #109 at land-time.

### #106 — Provider abstraction (OpenAI/Codex + future) — NEEDS ARCHITECTURE WORK
**Why:** Today forge's three auth modes (bedrock, anthropic-oauth, anthropic-apikey) all happen to call `claude` against Anthropic models — provider is implicit, not a concept. To support OpenAI/Codex (and future providers like Anthropic-via-Vertex), forge needs **provider** as a first-class abstraction across the spine, the agent container, and the credential layer. This is the architectural prep work that *makes* #97's hierarchical-ready UI meaningful and unblocks future provider additions.

**Scope (high-level — needs design):**
- A `Provider` interface in `src/types` or `src/spine`: identity, model vocabulary, credential detection, container env shape, CLI invocation pattern.
- Refactor `spawn.ts` to ask the provider how to invoke the agent (not hardcode `claude --model`).
- Refactor `creds.ts` to be provider-aware (today's three-mode detector becomes one provider's three credential flavors).
- Container image (#75 territory): may need to host multiple provider CLIs side-by-side, or build per-provider images.
- Workflow/agent declarations: `AgentRef.model` becomes provider-scoped (e.g., `provider: 'openai', model: 'gpt-5'`).

**Not designed yet — this is a placeholder.** When forge actually needs OpenAI/Codex, this gets a real architecture-work session: read the spawn/creds/image code paths, sketch the Provider interface, decide whether providers share containers or get separate ones, plan migration of existing Claude-only code.

**Caught:** 2026-05-11 — surfaced while talking through #97. Steven's call: leave room for OpenAI/Codex without designing it now.

### #96 — Build-phase decomposition: implementer fanout + orchestrator + planner-emits-deps
**Sub-shifts 3+4+5 absorbed by #116** (2026-05-13). Forge v2 makes DAG-driven implementation fanout the default model, not an opt-in primitive — planner emits `depends_on` + `discipline` + `files_modified`, runner parallelizes via the DAG, routes per discipline. The sub-shifts below are the v1 framing; if v1 ships them before #116, they're still valuable. If #116 lands first, the v2 implementation makes sub-shifts 3+4+5 moot. Sub-shifts 1+2 (specialist red + implementer seeds, shipped 2026-05-09) survive in both worlds.

**Why:** Today the `build` phase is a monolith — one `implementer` agent reads the plan, edits the codebase serially, produces one diff. That works for tasks small enough to fit in one agent's head, but it doesn't scale: parallel-safe steps run sequentially, the diff balloons until reds can barely review it, and there's no specialization (a frontend feature, a backend migration, and a security hardening pass all route through the same generic seed). Composite of multiple architectural shifts that share a lens — *the build phase needs to decompose into specialized fanout + coordination, the way other multi-phase forge primitives already work*.

The shift has four sub-shifts. **#92 architect-scope rewrite (closed) is the precedent**: same shape — agent role definition matters more than prompt tweaking. **#73 reds-as-reviewer (open)** is also adjacent — both are "the agent has the wrong job description, not just a wrong prompt."

**Sub-shift 1: specialist reds.** *Shipped tonight (foundation).* Three new red seeds (`red-frontend`, `red-backend`, `red-security`) with `gateOnVerdict: false` (informational, doesn't block) attached automatically to the `build` phase across `feature*` workflows alongside the existing `red-wide`/`red-narrow` authoritative reds. RedConfig extended with optional `additional?: AgentRef[]` to support arbitrary specialist reds. Each specialist reviews through its discipline's lens (a11y, transactions, secrets/auth/CSP). This sub-shift unblocks the others — the implementer-fanout and orchestrator can build on a working specialist-red layer.

**Sub-shift 2: specialist implementers.** *Shipped tonight (foundation).* Three new implementer seeds (`frontend-implementer`, `backend-implementer`, `infosec-implementer`) with discipline-specific framing. Original `implementer` stays as the generic fallback for ambiguous work. AgentRef gains optional `discipline?: "frontend" | "backend" | "infosec"` field. **Not yet wired into workflows.** Workflows still use the generic `implementer` for `build`. The seeds exist; the routing decision is part of sub-shift 3.

**Sub-shift 3: implementer fanout.** *Architecturally open.* The `build` phase fans out per plan-step, one specialized implementer container per step, running in parallel where steps are independent. **Hard parts:**
- **Planner emits a dependency graph.** Today the planner outputs `steps: [{id, summary, files, acceptance}]` — flat. For fanout to work, the planner needs to add `dependsOn: string[]` (other step ids) AND `discipline: "frontend" | "backend" | "infosec" | "general"`. Steps with deps wait for their parents. Steps without deps fan out in parallel. Steps without a discipline route to generic `implementer`.
- **Merge conflicts.** Multiple containers writing to the project at the same time is mechanically supported (each container has rw mount), but only safe if the planner correctly identifies file-level independence. Planner has to be honest about what files each step touches. False-negative independence (claiming two steps don't touch the same file when they do) → race condition between containers. The planner's job gets harder; planner seed needs to acknowledge this constraint.
- **Failure semantics.** Existing `fanout.failureMode` field has options (`fail-phase` | `retry-once` | `continue`). Lean `retry-once` for code-build fanout — transient failures get a chance to recover; persistent failures eventually fail-phase. **Continue is dangerous** for code (broken state); fail-phase is too brittle (one flaky red kills the run).
- **Atomicity of "build is done."** Today `build` produces one diff_summary. With fanout, each task produces its own. The synthesis happens... where? Three options worth weighing: (a) a new `merge` phase between `build` and `verify` that reconciles per-task diffs; (b) `build`'s gate-phase aggregates all sub-task results before advancing; (c) accept N diffs and let `verify` check them all together. Lean (a) — the orchestrator (sub-shift 4) is the natural home for this; merge becomes its visible output.

**Sub-shift 4: orchestrator role.** *Architecturally open.* A coordinator agent that lives inside the `build` phase, runs concurrently with the implementer fanout, and handles the gaps-between-containers that mechanical fanout can't. **What only an orchestrator can contribute:**
- **Pre-flight validation.** Receives the planner's step graph, validates feasibility, surfaces planner mistakes ("steps 3 and 7 both modify the same file but aren't marked as dependent — that's a planning bug").
- **In-flight monitoring.** Watches each implementer's progress. Detects stuck containers (no stdout, no result.json after N minutes — see #74). Detects drift (implementer A finished and changed a file that implementer B's plan assumed was static).
- **Conflict resolution.** When two implementers' file changes overlap, decides merge order, possibly re-plans one of them with the other's diff as input.
- **Finalization.** When all sub-tasks complete (or fail), produces the *aggregate* result that gate.ts reviews — diffs combined, failures surfaced, conflicts noted.

**Where the orchestrator lives in the workflow shape — three options:**
- **(a) Orchestrator-as-phase.** New `orchestrate` phase between `plan` and `build`. Reads the plan, decides parallelism, spawns implementer fanout, monitors, finalizes. The phase doesn't end until every implementer is done. *Cleanest workflow-shape-wise but a new primitive — current phases produce a result and exit; an orchestrator phase persists for fanout duration.*
- **(b) Orchestrator-as-meta-agent within `build`.** `build` has fanout=true plus an orchestrator container running in parallel that watches the fanouts. Two agents per phase; new mental model. *Lean (b) — coordinator is genuinely an agent role with judgment, not spine glue. Modeling it as a peer agent within the phase keeps workflow vocabulary clean.*
- **(c) Orchestrator-as-spine-extension.** Build orchestration into the spine itself, no agent. Mechanical-but-smarter. No coordinator-tokens cost. *Limits orchestration to what spine code can pre-program; loses agent's flexibility for novel situations.*

The decision between (a)/(b)/(c) defers to actual fanout-implementer behavior — needs experimental data.

**Why this matters and earns its tokens:**
- Today's "one implementer reads the plan, edits the codebase, produces a diff" works only for tasks that fit in one head. Forge has shipped that scale; the next scale is multi-step features where each step is its own concern.
- The build phase is the bottleneck for any non-trivial feature. Decomposition moves the bottleneck out.
- Specialization composes with fanout: specialist reds review per-step, specialist implementers handle per-discipline work, orchestrator coordinates. Each layer earns its place because the alternative (one generic agent reviewing/writing/coordinating everything) is forge's #92 architecture-tutoring failure mode at scale.
- `red-wide` and `red-narrow` are *probably* due for retirement once specialists are proven, but tonight's wiring keeps them alongside specialists rather than replacing — additive, reversible.

**How to apply (in order, sized for incremental shipment):**
1. *(Tonight, Tier 1.)* Specialist red seeds + specialist implementer seeds + RedConfig.additional + AgentRef.discipline. Workflows wire specialists to build phase, gateOnVerdict: false, parallel: true. Tests confirm registration. **No fanout yet.** Foundation only.
2. *(Future.)* Update planner seed to emit `dependsOn` + `discipline` per step. Existing build phase still runs serially; planner's new fields are additive metadata.
3. *(Future.)* Convert build phase to fanoutFromUpstream on `steps`. New phase shape that fans out per-step into specialized implementers based on discipline. Failure mode: retry-once. Use existing fanout machinery; specialists earn their places per-task instead of per-phase.
4. *(Future.)* Add orchestrator role. Decide (a)/(b)/(c) shape based on what step 3 reveals. Wire into build phase per chosen shape.
5. *(Future, optional.)* Add `merge` phase between `build` and `verify` if step 4's orchestrator produces aggregate output that needs its own gate.

**Composite with #73 (reds-as-reviewer):** both #73 and #96 are "one agent role doesn't earn its tokens because it's doing too much" — #73's reds were reviewing the underlying subject instead of the work-product (vocabulary mismatch); #96's implementer is one generic agent doing every discipline (specialization mismatch). Same lens: define each agent's role by what *only it* can contribute, then split when the lens reveals one agent is doing two jobs.

**Sequencing:** sub-shifts 1+2 ship tonight as foundation. 3+4+5 are daytime architectural conversations + experimental data + structured decisions. Each sub-shift is testable in isolation and reversible.

**Stretch goal worth flagging:** "skip architect" workflow flag. Some feature work (cheap features, refactors, isolated additions) doesn't need an architect phase. Today the workflow shape is fixed; turning architect off requires a new workflow file. Better: a workflow-level flag `phases.skipIf: <condition>`. Defer; architectural framing only.

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

### #65 — Per-question UX for `openQuestions` at the gate
**Why:** Today `result.openQuestions` is a free-form array the agent emits to disclose every default it picked when the human didn't specify (style, screens, dimensions, etc.). At the gate, the human's only response surface is one rationale textarea — to correct any single default they have to write free-text addressing whichever one(s) were wrong. The agent re-runs and re-generates the whole PROMPT.md from the synthesized rationale. Works in 1-2 rounds in practice but the UX is clunky: no per-question response, no "ok / not ok" per item.
**How to apply:** When the dashboard's awaiting-gate detail renders a task whose result has `openQuestions`, render them as a checklist with three states per question (accept / change / explain) and a small inline text field for the change case. On submit, synthesize the gate rationale automatically from the per-question responses (e.g. "accepted #1, #3; changed #2 to: <text>; left #4 open") and POST to `/api/gate/:taskId` as today. The agent's re-run loop is unchanged — just a friendlier capture surface for the human.
Caught 2026-05-08 during #53 validation. Belongs in #57's iteration backlog alongside #62/#63/#64.




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

### #107 — Reds-during-reconcile: missed-reds-on-orphan-recovery is a design question
**Why:** Split from #91 (item 3) on 2026-05-12. When forge recovers an orphan task whose phase has reds attached, the reds may never have been spawned — the parent forge died before kicking them off. Reconcile today (post-#91) just transitions the task per its gate type and continues, silently skipping the reds. For **specialist reds** (gateOnVerdict: false, informational only) that's mostly fine — the audit is lossy but the workflow continues correctly. For **authoritative reds** (gateOnVerdict: true) that's a real correctness gap: reds were supposed to gate the advance, but their absence is invisible to the human.

**The two real options, both with tradeoffs:**

1. **Spawn missed reds during reconcile.** Reconcile detects the gap (phase declares reds, no red tasks exist for this parent) and dispatches them as part of the recovery. Pros: workflow behaves as if forge had never died. Cons: reconcile becomes a dispatcher, not just a state-fixer — bigger surface, more failure modes. Also: the original task's container is gone, so the reds run against the post-hoc artifact rather than the live agent. That's actually fine for most red types (they read result.json), but a category to verify.

2. **Force a human-visible audit gap.** Reconcile transitions the recovered task to `awaiting_gate` (regardless of the phase's actual gate type) and leaves a marker on the task that "reds did not run on recovery — review the diff manually." The human force-advances after eyeballing. Pros: simpler reconcile; the audit gap is surfaced rather than hidden. Cons: harder for the human (no red verdicts to lean on); workflow stalls on every recovery even for benign cases.

**Open design questions to resolve before implementation:**
- Does the answer differ for specialist vs authoritative reds? Probably yes — specialist can be silently skipped (option 2-lite: continue but log), authoritative MUST surface (option 1 or 2).
- How does reconcile detect "reds were declared but not spawned"? Needs to compare `phase.reds` config to the actual red tasks in the DB — a small new query, doable.
- Where does the audit marker live in option 2? A field on the task row? A separate notes table? The dashboard's task detail would need to render it.

**Caught:** 2026-05-12 — separated from #91 so the simpler gate-honoring fix can ship without waiting on this conversation.

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

### #67 — Per-app design corpus: encourage / enforce shared designDir within an app
**Why:** Today every `ui-design` run gets its own `--design-dir`. Each .pen file is a fresh document with no link to prior designs of the same app. If you design the forge dashboard at `~/code/forge-design/dashboard.pen`, then later add a widget to that dashboard, the widget design lives in a new .pen with no automatic access to the variable block or named components from the dashboard's .pen. Pencil 0.2.5 has no cross-file component import — components live inside their .pen file. Result: visual drift, redundant token redefinition, and the human has to keep "the dashboard's house style" in their head when running each new ui-design.
**Caught 2026-05-08:** running ui-design for a forge dashboard widget against a fresh `--design-dir ~/code/forge-stats-widget/`. Steven flagged that this should have been added to `~/code/forge-design/` so it could reuse the existing component library + variable block. The prompt-author had no way to know.
**Three shapes to consider (decide before implementing):**
1. **Convention only.** Document that ui-design runs for the same app share a designDir. Update prompt-author seed to ask "is this an addition to an existing design corpus? if so, point me at it." Cheapest, no code change.
2. **`forge new --inherit-from <other-design-dir>`.** New flag. The prompt-author template gets a step at the top: "open the inherit-from .pen first, copy variable block + named components into the new .pen, then proceed." Pencil supports this manually; agent automates the copy. Risky — node-copying across .pen files isn't a tested path in Pencil 0.2.5.
3. **Reuse the same designDir; .pen grows monotonically.** No flag needed. The existing prompt-author already supports an existing .pen (touch + open_document is idempotent; new screens go in empty canvas space via `find_empty_space_on_canvas`). Just teach the human (and the prompt-author seed) that the right move is `--design-dir` pointed at the existing corpus, not a new dir. Accepts the cost of larger .pen files in exchange for actual reuse.
**Lean toward (3) initially.** It's the cheapest honest answer and exposes whether the monotonic-growth cost is real before we build (1) or (2). (1) becomes the documentation form of (3). (2) only becomes worth building if Pencil ships better cross-file tooling AND we hit a case where one .pen is genuinely too big.
**Open question:** how does forge know when a designDir already has a .pen worth reusing vs an empty/abandoned scratch? Probably: the prompt-author can detect a pre-existing non-zero .pen at the conventional path, surface it in `openQuestions` ("found existing design at <path>; reuse?"), and let the human gate the call.


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


### #42 — Rewrite docs/how-to-new-workflow.md with a workflow we don't already have
**Why:** Current example is `code-review` which duplicates the existing `codebase-assessment` workflow. The doc reads as a paper exercise. Replace with a workflow forge actually doesn't have, ideally one that exercises a primitive we've built but not documented (`onReject` branching, gate=verdict + fanout combo, multi-authority red panels).
**How to apply:** Brainstorm the right new workflow first. Candidates: a workflow that uses `onReject` (also closes #25 validation); a workflow with both authoritative and specialist reds across phases; a workflow that genuinely needs a new role (forces also exercising `how-to-new-agent.md`).

## Done (recent)

### #127 — System Map: red→parent arrows render as dotted tether
**Closed:** 2026-05-13. Shipped via forge feature run on `red-arrow-127` branch (the first forge run that exercised #128 end-to-end). Commit `ec6a519`.

**What landed:** `src/dashboard/html.ts` red-edge style — `line-style: 'dotted'`, `target-arrow-shape: 'none'`, `opacity: 0.4` (was 0.7). Width unchanged at 1.

**Option from the original entry:** option 6 (dotted thin line, no arrowhead, low-opacity magenta tether). Reads as "associated, not flow into" — matches reds-as-side-channel-audit, drops the misleading downstream-consumer connotation.

**Notes on the forge run that produced this:** the architect caught two real gotchas the brief didn't flag — the base edge selector's `target-arrow-shape: 'triangle'` is inherited unless explicitly overridden, and Cytoscape distinguishes `dotted` from `dashed`. Implementer made exactly those three style changes plus the override. First verify-phase run skipped browser-tools (reasoned "small CSS = code, not UI"); second run after the seed tightened invoked browser-tools 22 times and produced a real screenshot — validates both the change and #128 end-to-end. See the #128 Done entry for the seed-copy iteration.

**Co-shipped:** #121 (env-snapshot bedrock auth) commit `8e7306c`. The original run was blocked by stale STS cache under mount-mode auth — fixed by implementing Jeff & Terry's env-snapshot pattern. Originally filed as deferred-to-v2 in the BACKLOG; landed here because it was the actual blocker on this run.

### #121 — Bedrock auth: env-snapshot via aws configure export-credentials
**Closed:** 2026-05-13. Commit `8e7306c`.

**What landed:**
- `src/util/creds.ts` — new `exportAwsCreds(profile)` calls `aws configure export-credentials --profile <p> --format env-no-export` on the host and returns the parsed STS env vars. `FORGE_AWS_CREDS_FOR_TEST` escape hatch for unit tests.
- `src/spine/spawn.ts` — bedrock branch now defaults to env-snapshot: pass `CLAUDE_CODE_USE_BEDROCK=1` + `AWS_REGION` + STS env vars; drop the `~/.aws` mount + `AWS_PROFILE`. `FORGE_AUTH_MODE=mount` reverts to legacy mount-mode as escape hatch.
- Tests updated to assert env-snapshot is default, mount-mode falls back when toggled.

**Why this landed earlier than the BACKLOG planned (v2/#116):** during the first #128 validation run on 2026-05-13, the bedrock-mode container hit `ExpiredToken` even with a freshly-derived STS cache visible inside the container (mtime current, expiry 8h out, file readable). Host-side `aws sts get-caller-identity` succeeded against the same on-disk state at the same instant. Empirically proved the failure-shape #121 described: the container's AWS SDK derivation chain doesn't reproduce the host's. Implementing the env-snapshot path unblocked the run.

**Decision locked:** env-snapshot becomes the default. Mount mode is opt-in via `FORGE_AUTH_MODE=mount` for genuinely long-running containers (>1h, where the 1-hour STS TTL would expire mid-run). FORGE-DEC-013 is overturned in practice; its rationale (STS expiry mid-run) is mitigated by Jeff & Terry's pattern in their 8+ production projects and by the fact that forge tasks typically finish in minutes, not hours.

**Validation:** 355/355 tests pass. The second-attempt #127 forge run completed all phases (architect → plan → build → 5 reds → verify) using env-snapshot auth without further auth incidents. (One red, red-security, starved on what looked like Bedrock concurrent-request limits — separate concern, not auth.)

**Composite:** #117, #118, #119, #120 — these tactical mount-mode diagnostics remain useful only while mount mode exists. Under env-snapshot default, the failure modes they address (watchdog wrong profile, no log, manual `aws sso login` leaves STS stale, shallow auth status) become moot for the common path. Worth revisiting whether they're still worth fixing post-#121.

### #128 — Forge agent containers: bake Chrome, mount browser-tools skill, retire Playwright MCP
**Closed:** 2026-05-13. All five steps shipped + Playwright MCP fully torn down. Container side now uses pi-skills/browser-tools same as host side (#126).

**What landed (forge repo):**
- `docker/agent-dev-worker.Dockerfile` — replaced Playwright Chromium with Chromium-for-Testing via `npx @puppeteer/browsers install chrome@stable`. Added Chromium system deps (`libnss3`, `libgbm1`, etc.). `chmod` and ENTRYPOINT lines for the new entrypoint script. Pre-creates `/home/agent/.claude/skills/` for the bind mount.
- `docker/agent-entrypoint.sh` (new) — starts headless Chromium on `127.0.0.1:9222` in the background, then `exec`s the agent command. `--headless=new --no-sandbox --disable-dev-shm-usage`. `FORGE_NO_BROWSER=1` skips Chrome startup (test escape hatch).
- `docker/build.sh` — pinned image to `--platform linux/amd64`. Chrome doesn't ship Linux/arm64; image runs under Rosetta on Apple Silicon. Trade-off accepted: avoids dragging Playwright back in just for its arm64 bundle.
- `docker/.dockerignore` — allow `agent-entrypoint.sh` into build context.
- `src/spine/spawn.ts` — added `browserToolsDir` to `DockerArgsInput`, `resolveBrowserToolsDir()` resolver (env override via `FORGE_BROWSER_TOOLS_DIR`, default `~/pi-skills/browser-tools`, returns `undefined` when the source doesn't exist). Mount is `-v <dir>:/home/agent/.claude/skills/browser-tools:ro`. Mount is RO regardless of `readOnlyProject` — same invariant as `/design`.
- `src/spine/spawn.test.ts` — 5 new tests covering mount-absent, mount-present, RO-for-blue-agents, resolver-with-bad-path, resolver-with-good-path.
- `seeds/agents/verifier/CLAUDE.md` — new "Visual verification (UI changes)" section telling the verifier to use `browser-tools` when the plan touches UI. Cites the #105 lesson (tests-green ≠ render-correct) directly.

**What did NOT need touching:**
- `red-frontend` seed — reds declare `tools: ["read"]` only. Invoking browser-tools needs bash. Right role boundary: verifier opens the page; reds audit the artifact the implementer produced. Considered, rejected.
- `frontend-implementer` / `red-wide` / `red-narrow` — builder roles or read-only reds, neither needs the render-check invariant.

**Step 5 teardown (host-side, separate from forge repo):**
- Stopped + removed launchd service `com.sgws.playwright-mcp` (plist renamed to `.bak-before-128` in `~/Library/LaunchAgents/`).
- Removed Playwright from 5 project scopes in `~/.claude.json` (forge, forge-design, three OneDrive/obsidian projects). Backup at `~/.claude.json.bak-before-128`.
- Removed `playwright: ref: ""` stub from `~/.docker/mcp/registry.yaml`. Backup at `~/.docker/mcp/registry.yaml.bak-before-128`.
- Memory `reference_playwright_mcp_launchd.md` rewritten as "RETIRED 2026-05-13" with full restore instructions in case revival is ever needed.

**Validation:**
- 354/354 tests pass (5 new for #128).
- Live container test: `docker run` with skill bind mount, watched Chromium start in ~1.5s under Rosetta, ran `browser-screenshot.js` inside container, `docker cp`'d the PNG out, verified it's a valid screenshot (about:blank, 1906 bytes).
- The "still connecting" notice on this session's playwright MCP confirmed teardown took effect; future sessions will not see the playwright tools at all.

**Image size impact:** ~280MB for Chromium-for-Testing + system libs, roughly comparable to the Playwright Chromium that came out. Net wash.

**Open follow-up (lower priority, low scope):**
- **Upstream PR to pi-skills.** `browser-start.js` is Mac-hardcoded; a Linux-aware version (detect Chrome binary from env or PATH) would close the gap. Composes with #129.

**Composite with #116 (forge v2):** v2's runtime YAML inherits a working browser-tools surface to declare per-runtime. The `resolveBrowserToolsDir` + `browserToolsDir` mount pattern is a candidate for "declare this in the runtime YAML, runner translates to docker args."

**Caught:** 2026-05-13 (spun out of #126). **Closed:** 2026-05-13.

### #126 — Replace Playwright MCP with pi-skills browser-tools (host side)
**Closed:** 2026-05-13. **No forge code change** — pure host-side install. Pair-coding surface migrated; forge container side spun out to #128.

**What landed (host side only):**
- Cloned `badlogic/pi-skills` (MIT, https://github.com/badlogic/pi-skills) to `~/pi-skills`.
- `npm install` inside `~/pi-skills/browser-tools/` (puppeteer-core + helpers).
- Symlinked `~/pi-skills/browser-tools` → `~/.claude/skills/browser-tools`.
- Verified end-to-end on the running forge dashboard: `browser-start.js` → `browser-nav.js http://localhost:8022/` → `browser-screenshot.js` → Read returned path. ~3 seconds. No MCP, no transport, no wedge.

**Validations along the way:**
- Skills discovery works in headless `claude --print` mode — the mode forge uses (init message includes `skills:[...]`; bodies load only on invocation). `--add-dir` does NOT install skills; well-known paths only.
- Validated inside `agent-dev-worker:latest` container with the exact docker invocation pattern forge uses today; bedrock auth; skill mounted read-only at `/home/agent/.claude/skills/<name>` discovered and fired correctly. (This is the proof point #128 builds on.)
- Mario's evolution traced: `badlogic/browser-tools` → `badlogic/agent-tools` → **`badlogic/pi-skills`** (current). He migrated from PATH-alias + README to the Anthropic Skills format because it's cross-agent (Claude Code, Codex CLI, Amp, Droid all consume `SKILL.md`).
- Token cost win measured: Playwright MCP = 13.7k tokens per spawn; Chrome DevTools MCP = 18k; Skills format = ~225 tokens (description in init, body loaded only on invoke). Two orders of magnitude.

**Memory updates:**
- New: `reference_pi_skills_browser_tools.md` — install state + pattern shape + iteration loop.
- Updated: `reference_playwright_mcp_launchd.md` — flagged "still live, slated for teardown by #126/#128."

**Spun out:**
- **#128** — container-side migration (bake Linux Chrome, entrypoint, `spawn.ts` mount, seed updates, Playwright MCP teardown). Architecture locked here; that's the build.
- **#129** — shareable pattern future feature ("use Mario's tools from this repo, with a small install dance"); placeholder for when a second consumer appears.

**Caught:** 2026-05-13 during Playwright MCP wedge mid-#105 renderer iteration.

### #105 — System Map view (replaces old graph view)
**Closed:** 2026-05-13. Shipped via the System Map run forge ran on itself + a manual renderer-fix pass against the design frames after red review caught gaps. Commit `5a44588` on `system-map-105`; merged to main as `6a1b6aa`.

**What landed:**
- `src/dashboard/systemMap.ts` — pure `buildTaskGraph(tasks, phaseShape)` emitting nodes with `_fanoutTotal` / `_fanoutComplete` for in-node progress bars, plus three arrow kinds (linear, retry, red). `computeElkLayers` assigns ELK layer hints.
- `src/dashboard/systemMap.test.ts` — 15 unit tests.
- `src/dashboard/html.ts` — modal shell with header/canvas/footer, ELK layout via cytoscape-elk@2.3.0, reds hand-placed vertically in their parent's column post-layout, HTML labels via cytoscape-node-html-label@1.2.1 (auto-registers on cytoscape's core extension API, not a window global), drag-stable per-run via module-level `Map<runId, Map<taskId, {x,y}>>`, filter chips (All / Running / Failed / Pending / Reds), retry arrows arc below the row via bezier control points.
- Old graph view deleted: `graphView.ts`, `graphView.test.ts`, the `buildGraphDataClient` mirror, `openGraphView` / `relayoutGraph` / `expandFanoutPhase` / `collapseFanoutPhase` from CLIENT_JS, the dagre + cytoscape-dagre CDN tags, and the old `.graph-modal-*` CSS.
- `SYSTEM_MAP_STATUS_COLORS` extends the old map with `complete` (was `done` — wrong key, made every complete task render as gray) and adds icon glyphs per TaskStatus.

**Renderer fixes after the agent build phase shipped (red review found these, hand-iterated against design):**
- `_fanoutTotal` / `_fanoutComplete` referenced but never populated by the data layer.
- cytoscape-elk URL was `@1.4.0` (404 — that version doesn't exist on unpkg).
- `done` status key didn't match TaskStatus `complete`.
- nodeHtmlLabel detection used a non-existent `window.cytoscapeNodeHtmlLabel` global.
- ELK partitioning collided reds with downstream phases; switched to ELK-on-main-flow + hand-placement-for-reds.

**Closes:** #102 minimap, #101 side panel (not in the new designs).
**Follow-ups filed:** #115 (smart-refresh task-state gap, hit during this run), #123 (a11y posture), #124 (drag-overrides Map LRU), #125 (implementer seeds + forge-test), #126 (replace Playwright MCP with shell CDP — hit Playwright wedge during renderer iteration), #127 (red→parent arrow semantics — magenta arrow reads as flow when it should read as side-channel).

### #98 — Fanout-collapsed node polish (progress bar + tags) — superseded by System Map
**Closed:** 2026-05-13. The System Map (#105) has no collapsed-vs-expanded mode — every task renders as a peer node always. The "fanout-collapsed-node atom" concept was a v0 graph-view artifact; the new view's running-fanout progress bar is wired through `_fanoutTotal` / `_fanoutComplete` on individual running tasks. Anything left here is genuinely obsolete.

### #114 — Mount designDir read-only at /design inside agent containers
**Closed:** 2026-05-12. Caught preparing the System Map (#105) PRD run: the architect agent in `feature-ui-design-needed` / `feature-ui-design-provided` was being told to "read upstream design artifacts" pointing at host paths that the container had no way to reach. `--design-dir` set `run.metadata.designDir` and `inputs.designDir`, both as host paths — but `spawn.ts` only mounted `/project` and `/task`. The seed instruction to "Read them" was a lie; the architect would have bluffed past it. This was the root cause behind shaping the PRD differently — fixed at the spine layer instead.

**What shipped:**
- `SpawnOptions.designDir` (optional, host path). When set, spawn adds `-v <designDir>:/design:ro`. **Always read-only**, even for blue agents whose `/project` is rw — the design corpus is human-curated via Pencil on the host; agents never write into it.
- `dispatch.ts` reads `run.metadata.designDir` via new `designDirFor(run)` helper and passes through to both `spawn()` (blue) and `spawnRed()` (red).
- `spawnRed.ts` propagates `designDir` to `runOneRed` → `spawn()` so reds reviewing design-adjacent artifacts (frontend, UI architecture) can read the same canonical PNGs/HTML the human approved.
- `seeds/agents/architect/CLAUDE.md` — explicit instruction: design corpus is at `/design` inside the container; translate host paths from `inputs.upstream[*].result.{html,png}Files` and `inputs.designDir` to `/design/<relative>` before reading.
- `seeds/agents/prompt-author/CLAUDE.md` — `inputs.designDir` clarified as **host path**: use it for paths *in the PROMPT.md you produce* (human-on-host Pencil runs that), but for in-container reads (e.g. inspecting existing PNGs per #80) use `/design`.
- Three new buildDockerArgs tests covering: no mount when unset, mount with `:ro` when set, mount stays `:ro` even when `readOnlyProject: false`.

**Forward-only.** Existing seeds had been *telling* agents to read host paths; if any actually tried, the failure was silent (file not found, agent improvises around it). Now the seeds give an honest container path. No DB migration; runs created before #114 simply don't get a `/design` mount (their architects never tried to read from it anyway).

**Out of scope:** rewriting `inputs.designDir` itself to be the container path. That would diverge from `run.metadata.designDir` (which submit and dashboard use as host paths) and force a translation layer for prompt-author (which generates PROMPT.md with host paths for human-on-host execution). Two paths to know about is the right shape: one for human-environment context, one for in-container reads.

349/349 tests passing (was 346, +3). Typecheck green.

### #102, #101 — minimap + side panel closed: not in the designs
**Closed:** 2026-05-12 during System Map design review. The new designs (system-map.png, system-map-fanout.png, system-map-reds-detail.png) don't include either a minimap or a side panel. The designer's call is one view, draggable, no secondary surfaces. If real-run density makes a "where am I" affordance necessary later, file fresh — the old `ycyNE` (minimap) and `UTf00` (side panel) components in the .pen library are stale-but-not-deleted.

### #113 — Promote specialist reds to authoritative (gateOnVerdict: true)
**Closed:** 2026-05-12. Specialist `additional[]` reds (red-frontend / red-backend / red-security) now inherit RedConfig.authority + gateOnVerdict like wide/narrow do. A fail blocks the gate via `blocked_by_red`; override is the existing `--force --rationale` path.

**Shape that shipped:** Path A from the planning conversation — minimal, reversible, no schema change.
- `src/spine/spawnRed.ts` — extracted `buildLaunchPlan(redConfig)` as a pure exported function. All reds in a RedConfig (wide / narrow / additional) get the same authority + countsTowardGate: true. Pre-#113, `additional` was hardcoded `specialist` / countsTowardGate: false.
- `src/types/index.ts` — RedConfig.additional doc comment rewritten to reflect new gating semantics.
- `src/workflows/feature.ts`, `feature-ui-design-needed.ts`, `feature-ui-design-provided.ts` — comments updated; no structural change (RedConfig was already `authority: "authoritative"` + `gateOnVerdict: true`).
- `seeds/agents/red-{frontend,backend,security}/CLAUDE.md` — reworded from "specialist red, informational" to "discipline red, fail blocks the gate." Tone matches red-wide/red-narrow.
- `src/spine/spawnRed.test.ts` — new file, 5 unit tests against `buildLaunchPlan` (inheritance for additional[], specialist-authority workflows still propagate specialist, empty/missing wide-narrow cases).
- `src/workflows/specialistSeeds.test.ts` — assertion flipped from "CLAUDE.md says `gateOnVerdict: false`" to "CLAUDE.md self-identifies as discipline red + says fail blocks the gate."

**Forward-only.** Legacy verdicts in the DB still carry `authority: 'specialist'`; the dashboard's #110 specialist-fail-rationale path remains intact for them. New runs write `authority: 'authoritative'` for discipline reds and trip the `blocked_by_red` + force-advance UI instead. The two paths coexist; no migration.

**What's still load-bearing:** the `RedAuthority` type's `specialist` value, `gate.ts`'s `aggregateVerdicts` specialist-fails branch, and the dashboard's `v.authority === 'specialist'` checks all remain — they handle legacy verdicts and leave room for future non-gating reds (e.g. triage). Cleanup of that branch is a Path B future task, not filed yet because it's only worth doing once legacy verdicts have aged out.

**Verification.** 346/346 tests passing (5 new), typecheck green. Real end-to-end verification needs a feature run where a discipline red fires — first occurrence will exercise the `blocked_by_red` + dashboard force-advance flow.

**Tests of note still asserting old behavior:** the four #110 tests in `gate.test.ts` (`gate=human advance with specialist fail requires rationale`, etc.) still pass because they manually insert verdicts with `authority: 'specialist'` — that path is still real for legacy data, just not how new specialists are recorded. Intentional.

### Active-cleanup pass 2026-05-12 — 8 stale entries closed
End-of-session sweep before a Claude upgrade. Each entry is genuinely dead or shipped:

- **#85 — Graph view as a separate screen.** Parent of all the GRAPH: work that followed. #98 / #100 / #101 / #102 / #103 / #105 all came out of this. The original parent is dead; its children carry the work.
- **#53 — prompt-author agent seed + ui-design template.** Shipped. `seeds/agents/prompt-author/CLAUDE.md` + `seeds/agents/prompt-author/templates/` exist. Validated empirically (note in the original entry confirmed this on 2026-05-07).
- **#45 — `forge auth status` warns on stale bedrock vars.** Functionally shipped by #97 — the dashboard auth-mode popover renders the bedrock token's expiry timestamp + remaining time + amber/red health dot when stale. The original framing (a CLI flag) was made redundant by the always-on indicator.
- **#39 — Audit the spawn → DB pipeline for missing fields.** Meta-task from 2026-05-08 that said "run an audit someday after #32/#38/#27 land." Never materialized into action. If a specific missing field comes up, file that directly; "do an audit" was perpetually-deferrable.
- **#49 — Design-reviewer red agent (future investigation).** Predicated on FORGE-DEC-014-killed assumptions about the in-container designer. Re-evaluate when host-led-Pencil generates evidence worth catching.
- **#50 — React Native code export from Pencil .pen files.** Dependent on the container-designer (#46) that FORGE-DEC-014 killed. Dead-parent → dead-child.
- **#51 + #51b — design-reviewer agent: visual diff implemented UI vs design artifact.** Same FORGE-DEC-014 problem: the artifact pair (`pngFiles` + `htmlFiles`) the agent was supposed to consume comes from the killed `#46` container-designer flow. Worth revisiting once the host-led-Pencil + prompt-author flow has produced a few real design corpora that could feed a different reviewer shape.
- **#52 — Browser DevTools error capture.** Tied to #51's Puppeteer-Core CLI scripts. Same FORGE-DEC-014 dependency. If a forge workflow ever needs "did the page render without errors" as a check, file fresh.

Active dropped from 36 → 28.

### #104 — GRAPH: Rejects + retries design session — superseded by #105
**Closed:** 2026-05-12. Resolved-by-decision rather than work: the rule for the graph view is "render the real workflow — every task, every relationship." That eliminates the design-session framing — there's no separate set of decisions to make. Scope absorbed into #105.

### #99 — GRAPH: retry chains — superseded by #105
**Closed:** 2026-05-12. Was a narrow placeholder ("draw retry edges between failed-and-retried tasks"). The broader rewrite in #105 covers retry chains of any length + reds + every other task relationship, so this entry is no longer the right shape.

### #25 — Validate onReject rationale-propagation end-to-end
**Closed:** 2026-05-12. Legacy entry from 2026-05-07. The original onReject implementation (#25 in archive — `d075f9f`) shipped years ago; this validation follow-up never got prioritized and the world has moved on. Three reasons to close rather than carry:
1. ui-design's review-phase reject path has been exercised in real runs since 2026-05-08 (the `#54`-era prompt-author iterations). If it were broken end-to-end we'd have seen it.
2. The `inputs.rejectedRationale` + `inputs.rejectedTaskId` propagation is unit-tested in `src/spine/gate.test.ts` ("gate reject on a review task triggers onReject and creates a brief task with rejectedRationale").
3. The bigger reject-UX question — letting the human pick WHICH phase to loop back to — is captured by #93, which is the live ticket. #25's validation framing is subsumed there.

### #91 — Reconcile bypasses gate=human on recovery
**Closed:** 2026-05-12 on commit `91f9e17`. **First end-to-end forge feature run that landed real spine code on forge itself.** Architect agent caught two material errors in the original brief (the fix needed to branch on `gate !== "auto"` not `gate === "human"` to also cover `gate: "verdict"`; and needed `markTaskAwaitingGate` not bare `setTaskStatus` to preserve the result payload for human review). Shipped fix:
- `src/spine/reconcile.ts`: orphan blue recovery now branches on phase.gate — `auto` → `markTaskComplete`, otherwise → `markTaskAwaitingGate`. Red-task path unchanged (guarded by `!task.parentId`).
- 3 new tests cover gate=auto, gate=human, gate=verdict paths; 2 pre-existing tests fixed to pin `gate: "auto"` so they actually exercise the auto branch (they were silently relying on the old broken behavior).
**Item 3 (reds-during-reconcile)** split out as #107 — separate design question.

### #100 — GRAPH: fanout layout broken
**Closed:** 2026-05-11 on branch `graph-view-85` → merged to main as part of `ed7e8c5`. Three failure modes from the original capture (overlap, gap, edge-cut) resolved by shipping Hypothesis C — flat-node model, no cytoscape compound parents. Children of an expanded fanout phase are top-level peer nodes; dagre handles parallel ranks natively. Plus curved edges (`unbundled-bezier`) so the graph reads as flow not org-chart, plus failed children rendered as dead-ends (no outgoing edge to next phase) matching real workflow semantics. Original WIP (compound nodes + grid sub-layout) is gone.

### #97 — Auth-mode indicator in the dashboard chrome
**Closed:** 2026-05-11/12 across `0c58d65`, `5d4580e`, `d92c32f`, `81e0193`, `0748752`, `73b0bb8`, `2c1e6b4`, `487da9f`, `c39643c`. Shipped:
- Read-only indicator under the FORGE wordmark in the sidebar. Single line of geist-mono: `● {mode} · {identity}` with the dot color-coded by health (green/amber/red).
- Click opens a popover with mode-specific detail. Bedrock shows profile, account, role, region, SSO portal, token expiry + remaining time, watchdog status. OAuth shows account email, organization, plan tier, login date (sourced from a host-side hint cache populated by `forge auth login`). Apikey is intentionally bare — leaking key prefixes/suffixes was a security concern.
- Polled every 60s; SSO-expires-mid-session auto-surfaces without a dashboard restart.
- AWS_PROFILE env var alone now triggers bedrock auto-detect (no need to set CLAUDE_CODE_USE_BEDROCK=1). Migrated the OAuth volume mount from `/home/agent/.claude` to `/home/agent` so `.claude.json` (account info) is captured alongside `.credentials.json` (token); volume name bumped to `forge-claude-oauth-v2`.
- Async-loaded Google Fonts via media-swap so a blocked `fonts.googleapis.com` (corp proxies) doesn't freeze paint.

### #79 — Auto-detect bedrock + pre-flight check
**Closed:** 2026-05-11/12 across `f3d2d76`, `8f1c464`, `7ab5231`. Shipped:
- `detectCredsMode()` auto-detects bedrock when AWS_PROFILE is set or when `~/.aws/config` has SSO configured for the active profile. `CLAUDE_CODE_USE_BEDROCK=0` is the hard-off override.
- Pre-flight validation at both `forge new` and `forge next` — bedrock SSO cache freshness check, apikey env-var presence check. Dashboard's POST routes auth errors via `AUTH_ERROR_PREFIX` to a 400 toast, not a generic 500.
- New helpers: `resolveAwsProfile()` (defaults to "default"), `resolveAwsRegion()` (defaults to us-east-1), `hasAwsSsoConfigured()`, `hasFreshSsoCache()`, `hasAnyAwsSsoProfile()`.
- 19+ new tests in `creds.test.ts` covering every detector branch.

### #109 — Transactional reconcile writes
**Closed:** 2026-05-12 on branch `transactional-writes-109` → merged to main. Test suite 341/341 (+3 reconcile tests). Scoped to reconcile only; dispatch + gate split out to #112.
- `src/spine/reconcile.ts`: per-task write batch wrapped in `getDb().transaction(...)`. Rollback on throw leaves the task in `running`; the next reconcile call re-attempts cleanly. Catch logs to stderr (not the DB — the failure may itself be a DB write failure).
- Added a test-only `_setReconcileFaultForTest(step, error)` hook + named fault points (`after-mark-blue`, `after-log-completed`, `after-insert-verdict`, `after-log-verdict`). Lets fault-injection tests verify rollback without monkey-patching the store module.
- 3 new tests: rollback on mid-sequence fault (after mark-blue) + rollback of both writes (verdict insert + parent transition) + retry-pin (subsequent reconcile succeeds).
**Unblocked by #111** — needed in-container test runs to do fault-injection work end-to-end.

### #103 — GRAPH: top-bar run-status pill
**Closed:** 2026-05-12 on branch `graph-status-pill-103` → merged to main. Suite at 338/338 (no test deltas — single-span chrome addition).
- `src/dashboard/html.ts`: graph-modal-header gains a `.badge.status-<run.status>` span between the title and the close button. Reuses `rowDisplayStatus()` so `active` renders as "running" consistent with the sidebar run-row badge. Migrated `margin-left:auto` from `.graph-modal-close` to the new badge so both stay flush-right.
**Live-verified** in the dashboard against a complete run; green-dot "complete" badge renders cleanly.

### #110 — Require rationale when advancing over a failed specialist red
**Closed:** 2026-05-12 on branch `rationale-on-red-fail-110` → merged to main. Test suite 338/338 (+5 gate tests). Two-layer fix:
- **Spine (`src/spine/gate.ts`):** specialist-fail-rationale check now applies to ANY gate type, not just verdict-gated phases. Previously a `gate: "human"` task with a failed specialist red could be advanced with no rationale at all — zero audit trail of the override. Authoritative-red protection (via the `blocked_by_red` status path) was already correct for all gate types and is unchanged.
- **Dashboard (`src/dashboard/html.ts`):** gateActionsSection computes `advanceRequiresRationale` from the verdict list. When true: specialist red verdict cards are surfaced (same `redVerdictCard` used for `blocked_by_red`); helper text + textarea placeholder shift to "required to advance over the specialist red(s) above"; the Advance button becomes `⚠ Advance over red(s)` in btn-warning styling and passes `requireRationale: true`, triggering doGate's existing client-side toast on empty submission.
- 5 new gate tests cover both gate types (human, verdict), happy/empty/forced paths.
**Live-verified** by flipping `task-build-aa57f1` (the #91 build with a real red-backend specialist fail at 0.85) back to `awaiting_gate`, opening the dashboard, confirming the rendering + the empty-rationale toast + the non-empty-rationale path.

### #108 — Dashboard: gate-advance auto-dispatches the next phase
**Closed:** 2026-05-12 on branch `auto-dispatch-108` → merged to main. Test suite at 333/333 (+5 server tests). Shipped:
- `src/dashboard/server.ts`: `handleGate` chains into `forge next` after a successful `advance`. Skips the chain on reject/request-changes and on already-complete runs. Auth errors from the chained dispatch route to 400; other dispatch errors to 500 with a clear "Advanced X but dispatch failed" prefix. Response gains optional `dispatched: true` + `dispatchSummary` so the dashboard toast can confirm both halves happened.
- `src/dashboard/server.test.ts`: 5 new tests covering happy chain, reject doesn't chain, complete-run doesn't chain, dispatch failure → 500, dispatch auth error → 400.
- CLI behavior unchanged (`forge gate` still prints "Next: forge next ..." and exits). The chain is dashboard-only convenience, preserving CLI composability.

### #111 — Verify phase blocked by native-module mismatch
**Closed:** 2026-05-12 on branch `verify-container-111` → merged to main as `da06410`. Test suite 328/328 passes inside the agent container, matching host. Shipped:
- `docker/forge-test.sh`: wrapper that copies `/project` to `/tmp/forge-work`, rebuilds `better-sqlite3` for the container platform, runs tests there. ~30s overhead per container; host's `/project` is never mutated (works under `:ro` mount too — reds can now run tests).
- `docker/agent-dev-worker.Dockerfile`: bakes the wrapper at `/usr/local/bin/forge-test`. `build-essential` + `python3` were already present so no other prereqs needed.
- `docker/.dockerignore`: allows `forge-test.sh` into the build context.
- `seeds/agents/verifier/CLAUDE.md`: documents `forge-test` usage and the platform-mismatch rationale, replacing the previous "agent figures out testing" looseness that produced #91's diagnostic-only verify behavior.
**Approach taken:** option 1 from the original entry (rebuild in container) — chosen over per-platform `node_modules` volumes (option 2) or swapping the SQLite binding (option 3). Cost: ~30s per container, acceptable.
**Unblocks:** #109 (transactional reconcile + fault-injection tests).

### #95 — Copy-id button next to run name in run-detail header
**Closed:** 2026-05-09 overnight, on branch `graph-view-85` (251 tests, no test deltas — pure UI).
- `src/dashboard/html.ts`: middle-pane run-detail header now renders `<run-id> [copy] [status-badge]`. Reuses the existing `copy` class + `copyText` helper. Mirrors the task-id copy pattern in `taskHeaderSection` (#78).
- Sidebar rows kept tooltip-only — too cramped for an inline button.

### #92 — Architect seed rewrite (systems-architect, not implementation-tutor)
**Closed:** 2026-05-09 morning, on branch `graph-view-85` (233 tests passing — seed-only change, no test deltas).
- `seeds/agents/architect/CLAUDE.md` rewritten. Role reframed to "surface what makes a feature hard/slow/expensive/impossible; decide where logic lives, who owns what state, what's authoritative for what." Explicit anti-pattern list: don't pick type names, function names, file paths, or "do X this way when both are valid." Worked example contrasting bad output (the actual line-level outputs from task-architect-c29474) against good output (boundary-risk + scaling + workflow-as-source-of-truth + prior-art references).
- New output schema: `{risks, constraints, boundaries, priorArt, openQuestions, notes}`. Empty arrays explicitly OK — "five real entries beat fifteen padded ones." Each entry should cite real evidence (file paths, real risks).
- Test for the architect's output earning its tokens: does any entry reference something the implementer wouldn't naturally see from inside the code? If not, the run was waste.
- Three workflow files updated to point at the new schema: `feature.ts`, `feature-ui-design-needed.ts`, `feature-ui-design-provided.ts`. Each `workflowAdditions` string mentions the new field set + reminds the agent that this is NOT implementation guidance.
- Dashboard `workflowSchema.ts` brief-field help copy updated.
- Reinstalled via `FORCE=1 install-seeds.sh`.
- Composite with #73 (reds-as-reviewer): same shape of category mistake — wrong job description. #73 still open as an architectural call.

### #83 — PROMPT.md template: count existing PNGs, use max+1 as starting number
**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (231 tests passing — seed-only change, no test deltas).
- `seeds/agents/prompt-author/templates/ui-design.md`: new PRECONDITION 2 step counts existing PNGs in `{{output_dir}}` (using `ls *.png | wc -l`), sets `START_NUM` accordingly. Step 6 (PNG NAMING) updated to use `$(printf "%02d" $START_NUM)` etc. instead of hardcoded 01/02. Empty/non-existent directory → `START_NUM=1` → numbering starts at `01-` as before.
- `{{file_naming_list}}` is now a list of suggested screen names, not a list of literal filenames — the prefix is computed at run time from the corpus state.
- Reinstalled via `FORCE=1 scripts/install-seeds.sh`. Active in `~/.forge/agents/prompt-author/templates/`.
- Unblocks shared-corpus reuse (#67) where prior runs already produced PNGs 01-N. Without this, the template hardcoded 01 and would clobber.
- Long-term fix (#80) still pending — prompt-author should mount designDir read-only and bake the start number into PROMPT.md at author time. Different code path; this template-level fix ships value now.

### #75 — Dashboard: markdown rendering for prose result fields
**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (231 tests passing — pure UI, no test deltas).
- New `looksLikeMarkdown(s)` heuristic in html.ts: triggers on at least one structural marker — heading line (`^#{1,6}\s`), triple-backtick fence (`^```), or two-or-more list-marker lines. Inline markers (bold, links) alone don't trigger; ordinary prose with one **bold** word stays plain.
- New `renderMarkdown(src)` walks lines and emits structured DOM: fenced code blocks (`<pre><code>`), headings (h3-h6 to avoid clashing with `.result-field-label` h3 above), ordered + unordered lists, paragraphs that gather consecutive non-structural lines.
- New `renderInline(s)` handles inline: HTML-escape input, then `**bold**`, `*em*`, `` `code` ``, `[text](url)` for http(s) + relative anchors. javascript: links explicitly rejected — anchor href regex requires `https?://` or `#` start. XSS-safe: input is escapeHtml'd before any markdown patterns are applied.
- Wired into `renderResultValue` — string values that pass the markdown heuristic go through `renderMarkdown`; everything else falls through to the existing paragraph treatment. Paths still get the `<code>` path treatment first (no regression).
- Backticks throughout (in regex source + comments) escaped via `\\u0060` because the entire CLIENT_JS lives inside a TS template literal where raw backticks would close the literal early.
- Pretty/raw toggle (#34) unchanged — raw mode keeps showing the source markdown.

### #64 — Sidebar widened to 320px + tooltips on truncated run ids
**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (231 tests passing — pure UI, no test deltas).
- `#app` `grid-template-columns` bumped from `280px 360px 1fr` to `320px 360px 1fr`. Common kebab-cased run ids (`run-test-prompt-author-v3-da7d57`, ~32 chars) stop truncating in the sidebar.
- Sidebar runRow now carries `title="<full id> — <title>"`, hoverable for the full id even when wider names truncate.
- Run-pane breadcrumb shortId span carries `title="<full id>"` for the same reason.
- Draggable resizers (option a from BACKLOG #64) deferred — option b shipped as a 10-line fallback.

### #62 + #63 — Human-led gate copy fork + fresh-session warning
**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (231 tests passing — pure UI, no test deltas).
- **#62 (gate copy fork):** `gateActionsSection` reads `phaseShape` to detect human-led phases (`isManual: true`). Three button-shape branches now: blocked-by-red (existing), human-led (new), agent-led (existing). Human-led branch shows two buttons — "✓ I've done the work" + "✕ I've decided not to do this" — and skips the request-changes middle option (which gate.ts rejects on manual phases anyway because there's no agent to re-dispatch). Rationale label changes to "Notes — optional on confirm, required on send-back / stop." Same primitive, different verbs.
- **#63 (fresh-session warning):** awaiting_gate brief tasks now render a yellow warn alert above the rationale: "⚡ Run the PROMPT.md in a fresh Claude Code session before approving. Don't paste into a session already mid-task — long structured prompts can silently drop trailing sections when the running session compacts mid-run." Caught 2026-05-08 during FOLLOWUP-PROMPT.md run.
- Detail render-key already includes the slim phaseShape signal from #71, so this picks up phaseFilter changes naturally.
- New `findPhaseShape(phaseName)` helper looks up the phase in `state.runDetail.phaseShape` (also useful to future copy/icon variants).

### #76 — Elapsed-time cells tick once per second (smart-refresh side-effect)
**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (231 tests passing — pure UI, no test deltas).
- `src/dashboard/html.ts`: new `liveDurationSpan(extraClass, startIso, endIso)` helper that emits a `<span>` carrying `data-elapsed-started-at` + (when set) `data-elapsed-completed-at` attributes. New `tickElapsedCells` walks `[data-elapsed-started-at]` once per second and rewrites `textContent` only when `completedAt` is missing — no DOM identity churn, no scroll/focus/input disruption, smart-refresh keys (#72) untouched.
- New `startElapsedTicker` kicks off a single `setInterval(tickElapsedCells, 1000)` from `bootstrap`. Idempotent — second call is a no-op.
- Three call sites converted: run-pane DURATION (run-meta-strip), task-row trailing elapsed cell (row-side), and the task-detail ELAPSED row in `taskHeaderSection`. All three update live without polling.
- Pattern is reusable for any future once-per-second cell (countdowns, freshness indicators).

### #94 — Retry button suppressed on tasks failed via gate-reject
**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (231 tests passing, +3 new).
- `src/dashboard/queries.ts`: `getTaskDetail` returns a derived `failureMode: 'rejected' | 'crashed_or_agent_error' | undefined` field. Rejected = task is failed AND has at least one gate row with `decision='reject'`. `crashed_or_agent_error` covers everything else (container crash, agent error, validation failure, watchdog kill). undefined for non-failed tasks.
- `src/dashboard/html.ts`: failed-task rendering branches on `failureMode === 'rejected'`. The retry section is suppressed on rejected. Banner copy clarifies — "Task was rejected at the gate. Retry would re-run the same agent..." vs the original crash banner.
- Detail render-key (#72) includes `failureMode` so the retry section flips correctly when a gate-reject lands.
- 3 new queries.test cases: rejected, crashed, undefined-on-non-failed.

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

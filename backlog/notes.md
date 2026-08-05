**Last session ended 2026-08-05.**

**Where we left off:** Shipped FG-678 (the writable-dispatch dependency contract) end to end — pipeline → wedged build → branch-out → evidence-led review → merge `39380bb1`. The review found the DEFAULT pipeline lane still exempt from the new rule; the operator ruled that in scope and one batch fix collapsed all three dispatch lanes into the shared resolver. Merged with two shipping checks recorded as explicit OVERRIDES. Filed four tickets from defects this session hit directly, then set the next priority order.

**Picked up next** (operator sequencing, 2026-08-05; `backlog/PLAN.md` was rewritten to match):

0. **`git pull` in `~/code/forge` FIRST — not optional.** The live checkout is 1 commit BEHIND `origin/main` and forge runs from this npm-linked source, so **FG-678 is merged but not live on this host** until you pull. Also commit the PLAN.md rewrite sitting uncommitted there.
1. **FG-680 — small safety prerequisite.** `test:integration` under `forge launch run` kills its own tmux server: `src/test-setup.ts` sets `TMUX_TMPDIR` but never unsets `TMUX`, so inside a launch pane the exit-time `kill-server` resolves the operator's default socket. FG-614's isolation holds in a plain shell and is defeated in exactly the environment Forge mandates. **Until it lands, do not run `npm run test:integration` under `forge launch run`.**
2. **FG-676 — phantom blocker.** Every `request-changes` leaves a permanent `awaiting_gate` phantom and the run can never complete; two independent reproductions now. Fix is the compare-and-set writer that already exists (`markTaskHeldForGate`, FG-523). **Read FG-681 first** — its five host-failing tests may be green in CI *because of* this resurrection, so fixing FG-676 could turn them red.
3. **FG-679 — the next substantive FEATURE.** Dashboard visibility for in-flight host verification and exact-SHA PR checks. Both data sources already exist and are durable, so it is a projection gap rather than instrumentation.
4. **FG-610 — resume the operator-queue sequence** (FG-496 Slice E). Unblocked: it was held behind FG-678 because its concurrency guarantees need host stress-loops on the writable dispatch path, which is now deterministic.

**External state to remember:**

- **ntfy is still down** — 5th consecutive session. `forge notify milestone` fails `network: fetch failed`; milestones record in the DB, nothing pushes.
- **The live checkout carries uncommitted work, and not all of it is this session's.** `backlog/notes.md` and `backlog/PLAN.md` (mine, this session) plus untracked `docs/research/competitive/strands-agents-forge-assessment.md` — those are the known set. `docs/research/README.md` (M) and untracked `docs/research/jfrog-boost-addon-experiment-2026-08-04.md` appeared DURING this session and belong to someone else's thread. **Preserve all of it.** Consequence unchanged: dispatch pipelines against a CLONE, never against `~/code/forge`.
- **Two clones exist that are not mine and were not audited:** `~/code/forge-boost-lab` and `~/code/forge-protocoldrift`. Leave them alone. `forge-scratch-workspace` and `forge-site` are DIFFERENT repos with their own remotes; `forge-stable` is a detached-HEAD pin; `forge-plan-lanes` and `forge-reboot-handoff-*.md` are not git repos.
- **`~/code/forge-fg678` is GONE** — deleted this session after verifying by CONTENT (`git diff origin/main HEAD` empty, no stashes, clean tree) that it held nothing unique. Its five attached worktrees were detached first, so nothing orphaned under `~/.forge/worktrees`. ~139 MB reclaimed.
- **The FG-678 pipeline run is settled as `abandoned`, deliberately.** Its build parent failed `integration_failed` and its plan phase carried the FG-676 phantom; the work shipped via the branch-out path instead. Task rows, events and result artifacts are preserved as audit evidence. Do not try to revive it.
- **`forge ops check` still reports 17 `orphaned_work_may_persist` incidents** — the known FG-549 false-positive class. Not actionable; do not chase them.

**Decisions worth not relitigating:**

- **The worktree pipeline lane was IN scope for FG-678** (BD-12). BD-3 defines one dependency rule by project STATE, not per dispatch lane; exempting the default `forge new` path would have shipped the original defect through Forge's primary path. The plan had excluded it as "already at parity (FG-376)" — true when written, false the moment BD-3 existed, because FG-376's parity covered MOUNTING, never the refusal.
- **FG-678's `tip_equality` and `docs_closeout` are OVERRIDES, not passes** (BD-13, scoped to that candidate only). Six of eight shipping checks were genuinely green including `acceptance_mapped` and `fix_now_resolved`, both on executed evidence. Do not read FG-678 as a clean 8/8.
- **Branching the integrated work out of the wedged run was correct.** The run could never complete (FG-676), and `retry --force` / `recover --re-drive` would both have re-dispatched a fresh four-child wave and discarded four good child branches — the `gateForced` re-entry path requires `redsAlreadyRan`, and the integration gate fails BEFORE reds dispatch.
- **The mid-review docs commit was the wrong CHANNEL, not the wrong finding.** The coordinator owns candidate movement for any commit during a review — the FG-649 rule generalizes. The docs gap was real; there was simply no supported way to land it, which is now FG-682.
- **FG-681's five host failures are NOT a blocker.** Identical 5/7 on the branch and on `main` via an equivalent runner, CI green at both shas. The host is the unreliable surface, not the change.
- **`forge review start` refusing to auto-confirm the contract is correct behavior.** It will not infer risk lenses from file paths; record `--evaluated-no-drift` (or add a lens with evidence) after actually reading the diff.

**Shipped (for reference):**

- **FG-678** (`39380bb1`, PR #206) — one shared resolver for all three dispatch shapes; three-way discriminator with a pre-container `lockfile_absent` refusal that reaches the read-only reviewer lane too; mount planner re-keyed onto the resolved environment; self-declared `status: failed` now fails the task under the new `agent_reported_failure` kind; dependency identity recorded for every lane. AC evidence grid persisted on the ticket.
- **Filed:** FG-679, FG-680, FG-681, FG-682 (all described above).
- **Updated:** FG-676 with a second independent reproduction and the impact that forced the branch-out.

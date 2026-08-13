**Last session ended 2026-08-12.**

**Where we left off:** FG-663 shipped and closed (`e4188e0c`, PR #240) with a full acceptance-evidence grid — runs now record durable project identity at creation, so deleting a disposable clone no longer orphans history as `Unknown repository`. Ran as a full `feature` pipeline (architect → plan → build → review → verify → docs), all ten CI checks green. The session ended cleanly after close and cleanup. PLAN.md's `Now` was FG-703 → FG-663; both are done, so FG-626 is the head.

**Picked up next:**

1. **FG-626** — head of release-train section 1. Stop `forge launch run` from silently dropping the caller's `FORGE_*` safety and behavior controls.
2. **FG-682 — now motivated by TWO consecutive tickets, not one.** FG-703 hit it; FG-663 hit it again, in a cleaner form: the evidence-led review settles at a candidate, and then the pipeline's own remaining phases (verify, docs) legitimately move the tip past it. There is no amendment path, so the merge was authorized by explicitly stating a 3-commit delta rather than by a review that covered the tip. This is now a recurring structural cost, not a one-off. Still not promoting it unilaterally — PLAN.md is the authority — but the evidence is stronger than when it was filed.
3. **FG-670** — remove the frozen Markdown ticket corpus. Cheap, and `backlog/notes.md` being a live file inside a frozen directory keeps causing confusion (see below).

**Do NOT pick up FG-699, FG-701, FG-702, FG-704, FG-705** — all five remain in PLAN.md's post-v0.1.0 polish section. FG-704 is non-preempting by operator decision.

**External state to remember:**

- **`runs.project_identity` is LIVE on the shared host DB.** Verified after merge: the column and `idx_runs_project_identity` exist on the aged `~/.forge/forge.db`, applied by the additive-column path with no `user_version` bump. All 1788 pre-existing runs have NULL identity by design — they are not backfilled, and the dashboard falls back to the legacy live-path resolution for them. Expect newly-created runs to populate it; a NULL on a NEW run would be a real regression worth chasing.
- **The 131 historical orphans are still orphans and that is intended.** FG-663 is a forward fix. Do not "helpfully" backfill them — the ticket explicitly directs that an honestly-unknown run beats a wrongly-attributed one.
- **The dashboard IS running** — pid 40628, up since Aug 10 10:25. It now predates FG-703 AND FG-663, and `tsx` does not hot-reload, so it is serving stale server code and knows nothing about `project_identity`. Anything you see there about project attribution is the OLD behavior. The operator starts/stops it themselves; do not restart unasked.
- The disposable clone `~/code/forge-fg663` was deleted after merge — verified first that no run had it as `project_dir`, so nothing was orphaned by the deletion. `~/code/forge-fg576` and `~/code/fg584-dogfood` remain deliberately retained for prior evidence.
- **`backlog/notes.md` was uncommitted at session start** and blocked the very first pipeline dispatch (worktree setup requires a clean tracked tree). Committed as `1b40e46e`. Worth knowing: the handoff notes are a live tracked file, so writing them and not committing them wedges the NEXT session's first agent dispatch.

**Mechanics learned this session (each cost real time):**

- **The build gate under `review_mode: evidence_led` REFUSES to advance until a review ledger exists** (`review_absent`). The reds in a feature pipeline are advisory; `forge review start` is not an after-the-fact step you run post-pipeline, it is what settles the build gate. Open it at the build gate, not at the end.
- **Discovery only reviews CHANGED paths.** A file inside a lens scope that the diff does not touch is invisible to discovery — that is how the write-lock violation in `fg591-dispatch-worker.ts` (a caller of the changed `insertRun`) went unfound. Findings you already hold cannot be injected into the ledger; there is no add-finding verb. The workaround that worked: carry them in the `--rationale` of a `fix_now` disposition, which reaches the fixer with the batch.
- **An ABSENCE cannot be discovered either** (the missing AC4 corpus guard). Same workaround.
- **`forge launch run` inherits the submitting shell's cwd and has no `--cwd`.** A test run launched from the wrong tree exits 0 against the wrong code and looks like evidence. `cd` first, and check the sha in the same command.
- **`forge retry` refuses a task whose candidate built red** ("fix the break in code, then retry"), and that refusal is evaluated from recorded task state, not from a re-read of the tree — so after genuinely fixing the break it still refuses and needs `--force`. Fix first, then force; do not force first.
- **Acceptance evidence must cite a test name as the runner PRINTS it, with real runner output.** Semicolons in a test name still break the validator (it splits on them). Budget a real test run to capture output before Stage 9 — `--acceptance` is a bare JSON array of `{ref, verdict, evidence}` and `--docs-closeout` is required (omitting it reads as NOT assessed and blocks).

**Decisions worth not relitigating:**

- **Central capture at `insertRun`, not per-caller.** `insertRun` is the sole production INSERT INTO runs, so AC4 holds by construction. Per-caller capture was rejected because a future sixth creation path would silently reintroduce the bug — six bypass paths already existed (`design.ts`, three campaign lanes, orchestrator `launch.ts`, `fg591-dispatch-worker.ts`). The invariant is now GUARDED by a corpus test, so do not "simplify" by adding a second INSERT.
- **A dedicated additive column, not `runs.metadata`.** AC5's feed/usage/trends are GROUP BY and scoped-filter queries; over a JSON field they force full-scan + JSON.parse, and the `idx_runs_dispatch_key` precedent shows metadata queries need their own guarded expression index anyway. Three direct-insertRun sites write no metadata at all.
- **No third identity space.** `pk-` and `repo-` reconcile through the EXISTING `project_identity` registry. Do not mint a new space and do not re-key existing rows.
- **Capture is a pure reader, permanently.** It must never call `resolveAndClaimProjectKey` / `writeProjectKey` / `writeBacklogConfig`. Run creation is not an operator-present door; a capture that healed config would dirty git and mint registry rows for every throwaway clone forge is pointed at. Pinned by a test.
- **A declared `project_key` is bound to corroborating evidence before it can join another project's scope.** This was a real security finding: a copied `.forge/config.yml` could place a checkout's runs in another project's scoped views. The fix deliberately preserves legitimate clone inheritance (an agreeing declared key is still trusted) — do not "fix" it by dropping declared-key trust wholesale, that is the feature the ticket depends on.
- **`project_dir` and `project_dir_canonical` stay.** The operator's "the workdir is not useful information" governs the KEY and the TAG only. Exact-checkout operational scoping and the projects-view missing-checkout handling still need the path, and the identity arm must never widen a raw path scope.
- **Merged 3 commits past the reviewed candidate `7d7d0383`** — the browser-tier registration, verify's no-op republication, and the docs commit. All additive, non-production-code, individually validated, both required CI checks green, stated explicitly rather than slipped in. Same shape as FG-703's precedent. See FG-682 above.

**Shipped (for reference):**

- **FG-663** (`e4188e0c`, PR #240) — durable project identity on runs. Additive `runs.project_identity` column + index; pure-reader capture at the single `insertRun` choke point with declared-key → registry → evidence precedence; dashboard keys, tags and scopes from the stored value with the live path probe demoted to a legacy-row fallback; identity resolution hoisted above the SQLite write transaction in the dispatch worker, campaign executor and `startRun`. Three review findings fixed (all-gone presentation falling back to the vanished path, config-declared-pk runs excluded from their own project scope, cross-project identity forgery) plus two items discovery structurally could not reach (the write-lock violation and the absent AC4 guard). 30 new tests across store, dashboard and a real-Chromium E2E suite.

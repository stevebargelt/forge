**Last session ended 2026-07-03.**

**Where we left off:** Shipped **FG-452** — brought the campaign **out-of-band code-touching** completion lane to reconcile parity with the scope-blocked lane (PR #10, merge e50941e). This closes the FG-443×FG-440 seam that wedged FG-422 at `awaiting_gate` in campaign-922c83b7c577 despite it being merged/closed. Origin: user review of the FG-443/440 ship found three real gaps (no reconcile-time capture in the out-of-band branch; exact-sha matching instead of ancestry+base-reachability; generic operator hint). All fixed.

**How FG-452 landed (heavy review, worth remembering the shape):**
- engineer built it; `forge review-loop` ran 2 rounds (found: AC5 subprocess-stdout assertion missing; done-audit surface matched host-verification by exact-sha then, after round-1 fix, ancestry-ONLY without base-reachability); a focused post-fix red-wide passed.
- Then a THIRD user review round caught what the loop + red-wide missed: AC5 was only half-met — the item-row hint pointed at `forge campaign reconcile` but the campaign-level `Next action:` / `Next operator action:` lines were still generic gate text (`computeNextShowAction` + `computeNextOperatorAction` never consulted `outOfBandHostVerificationHint`). Fixed in 2297ea8. Also two docs-drift fixes (009cb03): concepts.md:246 was describing an aspirational passing-row model while done-audit code is any-fail-wins; :262 `--commit` no longer must equal closedCommit under coverage.
- LESSON reinforced: verify the operator surface at BOTH the item level AND the top-level next-action/safety helpers — they must all agree. red-wide + review-loop both missed the top-level next-action gap.

**Filed follow-ups (from FG-452 review, NOT unmet FG-452 AC):**
- **FG-453** — align done-audit host-verification aggregation (currently any-fail-wins) with reconcile's passing-row model, OR explicitly document/report stricter audit semantics. AC includes fail-then-pass + fail-only cases. Absorbs two red-wide lows (done-audit non-ancestor negative test; done-audit→campaign layering/import-direction smell). User's product lean: done-audit should probably be passing-row too, with failed rows visible as history not a current failure. The literal FG-422 (single passing capture) is clean, so this was correctly a follow-up, not an FG-452 blocker.
- **FG-454** — trust-model docs note: ancestry+base-reachability coverage widens a single manual `record-host-verification` row's effective scope within a ticket (red-wide low; within the existing operator trust boundary, docs-awareness only).

**Picked up next (Phase 6 continuation — unchanged priority):**
1. **FG-441** (resume reconciles manually-driven campaign item runs after merge/close) — still the bounded WIRING change in the resume path (`executor.ts:542`): before `driveWorkflowItem` on an `awaiting_gate` item, run the out-of-band evidence check + reconcile-to-complete. All primitives now exist (FG-443 evidence, FG-440 capture, FG-427 per-task eval, FG-452 out-of-band capture+ancestry+surface). Nuance: reconcile runs on a PAUSED campaign (paused-guard write); resume runs on a RUNNING one (normal drive-loop write).
2. **FG-442** (planner routes each item into an execution lane instead of defaulting to full feature) — completes Phase 6; absorbs FG-443's deferred AC3 (docs/authoring lane routing).
3. Then either the FG-452 follow-ups (FG-453/454) or parallel-campaign prereqs (FG-410/424/425/426).

**External state:**
- campaign-922c83b7c577 STILL paused as preserved evidence — do NOT clean up. FG-452 was proven against a faithful FIXTURE mirroring the FG-422 shape (operator chose to keep 922 intact rather than mutate it via a live reconcile). campaign-922 remains the live reference for FG-441.
- main clean at the FG-452 close bookkeeping commit.

**Ops lesson (new this session):** run `forge invoke`/`forge new` with `run_in_background: true` — the Bash-tool 10-min cap SIGTERMs the forge parent (exit 143), leaving an EMPTY result.json + a falsely-`complete` run. Work still persists to /project on disk; recover via `git status` + the container.stdout.log tail + host typecheck/test:all. Hit this twice on FG-452 (the FG-377 persistence-check also false-positived once — verify git status before believing "work not persisted").

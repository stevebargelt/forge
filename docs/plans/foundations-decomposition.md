# Proposed decomposition — FG-561 foundations campaign

**This is a PROPOSAL, not an allocation.** It decomposes each cluster's PRD into bounded implementation
children so the **primary orchestrator** can act on it. **It allocates NO tickets, files no backlog, decomposes
nothing into real work items, and creates no binding decisions.** Every normative decision lives in the three
PRDs; this document only proposes *how the already-decided work would be sliced* and cites the PRD ids each slice
satisfies. Where a slice's ordering or coupling is asserted, it cites the integration map — it does not re-derive
it.

**Keyed to each cluster's review-clean lane HEAD (and the campaign baseline):**

| Cluster | PRD file | Review-clean lane HEAD |
|---|---|---|
| **A** — agent workspace isolation | `docs/prds/agent-workspace-isolation.md` | **`a0064d5`** |
| **B** — review execution trust | `docs/prds/review-execution-trust.md` | **`68ee713`** |
| **C** — workflow lifecycle semantics | `docs/prds/workflow-lifecycle-semantics.md` | **`c55da4a`** |
| campaign baseline | (origin/main at campaign start) | **`185afc3`** |

**SHA semantics (uniform across all three clusters).** Each cluster SHA above is the **review-clean lane HEAD**,
not necessarily the commit that finalized the PRD *file*. A (`a0064d5`) and B (`68ee713`) are each simultaneously
the PRD-finalizing commit **and** the lane HEAD. For **C**, the PRD file
`docs/prds/workflow-lifecycle-semantics.md` was finalized at **`31a690d`**; `c55da4a` is a later **plan-only**
census fix on the same lane branch (it edits `docs/plans/foundations-lane-c-lifecycle-semantics.md`, not the
PRD) — cited here as the lane HEAD, so `c55da4a` must not be read as a PRD edit.

Cross-references to ordering/coupling cite `docs/plans/foundations-integration.md` (the integration MAP).

**Evidence discipline.** Each child names its **RED PREREQUISITE** using the PRD's own labels: a
**VERIFIED/captured** observed-red (cite the probe) is already met; a **REQUIRED** observed-red is a hard
precondition on the implementing child (cite what must be run and where); a **NORMATIVE-UNMET** contract gets an
acceptance condition and **no fabricated red** — inventing a strawman to redden is itself a reject condition.

> **Hard campaign-wide precondition (from the map §5 / Deliverable 2).** No child below may begin implementation
> until the **post-FG-561 delta-audit** (`docs/plans/foundations-post-fg561-delta-audit.md`) passes. Several
> children's captured reds and acceptance probes are **FG-553-sensitive** (they ran the working tree via `tsx`
> or a real container against the current mount logic); the audit rebinds them to the promoted artifact. This is
> stated per child under RED PREREQUISITES where it bites.

---

## Cluster A — agent workspace isolation (PRD `a0064d5`)

Three bounded children. FG-559 (mount + detector) and FG-345 (remaining scope) are independent of the rest of
the campaign; FG-356 (reaper) carries the one **hard red gate** in the cluster.

### A-FG559 — git-capable mount + two-layer fail-loud detector + blue-seam closure

- **OWNING PRD DECISIONS:** D1 (common-`.git` `:ro` mount, every class), D2 (`:ro` is the security boundary),
  D3 (canonicalized path identity), D4 (boundary code-constructed, not template-derived), D5/D5a/D5b
  (read-only history lens + agent-facing + refusal-message contract text), D6 (two-layer detector), D7
  (preflight the effective mount root), D10/D10a/D10b (blue worktree-local `.git` pointer freeze +
  a **single hardened host-git wrapper** prepending fixed-key `-c core.hooksPath=/dev/null -c core.fsmonitor=`,
  its completeness ENFORCED — not enumerated — by a **FAIL-CLOSED DEFAULT-DENY SYNTACTIC guard** over every
  host-side git exec: wrapper, or annotated plumbing-allowlist entry, or the build fails).
- **ACCEPTANCE ROWS:** AC-1, AC-2, AC-3, AC-4, AC-7 (factual defects); N-1, N-2, N-3, N-4, N-5, N-9
  (NORMATIVE-UNMET). Invariants I-1, I-2, I-3, I-4, I-5, I-8, I-10.
- **FILES / SCHEMAS:** `src/v2/spawn.ts` (mount construction + Layer-1 preflight home `preflightProjectMount`
  `:479`; mode currently a template substitution `:255-257` from `SpawnContext.PROJECT_MODE` `:40`);
  `docker/agent-entrypoint.sh` (Layer-2 executed assertion — zero git awareness today); the preflight
  **argument** at all four call sites (`runNext.ts:572`, `:2467`, `:2957`, `invoke.ts:548` — must become
  `worktreePath ?? projectDir`); the agent-facing seed/task-package text (D5a); the single hardened host-git
  wrapper + its fail-closed default-deny syntactic guard over every host-side git exec (D10a) — the guard's
  KNOWN-LIVE **starting set** (labeled honestly, NOT a completeness claim): `autoCommitSource`
  (`integration-publisher.ts:305-308`), `changedWorktreeFiles` (`reconcile.ts:229-240`), **and**
  `mergeChildIntoIntegration` (`worktree-lifecycle.ts:420-439`, missed by the prior "COMPLETE set"); the wrapper
  prepends `-c core.hooksPath=/dev/null -c core.fsmonitor=`. **No schema, no `tasks` column, no failure-kind
  added** (§4).
- **RED PREREQUISITES:** all **VERIFIED/captured** — AC-1 `p5-docker-container-git.out` DIRECTION 1; AC-2 `p5`
  DIRECTION 4; AC-3 `p5b-symlinked-tmpdir-hazard.out`; AC-4 probe P4; AC-7 `p6b-real-vector-standalone-alternates.out`
  STEP 1 (with **P6 retained as a NEGATIVE CONTROL** — its clean result is a false negative, not evidence the
  seam is closed). N-1…N-9 are NORMATIVE-UNMET → **no fabricated red**; the Layer-2 mutant (N-4) and the
  pointer-bind mutant (N-9) are **test-strength checks on delivered code, NOT baseline reds** (PRD §8.6).
  **FG-553 sensitivity:** every executed acceptance test must be confirmed to run against `forge` vs `forge-dev`
  (PRD §7.3 / map §5); the git-path probes p5/p5b are FG-553-*insensitive* and stay valid across it.
- **DEPENDENCIES:** none inbound. **Outbound:** B-FG566's ownership predicate late-binds to whatever workspace
  shape this lands (map D5 — linked worktree vs standalone clone); FG-566 is not blocked, only its predicate is
  (map §4). C is independent of it.
- **CONCURRENCY CONSTRAINTS:** touches `spawn.ts` and `agent-entrypoint.sh`, which **no other cluster edits** —
  no shared-file coordination. Must **NOT** touch reconcile's running-task loop (`reconcile.ts:452`) — that is
  A-FG356's separate additive pass.
- **HOLLOW VERSION TO REJECT:** (1) a mount whose acceptance is "the docker argv contains the `-v` string" — a
  source-pattern match, **not** git succeeding inside a real container (AC-1). (2) An **uncanonicalized** mount:
  it silently no-ops on a symlinked `$TMPDIR` with the byte-identical `fatal: not a git repository: (null)` and
  is indistinguishable from the defect (D3/AC-3) — a detector comparing uncanonicalized paths reports PASS where
  the fix does not work. (3) A Layer-2 that checks `/project/.git` **exists** rather than **executing**
  `git log -1` — today's broken shape has a `.git` file that exists and is useless (N-4). (4) A wrapper that
  disables **only `core.hooksPath`** and not the other per-command vectors — `core.fsmonitor` is a **fixed-key**
  vector on `status`/`add`, closable by the same `-c` mechanism, and MUST also be disabled (`-c core.fsmonitor=`);
  and even a full fixed-key wrapper leaves the **attacker-named** vectors — `filter.<name>.clean` on `add`,
  `diff.<name>.textconv`, `merge.<name>.driver` — OPEN (no fixed `-c key=` can name them), so **D10b (pointer
  `:ro`) is the load-bearing closure** (AC-7 / `p6b` STEPS 2–3). D10a alone is PARTIAL by construction. (5)
  Expressing the `.git` mount or its mode as a runtime-template entry — an agent-writable `.forge/runtimes/*.yml`
  would then control its own containment (D4). (6) A "warn for blue, refuse for red" policy — the door by which a
  reviewer ends up reviewing without git (D6). (7) A **hand-enumerated "COMPLETE set"** of host-side git sites
  asserted exhaustive — that enumeration was **falsified TWICE in two review rounds** (first `changedWorktreeFiles`,
  then `mergeChildIntoIntegration` at `worktree-lifecycle.ts:410+`); D10a retires the list for a fail-closed
  default-deny guard where any raw git exec that is neither the wrapper nor an annotated plumbing-allowlist entry
  **FAILS THE BUILD** — completeness by construction, not by a curated list (D10a). (8) A guard keyed on a
  **runtime "cwd resolves to an agent worktree" dataflow test** instead of the **syntactic call-site check** — a
  runtime `cwd` is an arbitrary expression no grep/AST can decide, so such a guard is not buildable; the guard
  keys on the decidable syntactic property (is this exec the wrapper? is its source location on the annotated
  allowlist?), fail-closed by default (D10a).

### A-FG356 — terminal-task worktree + branch reaper

- **OWNING PRD DECISIONS:** D9 (reaper is a **separate pass over TERMINAL tasks**, not a running-loop bolt-on;
  TERMINAL is **exactly `{complete, failed}`** — the canonical set at `fg530-harness.ts:735` — so the net reapable
  status set is `{complete, failed}`, NOT a broader `{complete, failed, cancelled, blocked_by_red}`),
  D9a (row-only input, no FS scan), D9b (retain predicate — clause (c) RETAINS every non-terminal state, notably
  `blocked_by_red`, operator-force-advanceable per `gate.ts:97-107`), D9c (new `provenEmpty` condition — NOT
  `provenMerged`), D9d (branch pruned under the same predicate).
- **ACCEPTANCE ROWS:** AC-5 (factual defect — **the hard gate**); N-6 (reaper retain predicate / `provenEmpty` /
  branch prune / idempotency, NORMATIVE-UNMET). Invariants I-6, I-7, I-9.
- **FILES / SCHEMAS:** `src/v2/reconcile.ts` — NEW additive terminal-task pass appended to `reconcileRun`'s tail;
  reads `changedWorktreeFiles` (`:229-240`) for the dirty clause; must NOT touch the running-only loop (`:452`).
  `src/v2/worktree-lifecycle.ts` — new **`provenEmpty`** removal condition alongside `EPHEMERAL`/`provenMerged`
  (`:187`). **Task-row columns READ only:** `worktreePath`, `status`, failure kind, `runId`, `taskId` +
  `run.projectDir`. **Failure kinds READ:** the INSPECTION-RETAIN set (`failure-kind.ts:125-143`:
  `merge_conflict`, `integration_failed`, `integration_gate_timeout`, `integration_gate_crashed`,
  `publish_base_churn`, `dirty_publish_target`, `publication_refused`, `orphaned_work_may_persist`,
  `orphaned_needs_finalize`, `oom_killed`, `fanout_wave_orphaned`). Branch `forge/<runId>/<taskId>` pruned.
- **RED PREREQUISITES:** **AC-5 is a HARD GATE and is NOT yet captured.** Run
  `src/v2/fg530-crash-worktree.worktree.test.ts` at crash point
  `finalizePrimary:between-complete-status-and-event` (`:350`) **on the macOS host** and **observe the leak** — a
  worktree + branch no reconcile pass ever removes — **before a line of the reaper is written** (PRD §7.1 / OQ-2).
  **If it does not reproduce, D9's premise is wrong and the spec is re-derived, not implemented.** Owner:
  implementer, on the host. (The planning container cannot run it — `*.worktree.test.ts` hard-fails on Linux by
  design.)
- **DEPENDENCIES:** **cross-cluster, weak** — shares one constant with B-FG524: `awaiting_gate ∈ non-terminal`
  (map D3 / §4-Q2). A's terminal-only predicate already excludes a held child; B N-9(a) additionally requires
  the reaper be *aware* of `awaiting_gate` as a live child state. **Parallelizable** with B-FG524 (map §4). The
  run-end reclaim of a still-held child is **NOT** owned here — it is the unowned seam OQ-INT-2 (map §3).
- **CONCURRENCY CONSTRAINTS:** shares `reconcile.ts` with **C** (`finalizeOrphanedPrimaries` `:1361`, fanout
  sweeps `:1120`/`:1261-1263`) and **B** (crash-recovery gate `:779`/`:880`). **Disjoint line regions** →
  COEXIST textually (map §2.2), but three semantic convergences must be preserved: A keys on the ROW / C keys on
  lineage (they agree by construction); A's reaper reads the now-terminal row C's `finalizeOrphanedPrimaries` may
  have written (idempotent, order-free); B's sweeper-decline keeps contraband NON-terminal so A's terminal filter
  leaves it alone (map §2.2 items 1–3).
- **HOLLOW VERSION TO REJECT:** (1) a reaper bolted into reconcile's **running-task orphan loop** — it fixes only
  the orphan case, looks correct, and leaves the predicted FG-530 terminal-task leak wide open (D9). (2) A
  **filesystem-scanning** reaper — a directory scan cannot distinguish a concurrent live run's worktree from an
  orphan and eventually deletes live work (D9a). (3) Passing **`provenMerged: true`** in place of the new
  `provenEmpty` condition — a false claim a merge happened; silently widens the no-discard invariant for every
  other caller (D9c — "the single easiest way to implement FG-356 wrongly"). (4) Reaping the **directory but not
  the branch** — refs accumulate forever, `git worktree prune` will not touch them (D9d). (5) Reaping a worktree
  with **changed files** or a **retain-set kind** (e.g. `merge_conflict`) — the load-bearing dirty clause (D9b(a))
  and the kind clause (D9b(b)) exist to prevent exactly this. (6) A reaper whose reapable / terminal set includes
  **`blocked_by_red`** — it is NOT terminal but RECOVERABLE and **operator-force-advanceable** (`gate.ts:97-107`);
  its worktree holds committed-but-unmerged work the operator can still force-advance, so reaping it **DISCARDS
  operator-actionable work — a direct I-6 violation.** `blocked_by_red` is RETAINED by D9b clause (c) exactly like
  the held-child case (D9). (7) A reaper that lists **`cancelled`** as a reapable status — **DEAD CODE that can
  never match:** `cancelled` is a `FailureKind` (`failure-kind.ts:125`), not a `TaskStatus`; a cancelled task
  carries status **`failed`** and is already covered by `failed`. The corrected reapable set is exactly
  `{complete, failed}` (D9).

### A-FG345 — remaining worktree-isolation scope (ignored-files diagnostic · stale advisory · chaining pin)

- **OWNING PRD DECISIONS:** D8 (the ticket's merge-back framing is DEAD CODE — legislate the TRUE remaining
  scope), D8.1 (report-not-copy ignored/gitignored files as a second diagnostic surfaced to the agent), D8.2
  (delete the stale FG-354 advisory), D8.3 (pin emergent sequential chaining with a test).
- **ACCEPTANCE ROWS:** AC-6 (factual defect — stale advisory); N-7 (ignored-files diagnostic surfaced to agent),
  N-8 (sequential chaining pinned). NORMATIVE for N-7/N-8.
- **FILES / SCHEMAS:** `src/v2/worktree-lifecycle.ts` — `createWorktree` untracked-file collection
  (`:146-158`, `git ls-files --others --exclude-standard`); delete the `console.warn` FG-354 advisory
  (`:130-134`). **Must NOT touch** `mergeWorktreeBranch` (`:244`) or `mergeIntegrationBranchToHead` (`:487`) —
  **dead code, zero production call sites** (D8, enforced by `fg425-publisher-scope.test.ts:182`).
- **RED PREREQUISITES:** AC-6 **VERIFIED/observable trivially** — the `console.warn` at `:130-134` claims FG-354
  has not landed; `runNext.ts:665` / `invoke.ts:798` show it has. N-7/N-8 NORMATIVE-UNMET → **no fabricated red.**
- **DEPENDENCIES:** none cross-cluster. Independent of FG-559 and FG-356.
- **CONCURRENCY CONSTRAINTS:** none — `worktree-lifecycle.ts` regions here are not shared with B or C.
- **HOLLOW VERSION TO REJECT:** (1) **copying** ignored files into the worktree — defeats FG-376's
  dependency-volume design and risks leaking secrets into a publisher-committed branch (D8.1: report, do not
  copy). (2) A diagnostic emitted **only to stderr**, not surfaced to the agent's context (N-7). (3)
  "**Fixing**" or reviving the dead merge-back functions instead of leaving them dead (D8 / §4). (4) Leaving the
  sequential-chaining mechanism **unpinned** — a future publish-target or dispatch-order change silently degrades
  it to all-off-a-stale-HEAD (D8.3/N-8).

---

## Cluster B — review execution trust (PRD `68ee713`)

Five bounded children. INV-1's guard is the **highest-leverage, land-first** item (D5). FG-524 is
**one indivisible child** (gate + re-aggregation — gating alone is a regression). FG-525 carries the one
**REQUIRED-at-implementation** container-gone red.

### B-INV-1 — declared finalize-site census guard (land FIRST)

- **OWNING PRD DECISIONS:** INV-1 / §2 (finalize EVENT classified by lineage/role, never `startsWith("red-")`),
  D5 (highest-leverage, lands first — a sequencing/leverage claim, **not** an acceptance claim; it does not on
  its own discharge the cluster's acceptance).
- **ACCEPTANCE ROWS:** N-1 (NORMATIVE-UNMET). INV-1.
- **FILES / SCHEMAS:** a repo-level guard over `src/` enumerating the §2 finalize classes and asserting each
  census site maps to its declared class + recorded gated/exempt-with-reason disposition. Census sites (plan
  §1.1, reconciled in §2): `finalizePrimary` callers — single-step `runNext.ts:838`, fanout parent `:1955`,
  publication/crash-recovery `:2180` (all funnel `markTaskComplete` `:1010`); direct `markTaskComplete` —
  `runNext.ts:2541` (fanout child), `:1381` (red-review), `invoke.ts:813` (ad-hoc), `invoke.ts:768`
  (inferred-result); crash-recovery — `reconcile.ts:779`/`:880`, `recover.ts:457` (`markTaskRecovered`);
  override `gate.ts:209`; post-gate re-entry `runNext.ts:936`/`:1661`; non-implementer `design.ts`/`claude.ts`.
  Keys on `isInvokeLikeRun`/`taskHasPipelineFinalize` (`run-kind.ts`) and `IMPLEMENTER_ROLES`
  (`validation-contract.ts:53`). **No schema change.**
- **RED PREREQUISITES:** **NORMATIVE-UNMET** — no such guard exists; the census is prose, not executable truth.
  The plan's "red today by construction" is **reclassified to NORMATIVE-UNMET** (PRD §2): a guard that can only
  go red because it is unwritten is not a defect. **No fabricated baseline red** — acceptance condition N-1 only.
- **DEPENDENCIES:** **NONE cross-cluster.** Keys on **shipped** surfaces (`run-kind.ts`, `IMPLEMENTER_ROLES`),
  **not** C's unbuilt S2–S6 (map D2 / §2.4 / §4-Q3). Can land first, in parallel with C-retry. Makes B-FG524 and
  B-FG525 reviewable (a reviewer otherwise cannot tell whether a finalize gate is complete).
- **CONCURRENCY CONSTRAINTS:** none — it is a test/guard, not a mutation of a shared function.
- **HOLLOW VERSION TO REJECT:** (1) enumerating **`markTaskComplete`/`markTaskRecovered` call sites** (the
  primitive) instead of finalize **events** — `finalizePrimary` collapses the gated primary (`:838`) and the
  exempt aggregate (`:1955`) onto the one write `:1010`, so a primitive-site guard is **blind** to which class it
  is finalizing (§2). (2) A guard scoped to **implementer-reachable** paths only — N-1 requires **every** terminal
  writer of **any** role be classified (a new red-review completer or run-level closer added silently is the
  hole). (3) Keying class membership on `agentRole.startsWith("red-")` — the exact heuristic C-FG527 deletes
  (§9.1). (4) A **wildcard/blanket allowlist** that admits unclassified paths.

### B-FG566 — provision the clone in place; refuse rather than guess a runtime

- **OWNING PRD DECISIONS:** D1 / D1.1 (detect+classify readiness at each of the three local-run sites; stop
  discarding the child exit code), D1.2 (`verification_environment_unavailable` as a zero-round **outcome**,
  distinguished at every surface), D1.3 (provision `node_modules` into `ctx.projectDir` — host-side,
  lockfile-keyed, docker-free), D1.4 (**declare and record** the runtime; refuse on mismatch, do not guess or
  search PATH). INV-4 (covering-evidence identity → `ctx.projectDir`).
- **ACCEPTANCE ROWS:** R-566 (factual defect); N-2, N-3, N-4, N-8 (NORMATIVE-UNMET); F1–F5 mapping (§7.3).
  INV-3, INV-4.
- **FILES / SCHEMAS:** `cli/commands/review-loop.ts` local-run sites `:544` (dirty-tree), `:622`
  (CI-unavailable fallback), `:853` (fixer pre-commit) — all `runVerify(..., {cwd: ctx.projectDir})`; the
  verification runner's dropped **child exit code** at the exec boundary (`127`/`ENOENT`); the existing
  `FailureKind` `verification_environment_unavailable` (`failure-kind.ts:151` → `policy.ts:62` `campaign_system`);
  provisioning into `ctx.projectDir` reusing `docker/forge-test.sh`'s readiness vocabulary + one of the two
  existing cache-key schemes (`dependency-provisioning.ts:52` **or** `forge-test.sh`, never a third — OQ-3).
  **`host_verifications` schema is READ-ONLY** (keyed on `project_dir`, `store/schema.ts`; INV-4). No task-row
  migration.
- **RED PREREQUISITES:** R-566 **VERIFIED/captured** (plan §2.1, EXECUTED, with a prepared-repo control arm:
  unprepared → `ok=false`, prepared → `ok=true`; reviewer dispatched 0×; both rounds burned; fixer handed
  `tsc: not found`). N-2/N-3/N-4/N-8 NORMATIVE-UNMET → **no fabricated red.** **FG-553 sensitivity (map §5 / B
  OQ-4):** the probes ran the working tree via `tsx`; after FG-553 `forge review-loop` runs the promoted release,
  so `fg566-unprepared-env.sh` must be re-run and each falsification re-bound to the right artifact. **N-2/F3
  must be re-derived against the pinned post-FG-553 ABI** (B §9.4 / OQ-1), not against a hardcoded value.
- **DEPENDENCIES:** **soft, cross-cluster** — the ownership predicate ("provision only a Forge-owned workspace")
  late-binds to whatever **A-FG559** lands as a Forge-owned workspace (map D5 / §2 B §9.3). Provisioning into
  `ctx.projectDir` is not blocked (that dir exists regardless); only the predicate shape binds. FG-566 does NOT
  fix git-in-container; FG-559 does NOT fix deps — distinct contracts.
- **CONCURRENCY CONSTRAINTS:** none shared with C. The only coupling is the A-FG559 workspace **definition**
  (a late bind, not a shared-file edit).
- **HOLLOW VERSION TO REJECT:** (1) a `--local-extended` / provisioning path that **mislabels
  `extendedDelegatedToCi`** — extended coverage on a local-only tip is *absent, not delegated* (D2(a); this bites
  FG-566's surface where the two overlap). (2) **Guessing** a runtime / searching PATH on mismatch instead of
  refusing before round 1 (D1.4). (3) Provisioning into a **scratch clone** rather than `ctx.projectDir` — either
  invisible to covering-evidence lookup or manufacturing a false `host_verifications` row asserting a gate passed
  where it did not run (INV-4). (4) A pre-check that passes but still lets a **`127`/`ENOENT`** launder into a
  code finding because the exit code is discarded (D1.1). (5) Marking a **failed/interrupted install** as ready
  (N-8). (6) Minting a **third** cache-key/readiness vocabulary (non-goal / OQ-3).

### B-FG541 — honest `local_only` outcome now; `--push-fixes` safety contract designed, deferred

- **OWNING PRD DECISIONS:** D2(a) (consult `resolveReviewedTipTrust` **before** probing CI; emit a distinct
  `local_only` outcome; `extendedDelegatedToCi` FALSE when local-only; fix the stale comment) — **ships and is
  verified here.** D2(b) + INV-5 (`--push-fixes` safety contract) — **fully designed, binding whenever on, but
  its implementation is a separable opt-in NOT part of this cluster's shipping acceptance.**
- **ACCEPTANCE ROWS:** R-541 (factual defect); N-5 (`local_only` honesty — ships here); N-6 (INV-5, **CONDITIONAL
  — NOT shipping acceptance**). INV-5.
- **FILES / SCHEMAS:** `cli/commands/review-loop.ts` — consult `resolveReviewedTipTrust` (defined `:454`,
  currently called only at `:1040`) before the CI probe; emit `local_only` distinct from the generic
  "CI unavailable" (`:620`); `extendedDelegatedToCi` currently unconditional `!ctx.localExtended` at `:621`; the
  stale comment at `:848-851`. **No push verb exists** in either review-loop file today (git-verb set:
  `add checkout clean commit rev-parse rm status` + `fetch`) — building `--push-fixes` would add one, deferred.
- **RED PREREQUISITES:** R-541 **VERIFIED/captured** (plan §2.2, EXECUTED — structural census decisive: no
  `git push` verb, so the next round probes CI for a SHA GitHub never received; six-SHA historical arm
  corroborates and rules out coincidence). Carry the plan's **HONEST LIMIT** (a clone has no reflog of when
  origin first received a push — the structural arm carries the conclusion). N-5 NORMATIVE-UNMET → **no
  fabricated red.** N-6 is **conditional** — its per-clause tests run only when the flag lands, against a real
  upstream.
- **DEPENDENCIES:** none cross-cluster. Independent.
- **CONCURRENCY CONSTRAINTS:** none shared with A or C.
- **HOLLOW VERSION TO REJECT:** (1) a `--local-extended` path that **mislabels `extendedDelegatedToCi`** as
  delegated when the tip is local-only (D2(a)). (2) Adding **CI-registration wait/delay** as the "fix" — the
  defect is an ABSENCE, not a race; waiting longer for a check-run on an unpushed SHA is a non-fix (non-goal).
  (3) Shipping `--push-fixes` **without the full INV-5 contract** (force push; branch-creation-by-guess; push
  from detached HEAD; pushing pre-existing unrelated local commits; treating a push as conferring closeability).
  (4) Conflating the two independent questions — honesty (ships now) vs push authority (deferred, OQ-2) — the
  conflation that produced the stale comment.

### B-FG524 — fanout-child gate COUPLED to parent re-aggregation (one indivisible child)

- **OWNING PRD DECISIONS:** D3 (gate the child **and** couple to re-aggregation — gating alone is a regression),
  INV-2 (gate couples to re-aggregation / no silent publication; held ≠ failed; `continue` may not step over a
  hold). §9.1 boundary (role-scoped via `IMPLEMENTER_ROLES`, **no** `red-` check). §9.2 (held-child worktree
  retention → reclaim).
- **ACCEPTANCE ROWS:** R-524 (factual defect); N-7 (re-aggregation + hold semantics), N-9 (held-child worktree
  retention → reclaim) — both NORMATIVE-UNMET. INV-2.
- **FILES / SCHEMAS:** `src/v2/runNext.ts` `dispatchFanoutStep` — child gate at `markTaskComplete` `:2541`
  (add validation-contract gate + a **`held` `ChildOutcome` variant** at `:2353`); re-entry branch
  `:1668-1671` (**replace outright** to re-aggregate — today returns `existingParent.status` and stops);
  `childTasksForCleanup` `:1620-1626` (change semantics — a held child must be **retained**, not swept; today
  filters `status === "complete"`). Hold via **existing** `markTaskHeldForGate` + existing `task.awaiting_gate`
  event payload — **NO schema migration** (D3, plan §1.3). Operator verb reuses `gate.ts:209`
  (`forge gate advance|reject <childTaskId>`). Publisher: `publishFanoutIntegration` `:1942`/`:1973` (publication
  WITHHELD while held). **Task-row status value `awaiting_gate`** (already exists).
- **RED PREREQUISITES:** R-524 **VERIFIED/captured** (plan §2.3 ARM 2, EXECUTED via real `dispatchFanoutStep`
  against real SQLite — contraband child **and** parent both completed silently). The re-aggregation behavior
  and the `continue`-must-not-swallow-a-hold rule are **NORMATIVE-UNMET** (PRD §3 D3 reclassification: there is
  no held-child state at baseline, so the wedge cannot be observed red without first building the gate; the
  `:1671` no-op is a VERIFIED FACT feeding the design, not a falsification) → **no fabricated red.**
- **DEPENDENCIES:** **cross-cluster.** (i) Shares `dispatchFanoutStep` with **C-FG527** — a **shared-function
  overlap with NO semantic prerequisite** (B's gate is role-scoped, VERIFIED B §9.1); whichever lands second
  does a **COORDINATED** rebase (map D1 / §4-Q1 — see the map's relabel: the *parallelizable* conclusion is
  INFERENCE, and the `:1668-1671` overlap is a coordinated change, not a routine one). (ii) Coupled to **C-S2**:
  S2 must model `awaiting_gate → ACTIVE`, decoupled in practice by the pre-existing status (map D4 / §4; C OQ-6).
  (iii) One shared constant with **A-FG356**: `awaiting_gate ∈ non-terminal` (map D3). Run-end reclaim of a
  still-held child is the **unowned** seam OQ-INT-2.
- **CONCURRENCY CONSTRAINTS:** `dispatchFanoutStep` is **the sharpest collision in the program** (C §5.2a). At
  `:1620-1626` and `:1668-1671` **both B and C change the same lines** — CONFLICT (map §2.1). Coordinate: after
  the other cluster's migration lands, **re-verify the child-filter semantics** (child identity is
  classifier-based post-C; B layers a retain-on-held semantic on top). The `:2541` child-gate is a **disjoint**
  region (COEXIST, rebases trivially). B must **NOT** re-introduce a `red-` prefix check anywhere in the function
  (map §3 ownership row: C owns child identity, B conforms).
- **HOLLOW VERSION TO REJECT:** (1) **gating the child alone** without parent re-aggregation — a held child
  wedges the fanout permanently (`:1671` returns `existingParent.status` and stops); this is a **regression, not
  a partial fix** (D3). (2) A gate placed literally at `markTaskComplete` `:1010`/the primitive that **cannot
  tell a gated primary from an exempt aggregate** — the discriminating info is in `finalizePrimary`'s caller
  class (INV-1 / §2). (3) Asking `agentRole.startsWith("red-")` at the child finalize — the exact heuristic C is
  deleting; derive child identity from `IMPLEMENTER_ROLES` (§9.1). (4) Letting `failure_mode: "continue"`
  **swallow** a held child — held means "we do not know if this is good," not "this is bad" (INV-2). (5)
  **Publishing** the fanout subtree while a child is held — the publisher merges child work into HEAD; that IS
  the silent advance the contract prevents (INV-2). (6) Treating the held-child worktree retention as the
  **accidental** side effect of the `status === "complete"` filter rather than making it intentional with a named
  reclaim path (N-9).

### B-FG525 — gate `forge invoke` AND its crash-recovery bypasses

- **OWNING PRD DECISIONS:** D4 (route ad-hoc invoke completion through the evaluator; a held invoke **returns
  `awaiting_gate` honestly with a non-zero exit** to its synchronous caller; and cover the three crash-recovery
  finalize sites as a **sweeper-decline**, not a completion). Prior art: FG-479's `!isInvokeLikeRun` →
  `failPipelineUnfinalized` (`reconcile.ts:768`/`:869`).
- **ACCEPTANCE ROWS:** R-525 (factual defect); R-525b / **F9** (reachable gap — **observed-red REQUIRED at
  implementation**). INV-1 (the crash-recovery sites are the ones unnamed by any ticket until this cluster).
- **FILES / SCHEMAS:** `src/v2/invoke.ts` ad-hoc completion `:813` (route through the evaluator); the header
  comment `validation-contract.ts:12-21` (must name the invoke path's **real** status); crash-recovery sites
  `reconcile.ts:779`/`:880` (complete an invoke-like task when `isInvokeLikeRun` true at `:416`) and
  `recover.ts:457` (`markTaskRecovered`) — each a **sweeper-decline** in the `failPipelineUnfinalized` shape.
- **RED PREREQUISITES:** R-525 **VERIFIED/captured** (plan §2.3 ARM 3 — a real implementer invoke with
  `status:complete`, no `tests_run`, no waiver completed silently). **R-525b / F9 is REQUIRED at implementation
  and is INFERENCE-only today:** it needs a **genuine container-gone state** (Docker unavailable in the discovery
  container). **Write the probe for the operator to run on the host; the claim stays INFERENCE until executed**
  (PRD §7.1 / D4). The held-invoke honest-return contract is NORMATIVE-UNMET → no fabricated red.
- **DEPENDENCIES:** shares `reconcile.ts` crash-recovery region with A-FG356 and C — **disjoint line regions**
  (map §2.2). No semantic prerequisite on C. The B-INV-1 guard should land first to make this reviewable (D5).
- **CONCURRENCY CONSTRAINTS:** `reconcile.ts:779`/`:880` (B's gate) is a **different region** from A's terminal
  reaper tail and C's `finalizeOrphanedPrimaries`/fanout sweeps — COEXIST textually (map §2.2). B's
  sweeper-decline must keep contraband **non-terminal**, which is exactly what composes safely with A's
  terminal-only reaper (map §2.2 item 3).
- **HOLLOW VERSION TO REJECT:** (1) gating **`invoke.ts:813` alone** and leaving the three crash-recovery
  finalize sites — a container crash walks straight through the gate (D4: "or the gate has a hole"). (2) A
  crash-recovery path that **completes** contraband instead of **declining** it (sweeper-decline: leave the task
  non-terminal in the `failPipelineUnfinalized` shape). (3) A held invoke that **silently completes** rather than
  returning `awaiting_gate` with a non-zero exit to its synchronous caller. (4) A gate at
  `markTaskComplete`/the terminal primitive that cannot tell the gated ad-hoc invoke from the **exempt
  inferred-result invoke** (`invoke.ts:768`, exempt by role) — classify by lineage/role (INV-1 / §2).

---

## Cluster C — workflow lifecycle semantics (PRD `c55da4a`)

Two ticket families. **FG-527** splits into **three risk classes** (per binding D-7); **FG-477** decomposes as
its **five evaluator surfaces S1–S6** emerge from the single derivation, with S2 gating S3/S5/S6.

### C-FG527 — split by risk (D-7 is binding: three children, ordered)

D-7 forbids shipping FG-527 as one ticket — three different risk classes, three revert surfaces, one of them a
**ticket amendment**. The intra-C order is fixed; the shared-function coordination with B-FG524 is separate.

#### C-FG527-a — `retry.ts` correction (ships FIRST; independent file)

- **OWNING PRD DECISIONS:** D-1 (classify with the evaluator, **KEEP REFUSING** a red as a red with an accurate
  message — FG-527's AC #2 is **amended to D-1**, not inherited), D-4 (`--force` is also refused on a red row;
  the operator's re-drive path is `forge recover <parent> --re-drive`). **The parented-red-re-dispatch shape is
  named, NOT built** (OQ-1).
- **ACCEPTANCE ROWS:** A-1, A-2 (factual defects). §7.3 closure item 1.
- **FILES / SCHEMAS:** `src/v2/retry.ts` — the `retry()` mint (`:427-466`, deliberately parent-less PRIMARY row,
  comment `:435-438`); `FanoutChildRetryError` (`:72-88`) keeps firing for genuine `fanout_child` rows; the
  pinned classifier tests `lifecycle-evaluator.test.ts:603`/`:623` (flip DISAGREEMENT→agreement; delete legacy
  fixtures `:596-601`/`:642`, do not invert). **Must NOT touch `retry.ts:263`** (mount-mode predicate — the
  permanent INV-1 allowlist exclusion; also the unowned seam OQ-INT-1).
- **RED PREREQUISITES:** **VERIFIED/captured** — A-1 `p2` part A (`FanoutChildRetryError` … "is a fanout child"
  on a row whose classifier kind is `red_review`); A-2 `p1` (32/32 green incl. two DISAGREEMENT tests). Accept:
  refused **as a red**, accurate message, **no `retry_replacement` row exists in the phase afterwards, incl.
  under `--force`.**
- **DEPENDENCIES:** **none** — different file from `dispatchFanoutStep`; must settle **before** the dispatch path
  moves (D-7 item 1). Independent of B entirely (map §4 landing DAG: `C-retry` is in the INDEPENDENT set).
- **CONCURRENCY CONSTRAINTS:** none — `retry.ts` is not shared with A or B.
- **HOLLOW VERSION TO REJECT:** (1) **inheriting FG-527's AC #2** — migrating retry to *allow* a red retry mints
  a detached primary the fanout adopts as parent of a fresh wave (probe p2); D-1 REFUSES it (map §3 / Deliverable
  3 consolidated table: AC-2 as written is **rejected**, PRD-c owns the correction). (2) Letting `--force`
  bypass the refusal and mint the corrupting detached primary (p2 part B is literally that row) — "force" must
  not mean "corrupt the run" (D-4). (3) Refusing the red **as a "fanout child"** (the accidental-right-answer
  reason) rather than **as a red** — it reaches the wrong answer the moment the `red-` prefix convention drops.
  (4) **Inverting** the legacy fixtures instead of deleting them (A-2).

#### C-FG527-b — ad-hoc `forge invoke` exclusion at all three sites (D-5a; ships BEFORE D-5b)

- **OWNING PRD DECISIONS:** D-5a (an ad-hoc invoke row is **invisible** to workflow dispatch; `forge next` leaves
  it untouched and mints its **own** fanout parent — same predicate, three sites, must move together). D-7 item 2
  (D-5a before D-5b) and item 4 (`resolvePhasePrimary`'s absorption lands **after** D-5a).
- **ACCEPTANCE ROWS:** A-3, A-5 (factual defects). INV-6 (ad-hoc invoke invisible to dispatch / upstream /
  terminal-blocker). §7.3 closure item — D-5a at all three sites.
- **FILES / SCHEMAS:** `src/v2/runNext.ts` `existingParent` lookup `:1572-1574` (the primary defect site);
  `gate.ts:384-386` (request-changes dedup — **unnamed by FG-527/FG-477**); `runNext.ts:3180-3182`
  (`dispatchManualStep` — **unnamed**); `resolvePhasePrimary` / `deriveUpstream` absorption (lands after D-5a).
  **OQ-5 boundary:** do **NOT** fix `dispatchManualStep`'s missing status filter in the same change — it reuses
  *any* parent-less row incl. a `failed` one; preserve that, add only the exclusion, flag it.
- **RED PREREQUISITES:** **VERIFIED/captured** — A-3 `p3` (executed through the **real** `runNext`: invoke row
  ends `status = failed`, `error = fanout: upstream 'plan' has no array at 'steps'` — worse than FG-527
  describes; **promote p3 to an integration test**); A-5 `p4` case A (`deriveUpstream(review)` narrows on a
  complete ad-hoc invoke row), **with case B as the BOUND**: marker-less legacy rows stay unchanged
  (`NARROWED? false`) — the bound is the test.
- **DEPENDENCIES:** **intra-C serial** — must land **before** C-FG527-c (D-5a changes which row is the parent;
  D-5b changes which rows are its children; bundling makes a bisect useless — D-7). No cross-cluster prerequisite,
  but shares `dispatchFanoutStep` with B-FG524 (the `:1572-1574` region is B-disjoint — COEXIST, C-only per map
  §2.1).
- **CONCURRENCY CONSTRAINTS:** the `existingParent` lookup `:1572-1574` is a **C-only** region (map §2.1
  COEXIST) — no B conflict there. But it is inside `dispatchFanoutStep`, so it participates in the shared-function
  coordination with B (rebase whoever lands second).
- **HOLLOW VERSION TO REJECT:** (1) fixing **only `:1572-1574`** and leaving the two unnamed sites
  (`gate.ts:384-386`, `runNext.ts:3180-3182`) — all three are one predicate and must move together (D-5a). (2)
  Landing D-5a **bundled with D-5b** — makes a bisect useless on the lane's top migration risk (D-7). (3)
  Silently **fixing `dispatchManualStep`'s status filter** while adding the exclusion (OQ-5 — preserve, flag).
  (4) Narrowing `resolvePhasePrimary` **before** D-5a — makes the two behavior changes indistinguishable in a
  bisect (D-7 item 4). (5) A narrowing that also touches **marker-less legacy rows** (A-5 case B is the bound).

#### C-FG527-c — `red-` prefix removal + `worktreePath` guard (the lane's top migration risk)

- **OWNING PRD DECISIONS:** D-5b (child identity comes from the evaluator — workflow-declared reds — never a
  role-name prefix), and its **binding guard test that fails if a red row ever acquires a `worktreePath`**.
- **ACCEPTANCE ROWS:** A-4 (factual defect — **red NOT yet captured**). §7.3 closure — D-5b **with** the
  `worktreePath` guard test.
- **FILES / SCHEMAS:** `src/v2/runNext.ts` the three `red-`-prefix child filters — `activeWithChildren` `:1587`,
  `childTasksForCleanup` `:1624`, `pendingHasChildren` `:1669`; `feature.yml`'s `shipping-reviewer`
  (`seeds/workflows/feature.yml:76-113`) is the misclassified case. The guard keys on **reds carry NULL
  `worktreePath`** today (`runNext.ts:1298-1308`; children get one at `:2505`/`:2559`).
- **RED PREREQUISITES:** **A-4 is REQUIRED and NOT yet captured** — the three prefix filters agree with the
  classifier **by accident** (a wrongly-admitted `shipping-reviewer` contributes no worktree to clean, because
  reds have no `worktreePath`). **The observed-red is a pending precondition on this child.** Accept: the red is
  excluded, **plus the guard test that reddens if a red row ever carries a `worktreePath`** — otherwise the day a
  red gets a worktree (a Cluster-A-owned assignment), this filter starts **deleting** it.
- **DEPENDENCIES:** **intra-C serial** — after C-FG527-b (D-5a). **Cross-cluster shared-function coordination
  with B-FG524** at `:1624` (`childTasksForCleanup`) and `:1669` (`pendingHasChildren`) — **both change the same
  lines** (CONFLICT, map §2.1). Per the map's relabel (Deliverable 4): the *no semantic dependency* is VERIFIED,
  but the *parallelizable* conclusion is **INFERENCE**, and this is a **COORDINATED** rebase — after either lands,
  **re-verify the child-filter semantics** against the other's migration.
- **CONCURRENCY CONSTRAINTS:** the two conflicting regions demand deliberate coordination with B-FG524 (not a
  mechanical merge): at `:1624` B layers a retain-on-held semantic onto C's classifier-based predicate; at
  `:1669` C swaps the predicate while B replaces the branch body with re-aggregation. **B must not re-add the
  `red-` prefix C is deleting** (map §3 ownership: C owns child identity).
- **HOLLOW VERSION TO REJECT:** (1) removing the `red-` prefix **without the `worktreePath` guard test** — the
  filter silently starts deleting a red's worktree the day Cluster A assigns reds one (D-5b). (2) A migration
  that **looks like a no-op** and is shipped as one — it agrees with the classifier by accident today; a wrong
  answer inside `dispatchFanoutStep` silently re-drives a fanout wave (the FG-364 failure the `existingParent`
  comment `:1567-1571` records). (3) Deriving child identity from anything **structural** (`parentId`/prefix)
  rather than the evaluator (D-5b / INV-1).

### C-FG477 — the lifecycle evaluator, decomposed by surface (S1 shipped; S2 gates S3/S4/S5/S6)

FG-477 does not close on any single change and **no slice may claim it** (§7.3 closure condition). S1 is shipped;
S2–S6 do not exist. **D-7 item 3 binds the intra-family order: S2 is the one step-state derivation and it GATES
the other surfaces** — S3/S5/S6 explicitly (D-7 item 3), and S4 as the ready-work *projection* of S2's derivation
(it cannot name the attempt before the derivation it reads exists). Each surface below is a **bounded child** at
the same granularity as the other clusters' children. The **engineer picks type/function/file names** (D-3 defers
them deliberately). **No surface migrates the `tasks` schema** — persisting the attempt kind is deferred
**inside** FG-553's store-version policy (OQ-3); `dashboard/` transport stays unaudited (OQ-4).

**S1 — lineage / attempt kind (SHIPPED — not a child).** D-2. `lifecycle-evaluator.ts` `LineageKind` `:22-61`,
`classifyTaskLineage` `:110` (204 lines today — the lineage layer only). Not re-litigable; consumed, not rebuilt.

#### C-FG477-S2 — step-state derivation (ships FIRST; gates S3/S4/S5/S6)

- **OWNING PRD DECISIONS:** N-1 (one step-state derivation; `computeReadyQueue` + `computeStepSettleStates` become
  projections). INV-7 (a validation-contract hold is modeled **ACTIVE, never blocked/terminal** — the
  cross-cluster coupling with B-FG524). D-7 item 3 (S2 gates the other surfaces).
- **ACCEPTANCE ROWS:** N-1 (NORMATIVE-UNMET). INV-7. Acceptance = parity of the ready-queue and settle-state
  projections against today's behavior.
- **FILES / SCHEMAS:** `src/v2/lifecycle-evaluator.ts` (the new step-state surface — stays in `src/v2/`, **NOT**
  under `src/campaign/`, §5.1); reconciles `computeReadyQueue` (`ready-queue.ts:63-134`) and
  `computeStepSettleStates` (`:221-307`) — today two vocabularies agreeing only by hand-maintenance
  (`:169-187`) — into projections of one derivation. **Must admit a pending `on_reject_recovery` row (rule 3,
  `lifecycle-evaluator.ts:96`) as dispatchable in an already-settled phase** — the self-referencing `on_reject`
  (FG-476, `:100-103`). No task-row migration.
- **RED PREREQUISITES:** **NORMATIVE-UNMET** — you cannot falsify an absent module; **no fabricated red.**
  Acceptance is a **parity property test** over the seeded corpus (the harness that made the lineage layer safe,
  `lifecycle-evaluator.test.ts:399-585`): the ready-queue and settle-state projections equal today's behavior on
  every generated shape. FG-553 sensitivity: only the cluster-wide store-version trigger (delta-audit); no S2
  probe of its own.
- **DEPENDENCIES:** **intra-C:** **gates S3/S4/S5/S6** (D-7 item 3 — starting them first grows private
  derivations and the cluster ends with *more* heuristics). **Cross-cluster:** S2 ⇄ B-FG524 hold — coupled, order
  deferred to the map (OQ-6); **either order if both honor `awaiting_gate → ACTIVE`** (INV-7). `A is deliberately
  NOT a consumer` (worktree ownership from the ROW, §5.2b).
- **CONCURRENCY CONSTRAINTS:** touches `lifecycle-evaluator.ts` (C-owned) and its `ready-queue.ts` consumer — no
  A/B shared-file edit here. The `awaiting_gate ∈ {non-terminal, ACTIVE}` mapping is the shared constant with
  B-FG524 and A-FG356 (map §3 consolidated row 10) — all three must agree before any changes a status set.
- **HOLLOW VERSION TO REJECT:** (1) A settle-state that treats "phase settled" as "closed to dispatch" —
  **wedges the self-referencing `on_reject` recovery row forever.** (2) An evaluator that **reads the DB** —
  breaks reconcile's never-throw / no-workflow-in-hand contract and the parity harness (INV-3). (3) Modeling a
  validation-contract hold as **blocked/terminal** instead of ACTIVE (INV-7) — desyncs from B-FG524's held child.

#### C-FG477-S3 — run-state derivation (after S2)

- **OWNING PRD DECISIONS:** N-2 (run-completion's superseded-primary logic becomes evaluator-derived). INV-2
  (`abandoned` is an INPUT, **never resurrected**).
- **ACCEPTANCE ROWS:** N-2 (NORMATIVE-UNMET). INV-2. Acceptance = parity of the run-state projection against
  today's completion behavior.
- **FILES / SCHEMAS:** run-completion's superseded-primary logic (`runNext.ts:298-303`) becomes evaluator-derived.
  The no-resurrection guarantee stays **store-layer** (`completeRun`'s `AND status='active'` `store/runs.ts:147`;
  `updateRunStatus`'s FG-484 refusal `:174-179`) — this child must **not break either guard and must not add a
  third completion-writing path** (map §3 consolidated row 7). No task-row migration.
- **RED PREREQUISITES:** **NORMATIVE-UNMET** — **no fabricated red.** Parity property test over the seeded corpus
  (`lifecycle-evaluator.test.ts:399-585`).
- **DEPENDENCIES:** **intra-C:** after **S2** (D-7 item 3 — a private run-state derivation before the step-state
  one grows a second heuristic). **Cross-cluster:** none; the store-layer guards it must not break are
  OWNED-BY-store-layer (map §3 row 7), a read-only boundary shared with A and B.
- **CONCURRENCY CONSTRAINTS:** touches the `runNext.ts:298-303` run-completion region — **disjoint** from
  `dispatchFanoutStep`'s shared region; no A/B conflict. Must add no completion-writing path to `store/runs.ts`.
- **HOLLOW VERSION TO REJECT:** (1) building it **before S2** (D-7 item 3). (2) Resurrecting an `abandoned` run or
  adding a **third** completion-writing path that bypasses the store-layer guards (INV-2 / map §3 row 7). (3) An
  evaluator that **reads the DB** (INV-3).

#### C-FG477-S4 — ready-work / attempt surface (after S2)

- **OWNING PRD DECISIONS:** N-3 / INV-5 (the surface names the task **ATTEMPT**, not the step; dispatch stops
  re-deriving the pick).
- **ACCEPTANCE ROWS:** N-3 (NORMATIVE-UNMET). INV-5.
- **FILES / SCHEMAS:** `dispatchSingleStep` (`runNext.ts:441-449`) and `dispatchFanoutStep` (`:1572-1574`)
  **stop re-deriving the pick** — they consume S2's derivation. No task-row migration.
- **RED PREREQUISITES:** **NORMATIVE-UNMET** — **no fabricated red.** Parity property test over the seeded corpus.
- **DEPENDENCIES:** **intra-C:** after **S2** — it is the ready-work *projection* of S2's step-state derivation.
  **Cross-cluster:** its `:1572-1574` site is inside `dispatchFanoutStep`, shared with B-FG524 and C-FG527 — the
  `:1572-1574` region itself is **C-only (COEXIST)**, but it participates in the shared-function **COORDINATED**
  rebase (map §2.1 / §3 consolidated row 8; see C-FG527-c).
- **CONCURRENCY CONSTRAINTS:** participates in the `dispatchFanoutStep` shared-function coordination — the
  `:1572-1574` lookup is a C-only region (COEXIST) but rebases with whoever else lands in the function.
- **HOLLOW VERSION TO REJECT:** (1) A ready-work surface that returns **only a step id** — does not kill
  `dispatchFanoutStep`'s destructive re-derivation and silently drops the `on_reject_recovery` attempt (INV-5).
  (2) building it **before S2**. (3) Re-deriving the pick inside dispatch rather than consuming S2's derivation.

#### C-FG477-S5 — terminal-blocker set (after S2; carries A-6's REQUIRED red)

- **OWNING PRD DECISIONS:** N-4 (the lineage-correct failed-primary set; **SHARED-wins**; **deterministic** local
  tiebreak). A-6 (factual defect feeding this surface).
- **ACCEPTANCE ROWS:** N-4 (NORMATIVE-UNMET); A-6 (factual defect, **INFERENCE-only, red REQUIRED**).
- **FILES / SCHEMAS:** the aggregation exists and is correct (`executor.ts:496-503`; `isSharedBlocker →
  "hold_campaign"` `policy.ts:139-141`) — **what is wrong is the ROW SET** (`executor.ts:494`/`:2183`: raw
  `parentId === undefined && status === "failed"` admits a failed **ad-hoc invoke** into a workflow's blocker
  set). Fix the local tiebreak's **array-order nondeterminism** (`executor.ts:497`). `BlockerKind` vocabulary
  **stays in `types/`** (`:291-303`); `policy.ts` stays a translation layer (§5.1). No task-row migration.
- **RED PREREQUISITES:** N-4 **NORMATIVE-UNMET** — **no fabricated red.** **A-6 is INFERENCE-only and its red is
  REQUIRED before its fix ships** — predicates verified at `executor.ts:494`/`:497`/`:2183` and
  `runNext.ts:298-303`, runtime manifestation unconfirmed; **if the probe shows it does not manifest, it is
  DROPPED, not fixed** (PRD §7.1). **FG-553 sensitivity (map §5 / C §8):** IF the store-version policy admits >1
  Forge version writing one store, A-5's marker bound and this surface's / A-6's classifier determinism must be
  re-verified (two versions can disagree about one row). FG-553's exec-not-spawn work is **explicitly NOT a
  trigger**.
- **DEPENDENCIES:** **intra-C:** after **S2** (D-7 item 3). **Cross-cluster:** none direct; the store-version
  trigger is the FG-553 delta-audit gate.
- **CONCURRENCY CONSTRAINTS:** touches `executor.ts`'s blocker aggregation — **disjoint** from A/B regions; no
  shared-file conflict.
- **HOLLOW VERSION TO REJECT:** (1) building it **before S2** (D-7 item 3). (2) "Fixing" A-6 while keeping the
  **array-order-dependent** local tiebreak (`executor.ts:497`) — a latent nondeterminism, not a fix. (3)
  Rewriting the aggregation (which is **correct**) instead of narrowing the **row set**. (4) An evaluator that
  **reads the DB** (INV-3).

#### C-FG477-S6 — operator-reason API contract (after S2)

- **OWNING PRD DECISIONS:** N-5 (an **API contract** to `show`/`report`/dashboard/campaign, **NOT** an internal
  union).
- **ACCEPTANCE ROWS:** N-5 (NORMATIVE-UNMET). Acceptance = a validation-contract hold renders **distinctly** from
  a human gate, with no internal union crossing the client boundary.
- **FILES / SCHEMAS:** renders a validation-contract hold **distinctly** from a human gate (`runNext.ts:977-981`).
  **Do NOT ship the evaluator's internal step-state union to the client** (else every new state is a
  client-breaking change). `dashboard/` transport is unaudited (OQ-4). No task-row migration.
- **RED PREREQUISITES:** **NORMATIVE-UNMET** — **no fabricated red.** Contract test that a hold renders distinctly
  from a human gate and no internal union leaks to the client.
- **DEPENDENCIES:** **intra-C:** after **S2** (it consumes the step-state derivation to render the reason).
  **Cross-cluster:** none; `dashboard/` transport is OQ-4 (unaudited).
- **CONCURRENCY CONSTRAINTS:** touches the `runNext.ts:977-981` reason-rendering plus `show`/`report`/dashboard
  consumers — no A/B shared-file conflict.
- **HOLLOW VERSION TO REJECT:** (1) Shipping the **internal step-state union to the client** — every new state
  becomes a client-breaking change (N-5). (2) Rendering a validation-contract hold **identically** to a human
  gate. (3) building it **before S2**.

**FG-477 family closure (§7.3 — spans all surfaces, no single child claims it).** FG-477 closes only when **all
five surfaces exist as projections of one derivation**, INV-1's allowlist is **EMPTY** (but for `project-auth.ts:79`
and `retry.ts:263`), and the three "is this a fanout parent?" structural probes (`gate.ts:178`,
`reconcile.ts:1261-1263`, `recover.ts:285`) + the raw gate (`reconcile.ts:1120`) are **gone**. Cross-surface
invariants every child must honor: `reconcile` consumes **only** the workflow-free primitives (INV-3,
`lifecycle-evaluator.ts:192-201`) and must never throw; **A is deliberately NOT a consumer** (§5.2b) — the
non-dependency that keeps A independent of C; the gate-blocking predicate `verdictBlocksGate` (`gate.ts:59-65`)
**stays in `gate.ts`** and B edits it **in place** — the two clusters must **not fork it** (a fork re-opens the
F16 divergence FG-523 closed, map §3). **Hollow at the family level:** folding `BlockerKind` into the evaluator
pushes campaign policy into a module `ready-queue`/`gate`/`runNext`/`reconcile` all depend on (§5.1); adding a
**fourth** structural lineage probe to reconcile is forbidden by A/C both (§5.2b).

---

## Not in scope of this proposal

- **No tickets are allocated.** This document proposes slices; the primary orchestrator decides what becomes a
  ticket, in what order, on what branch. Decomposition into real work items is **gated on each PRD passing
  adversarial review** (A §10, B §6 non-goal, C §7.3) and on the **post-FG-561 delta-audit** passing
  (Deliverable 2).
- **No normative decisions are invented.** Every "must/owns/refuses" above is a citation of a PRD id or the
  integration map; where the PRDs leave a seam unowned (OQ-INT-1, OQ-INT-2) this proposal carries it as
  unresolved, it does not resolve it.
- **No PRD or source is edited by this document.**

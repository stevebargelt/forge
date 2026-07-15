# Cross-plan integration MAP — FG-561 foundations campaign

**This is a MAP, not a contract.** It does not restate, add to, or override the three cluster PRDs. Every
binding decision lives in a PRD; this document only shows where the three clusters **touch**, who **owns** each
shared line of semantics, and what **order** their eventual implementation children must land in. Where a claim
is a citation of a reviewed PRD it is labelled **VERIFIED (via PRD)**; where it is this map's reasoning about how
the three compose it is labelled **INFERENCE**; genuinely unsettled seams are **OPEN QUESTION (operator)**.

**The three normative surfaces (authoritative; cited, never restated):**

- **Cluster A — Agent workspace isolation** — `docs/prds/agent-workspace-isolation.md`
  (FG-559 git-capable mount + D6 detector + D10 blue seam · FG-345 remaining scope · FG-356 terminal/orphan reaper).
- **Cluster B — Review execution trust** — `docs/prds/review-execution-trust.md`
  (FG-566 provisioning · FG-541 push policy · FG-524 fanout-child gate + re-aggregation · FG-525 invoke/crash gate · INV-1 finalize-site census).
- **Cluster C — Workflow lifecycle semantics** — `docs/prds/workflow-lifecycle-semantics.md`
  (FG-477 lifecycle evaluator S1–S6 · FG-527 classifier migration of `retry.ts` / `dispatchFanoutStep`).

The three `docs/plans/foundations-lane-*.md` discovery plans are evidence only and are **superseded where they
differ from their PRD** (each PRD §0). This map cites PRDs, not plans.

---

## Architecture — the shared surfaces and who owns each

```mermaid
graph TD
  subgraph SHARED["SHARED SURFACES — where the three clusters collide"]
    DFS["runNext.ts dispatchFanoutStep<br/>parent lookup + child filters + child finalize"]
    REC["reconcile.ts<br/>orphan finalize tail + crash-recovery finalize"]
    ROW[("Task row: worktreePath · status · failure kind<br/>NO cluster migrates this schema")]
    VC["validation-contract.ts + finalize EVENT sites<br/>(INV-1 census)"]
    EVAL["lifecycle-evaluator.ts<br/>lineage classifier (S1 shipped) + S2–S6 (unbuilt)"]
  end

  C(["Cluster C — lifecycle"]) -->|"OWNS lineage classification;<br/>D-5a ad-hoc exclusion + D-5b kills red- prefix"| DFS
  B(["Cluster B — trust"]) -->|"D3 child gate + re-aggregation;<br/>consumes role-scoping, must NOT re-add red-"| DFS
  C -->|"OWNS finalizeOrphanedPrimaries + fanout sweeps"| REC
  A(["Cluster A — workspace"]) -->|"D9 NEW terminal-task reaper (row-based)"| REC
  B -->|"D4 crash-recovery sweeper-decline"| REC
  A -->|"reads worktreePath+status+kind (reaper predicate)"| ROW
  B -->|"awaiting_gate held-child retain→reclaim (N-9)"| ROW
  C -->|"reds MUST have NULL worktreePath (D-5b guard)"| ROW
  B -->|"OWNS the trust gate; INV-1 finalize census"| VC
  C -->|"OWNS the lineage classifier B's role/lineage split leans on"| EVAL
  VC -.->|"consumes IMPLEMENTER_ROLES + run-kind (existing surfaces),<br/>NOT C's unbuilt S2–S6"| EVAL
  A -.->|"deliberately NOT a consumer — keys on the ROW, never lineage (C §5.2b)"| EVAL
  REC -.->|"workflow-free primitives ONLY (INV-3 purity)"| EVAL
```

The dashed edges are the load-bearing claims: **A is deliberately not a consumer of C's evaluator** (it answers
worktree ownership from the row — C §5.2(b) — which is what keeps the two clusters independent); **B consumes
role/run-lineage signals that already ship, not C's unbuilt surfaces** (§2.4 below); and **reconcile may use only
C's workflow-free primitives** because it holds no workflow by design (C INV-3).

---

## 1. Cross-cluster dependencies

The dependency verb below is "X's work must land or be verifiable before Y's." Each cites the PRD decision that
creates it.

| Dependency | Direction | Why (cited) | Strength |
|---|---|---|---|
| **D1** | **C-FG527 (D-5b) ⇄ B-FG524 — shared `dispatchFanoutStep`** | Both edit `dispatchFanoutStep`'s child filters `runNext.ts:1620-1626` and `:1668-1671` (B §9.1, C §5.2(a), both VERIFIED via plan §7.1) — a **shared-file overlap**. There is **no semantic prerequisite** (VERIFIED, B §9.1): B's child gate is **role-scoped and unconditional** — it calls the `IMPLEMENTER_ROLES`-scoped evaluator (`validation-contract.ts:53`), never the `agentRole.startsWith("red-")` heuristic. B §9.1 verbatim: "FG-524 must not ask that question at all — the evaluator is already role-scoped (`IMPLEMENTER_ROLES` excludes reds) … adds no lineage dependency." So B is **robust to** C-FG527's `red-` prefix removal (C D-5b): `IMPLEMENTER_ROLES` excludes reds regardless of the prefix. **B landing first does NOT re-introduce the prefix or regress C's shrinking allowlist** — B never uses the prefix. But **both edit the same function region** (`:1620-1626`, `:1668-1671`), so whichever lands second requires a **COORDINATED rebase** — a deliberate re-verification of the child-filter semantics after the other's migration — **NOT** a routine/automatic one. | **Shared-file merge coordination.** **VERIFIED: no SEMANTIC dependency** (B §9.1 — the gate is role-scoped via `IMPLEMENTER_ROLES`). **INFERENCE: the conclusion that they are therefore PARALLELIZABLE** — it follows from the no-semantic-dep fact but is this map's reasoning, not a PRD citation. **The shared-`dispatchFanoutStep` overlap is a COORDINATED rebase, not a routine/trivial one** (both change the same lines; see §2.1, §4). |
| **D2** | **B-INV-1 needs no C surface** | B's finalize-EVENT census keys on `isInvokeLikeRun`/`taskHasPipelineFinalize` (`run-kind.ts`) and `IMPLEMENTER_ROLES` (`validation-contract.ts:53`) — B §2 / INV-1, VERIFIED. Those are **shipped** surfaces, **not** C's unbuilt S2–S6. | **None** — B-INV-1 is independent (see §2.4, §4-Q3). |
| **D3** | **A-FG356 vs B-FG524** | A's reaper is a **terminal-task-only** pass (A D9) and B's held child is `awaiting_gate` = **non-terminal** (B D3/N-9). A's own predicate already excludes it (D9 terminal filter + D9b clause (c) "not terminal → RETAIN"). B N-9(a) additionally requires the reaper treat `awaiting_gate` as a live child state. | **Weak** — one shared constant to agree on (`awaiting_gate` ∈ non-terminal). PARALLELIZABLE (see §4-Q2). |
| **D4** | **C-S2 union ⇄ B-FG524 hold** | Coupled, order **deferred to this map by C OQ-6**. The invariant either order must preserve: S2 models a held child as **ACTIVE, never blocked/terminal** (C INV-7 / §5.2(a)). The pre-existing `awaiting_gate` status (B D3: no schema migration — status + payload already exist) **decouples** them: C can model `awaiting_gate → ACTIVE` and B can populate it, in either order, provided both honor that mapping. | **Soft** — decoupled by the pre-existing status (see §4). |
| **D5** | **A-FG559 before B-FG566 ownership predicate** | FG-566's "provision only a Forge-owned workspace" predicate must be written against whatever FG-559 lands as a Forge-owned workspace — linked worktree vs standalone clone (B §9.3, VERIFIED). FG-566 does **not** fix git-in-container and FG-559 does **not** fix deps — distinct contracts; the only coupling is the workspace **definition**. B provisions host-side into `ctx.projectDir` (B D1.3 / INV-4), which exists regardless, so provisioning itself is not blocked. | **Soft** — predicate shape only; parallelizable with a late bind. |

**INFERENCE (D1 is an intra-C ordering + a shared-function rebase, not a cross-cluster serialize).** C's own
internal `dispatchFanoutStep` sequence is fixed by C D-7: the `retry.ts` correction (D-1/D-4) first, then D-5a
(ad-hoc exclusion, three sites) **before** D-5b (`red-` prefix removal). That D-5a → D-5b order is **intra-C**
and preserved. **B-FG524 is not serialized behind it** — B and C share the function, so whichever lands second
rebases. **VERIFIED:** there is **no semantic dependency** (B's gate is role-scoped, B §9.1), so neither order
re-adds the prefix or regresses the allowlist. **But the rebase is COORDINATED, not routine:** both edit the
same lines (`:1620-1626`, `:1668-1671`), so the second to land must **deliberately re-verify the child-filter
semantics against the other's migration** — it is not a purely textual/mechanical merge. **That either order is
therefore "safe" is INFERENCE** (this map's reasoning from the no-semantic-dep fact), not a PRD-verified claim.
The PRDs state the overlap and defer the ordering to this artifact (C §5.2 opening; C OQ-6).

---

## 2. Overlapping files / schemas — the load-bearing section

### 2.1 `src/v2/runNext.ts` — `dispatchFanoutStep` (VERIFIED: function at `runNext.ts:1549`)

The **sharpest collision in the program** (C §5.2(a)). Same function, edited by C-FG527 and B-FG524.

| Region (VERIFIED lines) | Cluster C — FG-527 | Cluster B — FG-524 | Verdict |
|---|---|---|---|
| `existingParent` lookup `:1572-1574` | D-5a: add FG-507 ad-hoc exclusion so an operator's `forge invoke` row is invisible; mint a fresh fanout parent | — | **COEXIST** (C only) |
| `childTasksForCleanup` `:1620-1626` | D-5b: rewrite predicate — child identity from evaluator, drop `red-` prefix | D3: change **semantics** — a held child must be **retained**, not swept (today filters `status === "complete"`) | **CONFLICT** (same lines, both change) |
| re-entry branch `:1668-1671` (`pendingHasChildren`) | D-5b: rewrite the `red-` predicate | D3: **replace the branch outright** to re-aggregate (today returns `existingParent.status` and stops) | **CONFLICT** (same lines, both change) |
| child finalize `markTaskComplete` `:2541` | — | D3: add validation-contract gate + `held` `ChildOutcome` variant (`:2353`) | **COEXIST** (B only; disjoint region) |

**The semantic seam and its trap (VERIFIED via B §9.1).** The naive way to ask "implementer child (gate) vs
red child (exempt)?" at finalize is `agentRole.startsWith("red-")` — **the exact heuristic C-FG527 is deleting.**
B's boundary decision (B §9.1): FG-524 must **not** ask that question at all — the validation evaluator is already
role-scoped (`IMPLEMENTER_ROLES` excludes reds, `validation-contract.ts:53`), so calling it unconditionally at the
child finalize lets *role* do the exempting, adds no lineage dependency, and is strictly less code.

**Which lands first, and how coordinated is the rebase.** **VERIFIED: no SEMANTIC dependency** — there is **no**
hard requirement that C-FG527 land first; B's gate is role-scoped, so it never re-adds the prefix regardless (see
the seam below). **INFERENCE (this map, not a PRD citation): the conclusion that either order therefore works is
reasoning, not verified fact — and the rebase is COORDINATED, not routine.** At `:1620-1626` B layers a
retain-on-held semantic onto C's classifier-based predicate — the two changes must be **reconciled deliberately**,
and the child-filter semantics **re-verified** after the other's migration; it is **not** a trivial/mechanical
merge even though child identity is classifier-based. At `:1668-1671` it is emphatically **not** a trivial rebase
— both clusters rewrite the **same branch** (C swaps the predicate; B replaces the branch body with
re-aggregation), so this is a **coordinated change requiring deliberate re-verification**, not a mechanical merge.
Only the child-gate at `:2541` is disjoint and rebases trivially — that region is **not** the coordinated seam.

### 2.2 `src/v2/reconcile.ts` — three clusters, mostly disjoint regions

| Cluster | Touch (VERIFIED lines) | Nature |
|---|---|---|
| **A — FG-356** | NEW terminal-task **reaper pass** appended to `reconcileRun`'s tail (A D9); reads the Task row only (A D9a — **no FS scan**). Must **not** touch the running-only loop `reconcile.ts:452` (A §4). Prunes branch `forge/<runId>/<taskId>` under the same predicate (A D9d). | additive tail pass |
| **C — FG-477/527** | Owns `finalizeOrphanedPrimaries` (`reconcile.ts:1361`, on `isPhasePrimaryRow`) and the fanout-parent sweeps (`:1120`, `:1261-1263`); migrates them to the classifier (C §5.2(b)). | in-place migration |
| **B — FG-525** | Crash-recovery gate at `reconcile.ts:779`/`:880` (complete an invoke-like task when `isInvokeLikeRun`) as a **sweeper-decline** (leave non-terminal, `failPipelineUnfinalized` shape) — B D4 / INV-1. | in-place gate |

**Verdict: COEXIST textually** (different line regions) **with three semantic convergences that must be
preserved (INFERENCE, reconciling the three PRDs):**

1. **A keys on the row; C keys off lineage — deliberately non-overlapping.** C §5.2(b) binds "worktree ownership
   is answered from the ROW (`worktreePath` presence), **never** from lineage," and A D9a independently mandates
   "the Task row, and nothing else." **They agree by construction.** The stated risk (C §5.2(b)) is that A adds a
   *fourth* structural lineage probe to reconcile — which A D9a already forbids. No action beyond honoring both.
2. **A's reaper and C's `finalizeOrphanedPrimaries` are the same tail of the same function** (C §5.2(b)). C may
   finalize an orphaned primary to a terminal status; A's reaper then reads that now-terminal row and may reap its
   worktree. Because A's reaper is idempotent and state-free (A I-7), intra-pass ordering is not load-bearing.
3. **B's sweeper-decline keeps a contraband task NON-terminal** (D4). A's terminal-only reaper therefore leaves
   its worktree alone — the correct outcome (unresolved contraband is retained). **B's decline and A's
   terminal-filter compose safely with no coordination.**

### 2.3 The Task row — `worktreePath` / `status` / `merge_conflict` failure kind (three clusters, one row)

**No cluster migrates the `tasks` schema** — A §4 ("no schema change, no new column"), B §5 ("no task-row / `tasks`
schema migration"), C §6/OQ-3 ("do not persist the attempt kind … blocked behind FG-553"). All three lean on the
`awaiting_gate` status + payload **already existing** (B D3, VERIFIED plan §1.3). This shared no-migration stance
is itself a cross-cutting constraint (see §5).

**Reads / writes map:**

| Column / value | A (workspace) | B (trust) | C (lifecycle) | Where they MUST agree |
|---|---|---|---|---|
| `worktreePath` | **reads** — reaper predicate (D9a/b) | **relies on** — held child retains its worktree, reclaims later (N-9) | **reads** — reds MUST carry **NULL** `worktreePath`; binds a **guard test** that fails if a red ever acquires one (D-5b) | Writers are the **workspace/dispatch** path (children get one at `runNext.ts:2505/:2559`; reds get none at `:1298-1308`, VERIFIED via C D-5b). B and C only **read**. No write conflict. |
| `status` (the "terminal" line) | reaper fires only on **TERMINAL** status (D9) | introduces `awaiting_gate` as a **live non-terminal** fanout-child state (D3/N-9) | S2 must model `awaiting_gate` as **ACTIVE**, never blocked/terminal (INV-7) | **All three must treat `awaiting_gate` as non-terminal / ACTIVE.** If any treats it as terminal → premature reap (A), or a permanent wedge (C settle logic reads it "not terminal forever"). |
| `merge_conflict` failure kind | **reads** — in the INSPECTION-RETAIN set → **retain** the worktree (D9b, `failure-kind.ts:125-143`); adds **no** kind (A §4) | — | **reads** — `merge_conflict` → **SHARED** blocker → holds the whole campaign (S5, `policy.ts:144`; C §5.2(b)) | Same kind, two disjoint consumers → COEXIST — but the shared membership SET is **COORDINATED — sub-case (a)** (§3.0 row 6). **Neither may broaden `merge_conflict`'s membership unilaterally** — C §5.2(b) warns broadening it broadens campaign holds and says that decision "should be in the worktree ticket, not discovered in a campaign." |

### 2.4 `src/v2/validation-contract.ts` + the finalize sites — the consumer contract B needs from C

**B owns the trust gate; C owns lineage classification** (B §2/INV-1; C D-2). The task asks whether B's
finalize-event enumeration needs C's evaluator surface to exist first. **INFERENCE, and the answer is nuanced:**

- **B's INV-1 census is buildable on already-shipped surfaces.** It classifies each finalize EVENT by run-lineage
  (`isInvokeLikeRun` / `taskHasPipelineFinalize` in `run-kind.ts`) and role (`IMPLEMENTER_ROLES`,
  `validation-contract.ts:53` — VERIFIED, `IMPLEMENTER_ROLES` present at `validation-contract.ts:32/53`). These
  are **existing** modules, **not** C's unbuilt S2–S6 surfaces. So **B's finalize-site guard (INV-1 / N-1) does
  NOT depend on C's new evaluator surfaces existing first.** It is B's highest-leverage, first-to-land item (B D5)
  and can proceed in parallel with C's retry.ts work.
- **B does not lean on C's classifier even inside `dispatchFanoutStep`.** B's per-child gate (D3, `:2541`) must
  identify a fanout implementer child. B §9.1 binds that this be role-scoped (`IMPLEMENTER_ROLES`), **not** the
  `red-` prefix — so it derives child identity from B's **own shipped surface** (`validation-contract.ts:53`),
  not from C's classifier. It is therefore **aligned with** C-FG527's prefix removal (they do not fight) but does
  **not depend on it**: B's gate works whether or not C has landed, because `IMPLEMENTER_ROLES` excludes reds
  regardless of the prefix. So **neither B's *child-gate site* nor B's *census* wants C-FG527 first** — the only
  B↔C coupling in this function is a **shared-file rebase** (D1), not a semantic prerequisite.
- **The consumer contract, stated:** C must not change the semantics of the shipped lineage layer / `run-kind` in
  a way that reclassifies which finalize events are implementer-reachable, and C-FG527's prefix deletion (D-5b)
  must not leave a window where a red is transiently mis-scoped. This is a **non-regression** contract, not a
  build-ordering "C's surface must exist first." B's census over the seven+ enumerated finalize classes (B §2
  table) is self-contained on existing surfaces.

### 2.5 `src/v2/lifecycle-evaluator.ts` — C owns; note the (non-)consumers

**VERIFIED:** the file is **204 lines** today (confirmed) — the shipped **S1 lineage layer only**
(`classifyTaskLineage`); S2–S6 do not exist yet (C §7.2). Consumers:

- **reconcile** consumes **only** the workflow-free primitives (C INV-3 / `lifecycle-evaluator.ts:192-201`) — it
  holds no workflow by design and must never throw.
- **A is deliberately NOT a consumer** — its reaper answers worktree ownership from the row (C §5.2(b) / A D9a).
  This non-dependency is the architectural guarantee that keeps the workspace cluster independent of the lifecycle
  cluster.
- **B is at most an indirect consumer** — it uses `IMPLEMENTER_ROLES` (its own file) and `run-kind.ts`, not the
  new S2–S6 surfaces (§2.4).
- The real consumers of the new surfaces are C's own migration targets: `ready-queue`, `gate`, `runNext`,
  `campaign/policy` (C Architecture diagram). `campaign/policy` stays a **translation layer** — `BlockerKind`
  vocabulary stays in `types/` (C §5.1); the evaluator returns lifecycle facts, campaign maps them to policy.

---

## 3. Ownership conflicts — who decides, who conforms

### 3.0 CONSOLIDATED ownership/conflict classification (every cross-cluster touch, one row)

**One row per cross-cluster shared surface**, classified into exactly one of **three classes**:

- **OWNED-BY-`<owner>`** — the semantics are decided by **one owner** — a cluster's PRD, **or** a pre-existing
  store/infrastructure **invariant** (not owned by any single cluster's PRD) — and the others conform.
- **COORDINATED** — a shared surface, region, or constant that **no single cluster owns the merge of**, in one of
  two sub-cases. **(a) SAME-REGION:** two or more clusters touch the same lines (or must agree on the same
  constant), so the file edit requires a coordinated rebase — the second to land **re-verifies against the
  other's change** rather than merging mechanically (e.g. `dispatchFanoutStep`, row 8; the shared constant,
  row 10). **(b) DISJOINT-REGION, JOINT INVARIANT:** the edits fall in disjoint line regions and merge textually
  trivially, **but** a shared **semantic invariant must be jointly preserved** across the clusters and no single
  cluster's PRD can verify it alone (e.g. `reconcile.ts`, row 9). The per-row **semantic** ownership may still be
  stated (e.g. child identity is OWNED-BY-C); COORDINATED names only that the *merge* — textual (a) or
  semantic (b) — crosses cluster boundaries. **Every COORDINATED row must cite the sub-case it is.**
- **UNOWNED** — no PRD closes it; it needs an operator decision.

This table consolidates the §1 dependencies, the §2 file/schema overlaps, and the detailed ownership rows in §3.1
below into a single classification. Evidence labels: **VERIFIED (via PRD)** / **INFERENCE** / **OPEN QUESTION**.

| # | Shared surface | Clusters that touch it | Classification — who decides / who conforms (or the operator decision needed) | Basis |
|---|---|---|---|---|
| **1** | Fanout **child identity** in `dispatchFanoutStep` (`:1587`/`:1624`/`:1669`) | C (D-5b), B (D3 gate) | **OWNED-BY-C.** C decides identity comes from the evaluator, never a `red-` prefix. **B conforms** — calls the role-scoped evaluator unconditionally, introduces **no** `red-` check. | VERIFIED — C D-5b; B §9.1 |
| **2** | **Lineage classification** vs the **trust gate** that consumes it | C (lineage), B (gate) | **OWNED-BY-C** (lineage). **B conforms** — the gate consumes lineage/role; it does not re-derive lineage. | VERIFIED — C D-2; B §2 |
| **3** | The **held-child state** `awaiting_gate` | B (owns the hold), C (models it), A (must not reap it) | **OWNED-BY-B** (the *hold*, FG-524 D3). **C conforms** — models it ACTIVE in S2 (INV-7); **A conforms** — treats it as live/non-terminal, never reaps it. | VERIFIED — B D3/N-9; C INV-7; A D9 |
| **4** | **Worktree ownership** in `reconcile` | A (row-based predicate), C (lineage sweeps) | **OWNED-BY-A** (row-based, D9a). **C conforms** — worktree ownership answered from the ROW, never lineage. *Convergence, not conflict* — both agree by construction. | VERIFIED — A D9a; C §5.2(b) |
| **5** | `verdictBlocksGate` gate-blocking predicate (`gate.ts:59-65`) | C (owns placement), B (edits in place) | **OWNED-BY-C** (placement — stays in `gate.ts` until C relocates it). **B conforms** — edits it **in place**; the two clusters must **NOT fork it** (a fork re-opens the F16 divergence FG-523 closed). | VERIFIED — C §5.2(c) |
| **6** | `merge_conflict` failure-kind **membership** | A (retains on it), C (holds campaign on it) | **COORDINATED — sub-case (a): SAME-REGION** (both clusters must agree on the shared `merge_conflict` membership SET, like the `awaiting_gate` constant, row 10). The two consumers are **disjoint and COEXIST** — each cluster's own consumer is **OWNED**: A **retains** the worktree on it (D9b, per row 4), C holds the **whole campaign** on it as a SHARED blocker (S5, `policy.ts:144`). But the membership SET *itself* is shared: **neither may broaden it unilaterally**, because broadening it broadens campaign holds (C's SHARED-blocker), so any change to the set requires **joint agreement** — "should be in the worktree ticket, not discovered in a campaign" (C §5.2(b)). | VERIFIED — A §4 ("adds no kind") / D9b; C §5.2(b), S5 (`policy.ts:144`) |
| **7** | **Run completion writes** (no-resurrection) | A, B, C (all must not cross) | **OWNED-BY-store-layer** — a **pre-existing store invariant** (no-resurrection: `completeRun`'s `AND status='active'` `store/runs.ts:147`; `updateRunStatus`'s refusal `:174-179`), **not owned by any single cluster's PRD**. **All three clusters conform** — none may add a **third** completion-writing path. | VERIFIED — C INV-2/S3 |
| **8** | **Shared `dispatchFanoutStep` function region** (`:1620-1626`, `:1668-1671`) — B-FG524 ⇄ C-FG527 | B (D3), C (D-5b) | **COORDINATED.** The **semantic** ownership is settled — **child identity is OWNED-BY-C** (D-5b: from the evaluator, never a `red-` prefix), and **B conforms** (role-scoped gate, B §9.1). But the **file edit** is coordinated: both clusters change the same lines, there is no *semantic* dependency (VERIFIED — B §9.1) and the parallelizable conclusion is **INFERENCE**, so the second to land does a **COORDINATED — sub-case (a): SAME-REGION** rebase — re-verify child-filter semantics against the other's migration — **not** a routine/automatic one (see §4, D1). | VERIFIED (semantic: child identity OWNED-BY-C; no semantic dep) + INFERENCE (parallelizable / rebase) |
| **9** | `reconcile.ts` tail (`reconcileRun`) — reaper vs `finalizeOrphanedPrimaries` vs crash-recovery gate | A (D9), C (FG-477/527), B (D4) | **COORDINATED — sub-case (b): DISJOINT-REGION, JOINT INVARIANT.** Each cluster owns its own region so the merge is textually trivial, **but** three semantic convergences must all hold and no single PRD verifies them alone: A keys on ROW / C on lineage; A reads C's finalized row idempotently; B's decline keeps contraband non-terminal so A leaves it. | INFERENCE (reconciling the three PRDs) — §2.2 |
| **10** | The constant `awaiting_gate ∈ {non-terminal, ACTIVE}` | A, B, C | **COORDINATED — sub-case (a): SAME-REGION** (a shared constant all three must agree on) before any of them changes a status set. If any treats it as terminal → premature reap (A) or permanent wedge (C). | VERIFIED — A D9; B D3/N-9; C INV-7 |
| **11** | **FG-527 ticket AC-2** — "a failed shipping-reviewer (non-`red-`-prefixed red) on a fanout step is retryable as `red_review`" | C (corrects it), B (adopts the fanout adopting the minted primary) | **OWNED-BY-C — AC-2 AS WRITTEN IS REJECTED.** PRD-c owns the correction: migrating retry to **allow** a red retry mints a **detached primary the fanout adopts** as parent of a fresh wave (probe p2); **PRD-c D-4 REFUSES it** — classify with the evaluator and **KEEP REFUSING**, refuse under `--force` too. FG-527's AC #2 is **amended to D-1**. **A PRD that quietly inherits AC-2 ships this bug.** | VERIFIED — C §2 / D-1 / D-4 (`retry.ts:427-466`; p2) |
| **12** | `retry.ts:263` **fail-open mount-mode fallback** (a non-prefixed red gets a **writable** mount) | C (flags, does not fix), A (security boundary D2/D10) | **UNOWNED.** **Operator must decide:** does `retry.ts:263`'s mount-mode fallback fall inside **Cluster A's D2/D10 security boundary**, or is it a **separate finding needing its own owner**? Confirm A's D10b keys the pointer-freeze on **mount-mode** (rw ⇒ freeze), not on "is this a blue agent," so the mitigation actually covers a fail-open red. **The fail-open grant itself (a red becoming rw at all) is owned by neither A nor C.** | OPEN QUESTION — carried from §3.2 OQ-INT-1 (C D-6/OQ-2 VERIFIED; A-boundary fit INFERENCE) |
| **13** | **Held-child worktree reclaim at RUN-END** (run ends with the child still `awaiting_gate`) | B (N-9(b) requires reclaim), A (reaper is terminal-only) | **UNOWNED.** A's FG-356 reaper is **terminal-only**; a still-held child is **non-terminal**, so A's reaper **never reclaims it**. Neither PRD nails the run-end arm. **Operator/decomposition must decide:** either **(i)** run-end/abandon **terminalizes** held children (then A's reaper collects them next pass), or **(ii)** **Cluster B owns the run-end reclaim path** directly. This is the one held-child seam A's design does not close. | OPEN QUESTION — carried from §3.2 OQ-INT-2 (B N-9(b) VERIFIED; the gap INFERENCE) |

**Reading the table (by class):** rows 1–5 and 7 are **OWNED-BY** a single owner (a cluster's PRD for rows 1–5, the
pre-existing store invariant for row 7 — the owner decides, the others conform). Rows 6, 8–10 are **COORDINATED**
(a shared region/constant no single cluster owns the merge of — rows 6, 8 & 10 are sub-case (a) SAME-REGION, row 9 is
sub-case (b) DISJOINT-REGION/JOINT-INVARIANT; the map sequences them — §2, §4). Row 6's per-cluster consumers stay
OWNED (A's retention, C's campaign hold), but the shared `merge_conflict` membership SET no single cluster owns the
merge of. Row 11 is **OWNED-BY-C** (AC-2 rejected-and-corrected). Rows 12–13 are the two
genuinely **UNOWNED** seams — **OQ-INT-1 and OQ-INT-2 need an operator decision no PRD makes.**

### 3.1 Detailed ownership rows (the settled surfaces above, with full basis)

| Shared semantics | OWNS | CONFORMS | Basis (cited) |
|---|---|---|---|
| Fanout **child identity** in `dispatchFanoutStep` | **C** (D-5b: identity from the evaluator, never a role-name prefix) | **B** — calls the role-scoped evaluator unconditionally; introduces **no** `red-` check (B §9.1) | C D-5b; B §9.1 |
| **Lineage classification** vs the **trust gate** that consumes it | **C** (lineage) | **B** (the gate consumes lineage/role — B §2/INV-1) | C D-2; B §2 |
| The **held-child state** (`awaiting_gate`) | **B** owns the *hold* (FG-524 D3) | **C** must *model* it as ACTIVE in S2 (INV-7); **A** must treat it as live/non-terminal (won't reap) | B D3/N-9; C INV-7/§5.2(a); A D9 |
| **Worktree ownership** in reconcile | **A** (row-based predicate, D9a) | **C** agrees — ownership from the row, never lineage (§5.2(b)) | A D9a; C §5.2(b) — *convergence, not conflict* |
| `verdictBlocksGate` gate-blocking predicate (`gate.ts:59-65`) | **C** owns placement — stays in `gate.ts` until C relocates it (§5.2(c)) | **B** edits it **in place**; the two clusters must **not fork it** (a fork re-opens the F16 divergence FG-523 closed) | C §5.2(c) |
| `merge_conflict` failure-kind membership | **COORDINATED — sub-case (a):** the membership SET is **shared**; neither may broaden it unilaterally (broadening broadens campaign holds) | A retains on it (D9b) and C holds the campaign on it (S5) — **disjoint consumers that COEXIST**, each OWNED per-cluster; any change to the SET requires joint agreement | A §4 ("adds no kind") / D9b; C §5.2(b), S5 |
| **Run completion writes** (no-resurrection) | **store layer** owns the guarantee (`store/runs.ts:147`, `:174-179`) | all clusters must **not add a third completion-writing path** (C INV-2) | C INV-2/S3 — a boundary A and B must not cross |

### 3.2 Genuine unresolved ownership → OPEN QUESTIONS for the operator

**These two are the UNOWNED rows (12, 13) of the consolidated table above.** They are the only cross-cluster
seams no PRD closes; every other surface in §3.0 is owned or coordinated.

- **OQ-INT-1 — `retry.ts:263` fail-open mount mode has no owner, and it collides with A's security boundary.**
  C D-6 / OQ-2 (VERIFIED) flags that `retry.ts:263`'s prefix fallback fails **OPEN**: a **non-prefixed red gets a
  writable mount**, "plausibly a security finding for another cluster … flagged, not fixed. It needs an owner, and
  it does not have one." **INFERENCE (this map):** a non-prefixed red with a *writable* `/project` is exactly A
  D10's "any agent whose `/project` is writable" attacker-controlled-pointer class — A's D10b pointer-freeze
  *would* mitigate the RCE **if A keys the freeze on mount-mode (rw ⇒ freeze), not on "is this a blue agent."**
  But the fail-open **grant itself** (a red becoming rw at all) is owned by neither A nor C. **Operator must
  decide:** does `retry.ts:263`'s mount-mode fallback fall inside Cluster A's D2/D10 security boundary, or is it a
  separate finding needing its own owner? Confirm A's D10b keys on mount-mode so the mitigation actually covers a
  fail-open red.

- **OQ-INT-2 — who reclaims a held child's worktree when the run ends with the child still held?**
  B N-9(b) requires the worktree be **reclaimed, never leaked**, "once the held child resolves and the parent
  finalizes, **or the run ends** with the child still held." **INFERENCE (this map):** A's FG-356 reaper is
  **terminal-only** (D9); a still-held child at run-end is **non-terminal** (`awaiting_gate`), so **A's reaper
  never reclaims it.** Either (i) run-end/abandon must *terminalize* held children (then A's reaper collects them
  on the next pass), or (ii) Cluster B owns the run-end reclaim path directly. Neither PRD nails the run-end arm.
  **Operator/decomposition must assign this** — it is the one held-child seam A's design does not close.

---

## 4. Parallelizable vs serialized children — the ordering DAG

The task's three questions, answered concretely:

- **Q1 — Does B-FG524 require C-FG527's classifier migration first?** **No SEMANTIC prerequisite (VERIFIED); the
  parallelizable conclusion is INFERENCE.** They share `dispatchFanoutStep` lines (`:1620-1626`, `:1668-1671`), so
  whichever lands second must rebase on the shared function. **VERIFIED — no semantic prerequisite:** B's gate is
  role-scoped and unconditional (`IMPLEMENTER_ROLES`, B §9.1), so it neither re-adds the `red-` prefix C is
  deleting nor regresses C's shrinking allowlist, whichever order they land. **INFERENCE (this map): that they are
  therefore parallelizable.** But because both edit the same lines, the rebase is a **COORDINATED** one — after
  either lands, **re-verify the child-filter semantics against the other's migration** — **NOT** a
  routine/automatic rebase. **COORDINATE deliberately on the shared function; do not serialize.** (The intra-C
  order D-5a → D-5b still holds — that is C-internal.)
- **Q2 — Does A-FG356's reaper require B's N-9 held-child rule first?** **NO (parallelizable).** A's reaper is
  terminal-only and a held child is non-terminal, so A's own predicate (D9 + D9b clause (c)) already excludes it.
  The only shared obligation is the constant `awaiting_gate ∈ non-terminal` — both must honor it (A must not add
  it to its terminal set; B N-9(a) makes the reaper aware). They **parallelize**, with that one agreed constant.
  (The run-end reclaim gap is OQ-INT-2, not a reaper/hold ordering issue.)
- **Q3 — Does B's finalize-event enumeration require C's lifecycle-evaluator surface?** **NO.** B-INV-1 keys on
  `run-kind.ts` + `IMPLEMENTER_ROLES` — shipped surfaces (§2.4). It can land **first**, in parallel with C's
  retry.ts work.

**Recommended landing DAG (INFERENCE — the PRDs defer ordering here; C OQ-6 explicitly to this artifact):**

```
INDEPENDENT — can start in parallel (no cross-cluster dependency):
  ├─ B-INV-1  finalize-site census guard        (B D5 — highest leverage, existing surfaces)
  ├─ C-retry  retry.ts correction D-1/D-4        (C D-7 §1 — independent file)
  ├─ A-FG559  mount + D6 detector + D10 pointer  (A D1–D7, D10 — container; git-path facts FG-553-insensitive)
  └─ B-FG566  provision into ctx.projectDir      (B D1/INV-4 — host-side; late-bind ownership predicate to A-FG559, D5)

INTRA-C SERIAL CHAIN on dispatchFanoutStep (C-internal only):
  C-FG527 D-5a (ad-hoc exclusion, 3 sites)  →  C-FG527 D-5b (red- prefix → classifier, + worktreePath guard)

SHARED-FUNCTION COORDINATED REBASE on dispatchFanoutStep (NOT a semantic serialize, NOT a routine rebase):
  C-FG527 (dispatchFanoutStep)   ‖   B-FG524 (child gate + parent re-aggregation)
      no SEMANTIC dependency (VERIFIED, B §9.1: gate is role-scoped via IMPLEMENTER_ROLES);
      the PARALLELIZABLE conclusion is INFERENCE. Both edit the same lines (:1620-1626, :1668-1671),
      so whoever lands SECOND must do a COORDINATED rebase — re-verify child-filter semantics
      after the other's migration — not an automatic one                          [Q1: no semantic dep VERIFIED; parallel = INFERENCE]

COUPLED, order-flexible (decoupled by pre-existing awaiting_gate status):
  C-S2 (models awaiting_gate → ACTIVE, INV-7)  ⇄  B-FG524 hold      [C OQ-6; either order if both honor ACTIVE]

PARALLEL, one shared constant:
  A-FG356 reaper   ‖   B-FG524          [Q2; shared: awaiting_gate is non-terminal]

CROSS-CUTTING PREREQUISITE (must be fixed before A-FG356, B-FG524, or C-S2 changes any status set):
  Agree awaiting_gate ∈ {non-terminal, ACTIVE}
```

**Recommended concrete order:** land **B-INV-1**, **C-retry**, **A-FG559** first (fully independent).
**C-FG527 (D-5a → D-5b)** and **B-FG524** both edit `dispatchFanoutStep`. There is **no semantic prerequisite**
between them (VERIFIED, B §9.1: B's gate is role-scoped), and the conclusion that they can therefore land in
**either order** is **INFERENCE** (D1 / Q1). Whichever lands second must do a **COORDINATED rebase — re-verifying
the child-filter semantics against the other's migration — NOT a routine one**, because both edit the same
function region (`:1620-1626`, `:1668-1671`). **C-S2** (modelling `awaiting_gate → ACTIVE`) is coupled to B-FG524's held
state but decoupled in practice by the pre-existing status, so it too may land in any order provided all honor
`awaiting_gate = ACTIVE`. **A-FG356** and **B-FG566** can run alongside the whole chain. This map does **not** decompose these into child
stories — that is gated on each PRD passing review (A §10, B §6, C §7.3).

---

## 5. Post-FG-561 revalidation triggers (FG-553 / FG-555 in flight)

FG-553 (control-runtime isolation: promotion mechanism, store-version policy, dev-vs-stable runtime split) and
FG-555 (runtime selection) are on the primary orchestrator's lane. Per-cluster, the PRD conclusions that need
**re-verification** once FG-553 lands — cited by id, with the discipline (per each PRD) of also naming what is
**explicitly NOT** a trigger:

### Cluster A — workspace isolation

- **A §7.3 (VERIFIED) — the highest-value trigger in the cluster.** FG-553 moves the control runtime behind a
  promoted release directory. An acceptance test that edits `spawn.ts` and then runs `forge` would exercise the
  **OLD** mount logic, pass green, and prove nothing. **Every executed acceptance test in A §7.1/§7.2 (AC-3…AC-7,
  N-1…N-9) must be confirmed to run against the artifact it thinks it is testing (`forge-dev` vs `forge`).** This
  is the "anything assuming forge executes the working tree" trigger for A.
- **Explicitly NOT a trigger (A §7.3):** the git-path-resolution facts (probes p5/p5b/p6b — AC-1/AC-2/AC-3/AC-7's
  git semantics) are about **git's** path resolution, not forge's runtime, and are **insensitive** to FG-553.
  Do not re-run them for FG-553; `p5` remains the acceptance probe for AC-1/AC-2 across the change.

### Cluster B — review execution trust

- **B OQ-4 (VERIFIED) — "forge executes the working tree" + "which artifact."** The FG-566/541/524/525 probes ran
  the working tree via `tsx`. After FG-553, `forge review-loop` runs the **promoted release**, so a fix in `src/`
  is not live until promoted; each acceptance falsification must be executed against the right artifact, and
  `fg566-unprepared-env.sh` re-run once FG-553/FG-555 land.
- **B D1.4 + OQ-1 (FG-555) — "which Node/ABI local verification runs under."** FG-566 **declares and records** the
  provisioning runtime (default `process.execPath` / `process.versions.modules`) and **refuses rather than
  guesses** on mismatch. When FG-555 lands its launched-workload runtime contract, **D1.4's default is the one
  line that changes** (OQ-1). The dev-vs-stable runtime split can change the ABI provisioning keys on, so
  **N-2/F3 (deps built for an incompatible ABI are not accepted as ready) must be re-derived against the pinned
  post-FG-553 ABI** (B §9.4). `INV-4`'s `project_dir` keying is *insensitive* (the reviewed project's dir is
  unchanged); only the **recorded ABI** is sensitive — do not conflate them.

### Cluster C — workflow lifecycle semantics

- **C §8 (VERIFIED) — "a single Forge version owns the store."** IF FG-553's **store-version policy** admits
  **more than one Forge version writing the same store**, two conclusions must be re-verified:
  1. **A-5's safety argument** — narrowing touches only marker-stamped rows; rule 0 reads a provenance marker
     written by the **current** Forge version. If marker-less rows become reachable on **live** (not historical)
     runs, `legacy_ambiguous_invoke` stops being a legacy kind and the bound dissolves.
  2. **S5 / A-6** — `classifyTaskLineage` is deterministic *given a workflow + row set*, but **two Forge versions
     with different classifier rules writing the same store can disagree about the same row**; terminal-blocker
     derivation and reconcile's orphan sweeps become version-dependent.
- **C OQ-3 (VERIFIED):** persisting the attempt kind on the task row is **deferred into** FG-553's store-version
  decision — it "collides head-on" and must land **inside** that policy, never beside it.
- **Explicitly NOT a trigger (C §8):** FG-553's **exec-not-spawn / pinned-interpreter** work changes *how*
  `forge next` is launched, not *what it decides*. **No conclusion in C depends on it** — C says so precisely
  because the temptation is to list it.

### Cross-cutting — the shared no-migration assumption × store-version policy (INFERENCE)

All three clusters deliberately avoid a `tasks`-schema migration (A §4; B §5; C §6/OQ-3), each leaning on the
`awaiting_gate` status + payload **already existing** (B D3). **If FG-553's store-version policy introduces
per-version store schemas or a migration-on-open regime, this shared "no migration needed" stance must be
re-confirmed** — it is safe only while the store schema is stable across the versions that open it. This is the
"migrations run on every writable DB open / single version owns the store" trigger, and it lands on the campaign
as a whole, not on one cluster. C OQ-3 is the one place a cluster has already routed a would-be migration into
FG-553's policy; the no-migration convergence of A/B/C is the place to watch if that policy changes.

---

*This map cites the three PRDs and defers every binding decision to them. It creates no backlog children,
decomposes nothing, files no tickets, and touches neither source nor the PRDs.*

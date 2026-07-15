# Post-FG-561 delta-audit — bounded, runnable BRIEF

**This is a BRIEF for an audit, not the audit.** It operationalizes the integration map's §5 revalidation
triggers (`docs/plans/foundations-integration.md`) into a concrete, rerunnable procedure that must be executed
**once FG-561/FG-553 lands and before any foundation child begins implementation.** It cites the three PRDs; it
invents no normative decisions and allocates no tickets.

**Keyed to each cluster's review-clean lane HEAD** — A `a0064d5`, B `20c8f59`, C `c55da4a` — and the campaign
baseline **`185afc3`**. Each SHA is the **review-clean lane HEAD**, not necessarily the PRD-file-finalizing
commit: only **A** (`a0064d5`) is simultaneously its PRD's finalizing commit **and** its lane HEAD. **B** and
**C** are the same case — each has a later **plan-only** commit as its lane HEAD: B's PRD file
`docs/prds/review-execution-trust.md` was finalized at **`68ee713`** and `20c8f59` is a later plan-only citation
fix on the same lane branch (it edits `docs/plans/foundations-lane-b-review-trust.md`, not the PRD); C's PRD file
`docs/prds/workflow-lifecycle-semantics.md` was finalized at **`31a690d`** and `c55da4a` is a later plan-only
census fix (it edits `docs/plans/foundations-lane-c-lifecycle-semantics.md`, not the PRD) — cited here as the
lane HEAD, so neither `20c8f59` nor `c55da4a` must be read as a PRD edit. Each PRD's revalidation triggers (A §7.3, B OQ-4 / §9.4, C §8, and the map §5
cross-cutting) are the source; this brief is their union, made executable.

---

## 0. Why this audit exists

FG-553 (control-runtime isolation: promotion mechanism, store-version policy, dev-vs-stable runtime split) and
FG-555 (runtime selection) land on the primary orchestrator's lane. **They move the ground the three PRDs stand
on.** The specific hazard, stated by all three PRDs independently:

> An acceptance test that edits `src/` (e.g. `spawn.ts`, `review-loop.ts`, `retry.ts`) and then runs `forge`
> would, after FG-553, exercise the **OLD promoted release**, pass green, and **prove nothing** (A §7.3, B OQ-4).
> And if FG-553's store-version policy admits **more than one Forge version writing one store**, or a
> **migration-on-every-open** regime, several PRD conclusions that assume *"a single Forge version owns the
> store"* and *"no `tasks` migration is needed"* **dissolve** (C §8, map §5 cross-cutting).

The audit's job is to **re-bind every FG-553-sensitive assumption to the merged artifact**, and to flag any that
have dissolved, **before** implementation renders those assumptions load-bearing in code.

---

## 1. INPUT — the parameter to bind at run time

- **`POST_FG561_SHA`** — the **final MERGED post-FG-561 SHA** on the integration branch. **FG-561 is not merged
  yet**; this brief names it as the input to bind when the audit runs. It is the tip that carries FG-553/FG-555.
- Fixed reference: **`185afc3`** — the campaign baseline the three PRDs were written against.

## 2. EXACT GIT RANGE to audit

```
185afc3..$POST_FG561_SHA
```

Everything the three PRDs assumed about the source between the baseline and the merged FG-561 tip. Restrict
inspection to the files in §3; scan the whole range for changes to those paths and to any symbol the PRDs cite by
`file:line`.

## 3. FILES to inspect

The FG-553/FG-555 mechanism surfaces, plus **every file the three PRDs assume behaves a certain way**:

| File / surface | Why it is in the audit (cited) |
|---|---|
| **the promotion mechanism** (promoted release dir / `forge` vs `forge-dev` launcher; whatever FG-553 introduces) | A §7.3, B OQ-4 — an acceptance test may run the OLD promoted artifact and prove nothing. **The single highest-value surface.** |
| **`src/store/db.ts`** (migration policy — on-open / writable-open / per-version schema) | map §5 cross-cutting; baseline `185afc3` commit itself corrects "migrations run on EVERY open, not just writable". The A/B/C shared **no-`tasks`-migration** stance is safe only while the store schema is stable across the versions that open it. |
| **node-preflight / ABI surface** (`process.execPath`, `process.versions.modules`, the recorded provisioning ABI) | B D1.4 / OQ-1 / §9.4 — FG-555's launched-workload runtime can change the ABI FG-566 provisioning keys on; N-2/F3 must be re-derived against the **pinned post-FG-553 ABI**, not `137`. |
| **the `dispatchSource` dispatch sites** — WRITE: `invoke.ts:151` stamps `"invoke"`; workflow sites `reconcile.ts:659`, `gate.ts:322`/`:411`, `runNext.ts:498`/`:1276`/`:1709`. READ: classifier rule 0 at `lifecycle-evaluator.ts:179-183` | C D-2 rule 0 / C §8 — rule 0 reads the `dispatchSource` marker **written at dispatch time by the current Forge version**; if marker-less rows become reachable on **live** runs, `legacy_ambiguous_invoke`'s bound dissolves. Audit the marker **at the dispatch sites**. **NOT `src/v2/launch.ts`** — that file is FG-535 tmux durable-launch (exit-record + launcher-attribution) and records **no** `dispatchSource`; if its tmux launch-record / R2 exit-recorder provenance is relevant it is a **separate** FG-535 concern, not the `dispatchSource` marker. |
| **`src/v2/spawn.ts`** (mount construction path — the `.git` mount and `PROJECT_MODE`) | A §7.3 — the acceptance tests for AC-1/AC-2/AC-3/AC-7 edit `spawn.ts`; confirm they run against the artifact they think they test. |
| **`src/store/runs.ts`** (`completeRun` `:140` / its `AND status='active'` guard `:147`; `updateRunStatus` FG-484 refusal `:174-179`) | C INV-2 — the no-resurrection guarantee is store-layer; confirm both guards survive the FG-553 store changes and that no new completion-writing path appeared. **(There is no `src/v2/store/` directory — the store lives at `src/store/`.)** |
| **`cli/commands/review-loop.ts`** (the three local-run sites `:544`/`:622`/`:853`) | B OQ-4 — after FG-553 these run the promoted release, not the working tree. |
| **`src/v2/retry.ts`** (`:263` mount-mode fallback; `:427-466` mint) | C OQ-2 / map OQ-INT-1 — the fail-open mount-mode fallback is the unowned seam; confirm FG-553 did not change mount-mode provenance under it. |
| **`src/v2/lifecycle-evaluator.ts`** (classifier rule 0, `:110`/`:116-127`) | C §8 — two Forge versions with different classifier rules writing one store disagree about one row. |

## 4. ASSUMPTIONS to revalidate — per cluster, cited to the PRD decision

### Cluster A (PRD `a0064d5`)

- **A §7.3 — "forge executes the working tree."** Every executed acceptance test in A §7.1/§7.2 (AC-3…AC-7,
  N-1…N-9) must be confirmed to run against the artifact it thinks it is testing (`forge-dev` vs `forge`). This
  is the **highest-value trigger in the cluster.**
- **Explicitly NOT a trigger (A §7.3):** the git-path-resolution facts (probes p5/p5b/p6b — AC-1/AC-2/AC-3/AC-7's
  git semantics) are about **git's** path resolution, not forge's runtime, and are **insensitive** to FG-553.
  **Do not re-run p5 for FG-553** — it remains the acceptance probe for AC-1/AC-2 across the change.

### Cluster B (lane HEAD `20c8f59`; PRD file finalized at `68ee713`)

- **B OQ-4 — "forge executes the working tree" + "which artifact."** The FG-566/541/524/525 probes ran the
  working tree via `tsx`. After FG-553, `forge review-loop` runs the promoted release; a fix in `src/` is not
  live until promoted. Each acceptance falsification must be executed against the right artifact, and
  `fg566-unprepared-env.sh` re-run once FG-553/FG-555 land.
- **B D1.4 + OQ-1 + §9.4 — "which Node/ABI local verification runs under."** FG-566 **declares and records** the
  provisioning runtime (default `process.execPath` / `process.versions.modules`) and **refuses rather than
  guesses** on mismatch. When FG-555 lands its launched-workload runtime contract, **D1.4's default is the one
  line that changes** — **re-derive N-2/F3 against the pinned post-FG-553 ABI** (deps built for an incompatible
  ABI are not accepted as ready). `INV-4`'s `project_dir` keying is **insensitive** (the reviewed project's dir
  is unchanged); only the **recorded ABI** is sensitive — do not conflate them.

### Cluster C (lane HEAD `c55da4a`; PRD file finalized at `31a690d`)

- **C §8 — "a single Forge version owns the store."** IF FG-553's store-version policy admits **>1 Forge version
  writing one store**, re-verify: (1) **A-5's safety argument** — rule 0 reads a provenance marker written by the
  current version; marker-less rows reachable on **live** runs dissolve `legacy_ambiguous_invoke`'s bound; (2)
  **S5 / A-6** — two versions with different classifier rules can disagree about one row, making terminal-blocker
  derivation and reconcile's orphan sweeps version-dependent.
- **C OQ-3 — persisting the attempt kind** is deferred **into** FG-553's store-version decision; confirm it
  landed **inside** that policy, never beside it.
- **Explicitly NOT a trigger (C §8):** FG-553's **exec-not-spawn / pinned-interpreter** work changes *how* `forge
  next` is launched, not *what it decides*. **No conclusion in C depends on it.**

### Cross-cutting (map §5)

- **The shared no-`tasks`-migration stance × store-version policy.** A §4, B §5, C §6/OQ-3 all avoid a `tasks`
  migration, leaning on `awaiting_gate` status + payload **already existing** (B D3). **If FG-553 introduces
  per-version store schemas or a migration-on-open regime, this shared "no migration needed" stance must be
  re-confirmed** — it is safe only while the store schema is stable across the versions that open it. Lands on
  the campaign as a whole, not one cluster.
- **The `awaiting_gate` semantics agreement** (map §4 cross-cutting prerequisite): confirm nothing in the merged
  range changed `awaiting_gate`'s membership in the terminal/non-terminal sets before A-FG356, B-FG524, or C-S2
  key on it.

## 5. PROBES to run (concrete, rerunnable)

1. **Artifact-identity probe (A §7.3 / B OQ-4).** After building, edit a sentinel line in `src/v2/spawn.ts` (and
   separately `cli/commands/review-loop.ts`), run `forge` through the promotion mechanism, and **assert the edit
   is observed at runtime.** If it is not, tests edit the working tree while `forge` runs the promoted release —
   every executed acceptance test in A §7 and B §7 is invalid until re-bound. Output: PASS/FAIL + which artifact
   ran.
2. **Store-version probe (map §5 / C §8).** Inspect `db.ts` in the merged range for (a) migration-on-open /
   writable-open policy and (b) whether >1 Forge version may write one store. If either changed vs `185afc3`,
   run the C §8 re-verification (probes below) and flag the A/B/C no-migration stance.
3. **Classifier-determinism probe (C §8 / A-6).** With the store-version answer from probe 2, re-run C's `p4`
   (`deriveUpstream` bound) and the S5 failed-primary set against a two-version-write scenario if admitted;
   assert marker-based narrowing still touches only marker-stamped rows on **live** runs.
4. **ABI probe (B §9.4 / F3).** Provision under the pinned post-FG-553 runtime; assert deps built for an
   incompatible ABI are **not** accepted as ready (re-derive against the pinned ABI, not `137`). Re-run
   `fg566-unprepared-env.sh`.
5. **No-resurrection probe (C INV-2).** In the merged range, assert `completeRun`'s `AND status='active'`
   (`store/runs.ts:147`) and `updateRunStatus`'s FG-484 refusal (`:174-179`) both survive, and no third
   completion-writing path appeared.
6. **Negative-control confirmation.** Re-affirm the explicitly-NOT-triggers: **do not** re-run A's p5/p5b for
   FG-553 (git path resolution, insensitive); **do not** treat FG-553's exec-not-spawn work as a C trigger.
   Record them as deliberately skipped so a later reader does not mistake the omission for oversight.

## 6. OWNER — one named role

**Owner: the primary orchestrator (campaign integration owner).** The audit spans all three clusters and the
FG-553/FG-555 lane, so it cannot sit inside any one cluster's implementer. One role runs the whole brief and owns
its verdict. (Individual host-only reds each PRD names — A's AC-5 gate, B's F9 container-gone red — remain the
respective **implementer's** responsibility on the macOS host; they are downstream of this audit's gate, not part
of it.)

## 7. COMMITTED OUTPUT location

**`docs/plans/foundations-post-fg561-delta-audit-result.md`** — committed to the integration branch. It must
record, per §4 assumption: **RE-CONFIRMED** (assumption holds against `$POST_FG561_SHA`, cite the probe output) /
**CHANGED** (assumption moved — name the new binding and which PRD decision it re-points, e.g. B D1.4's default
ABI) / **DISSOLVED** (assumption no longer holds — e.g. store-version policy admits multi-version writes; name
the PRD conclusion that must be re-derived and route it back to that cluster). The bound `$POST_FG561_SHA`,
the audited range, and the owner are stamped at the top.

## 8. PRE-IMPLEMENTATION GATE (HARD — enforced at decomposition/campaign INTAKE)

**Where the gate is enforced.** This is a **precondition check in the primary orchestrator's campaign /
decomposition INTAKE transition** — a required, blocking gate condition — **not** a prohibition sentence a reader
is trusted to honor. Before the orchestrator dispatches **any** foundation child (any A-\*, B-\*, or C-\* slice),
its intake step must verify, as a hard precondition, that:

1. the delta-audit **result artifact EXISTS** at its committed output path
   `docs/plans/foundations-post-fg561-delta-audit-result.md` (§7) on the integration branch; **AND**
2. that artifact records a bound `$POST_FG561_SHA` and an overall **PASS** verdict; **AND**
3. every §4 assumption in it is recorded **RE-CONFIRMED** or **CHANGED-with-a-named-rebinding**, and every
   **DISSOLVED** assumption carries a recorded route back to its cluster's PRD for re-derivation.

If any of (1)–(3) is unmet, the intake transition **fails closed** and dispatches no foundation child. "Has the
gate been satisfied?" is therefore a **yes/no check against a durable committed artifact** — the
presence-and-PASS of `…-delta-audit-result.md` — not a request, and not a manual reading step that can be
skipped.

This precondition sits **above** the per-child red prerequisites in
`docs/plans/foundations-decomposition.md` (A-FG356's AC-5 host gate, B-FG525's F9 container-gone red,
C-FG527-c's A-4 red, C-FG477-S5 / A-6's probe): those reds must be observed against **the audited artifact**, so
they are downstream of this gate. A child whose captured red or acceptance probe is FG-553-sensitive (A-FG559,
B-FG566, C-FG527 / C-FG477-S5 per §4) **may not treat that evidence as valid until the audit re-binds it.**

# Post-FG-561 delta-audit — bounded, runnable BRIEF

**This is a BRIEF for an audit, not the audit.** It operationalizes the integration map's §5 revalidation
triggers (`docs/plans/foundations-integration.md`) into a concrete, rerunnable procedure that must be executed
**once FG-561/FG-553 lands and before any foundation child begins implementation.** It cites the three PRDs; it
invents no normative decisions and allocates no tickets.

**Keyed to each cluster's review-clean lane HEAD** — A `13d3142`, B `bf906b4`, C `b5d7417` — and the campaign
baseline **`185afc3`**. Each cluster SHA is the lane HEAD and is simultaneously that PRD's finalizing
commit (all three coincide — the same commit edits the PRD file and is the lane HEAD; no plan-only-HEAD cluster
remains). **A** (`13d3142`) reclassifies §4.2/OQ-4 reds-capability (probe P7 falsified the "no Bash / do not invoke
git" assertion) and carries the corrected P7 probe. *(A was re-finalized at `13d3142`; the earlier `3b76153` was
plan-only and did NOT edit the PRD — PRD last edited at `c1a77e3` — so it never satisfied "coincides." `13d3142`
edits the PRD (genuine two-runtime P7 evidence) and is the lane HEAD. This SHA is under the fresh strict
integration review this round.)* Each PRD's revalidation triggers (A §7.3, B OQ-4 / §9.4, C §8, and the map §5
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
| **`src/cli/commands/review-loop.ts`** (the three local-run sites `:544`/`:622`/`:853`) | B OQ-4 — after FG-553 these run the promoted release, not the working tree. |
| **`src/v2/retry.ts`** (`:263` mount-mode fallback; `:427-466` mint) | C OQ-2 / map OQ-INT-1 (OWNED-BY-A, row 12) — the fail-open mount-mode fallback; confirm FG-553 did not change mount-mode provenance under it. |
| **`src/v2/lifecycle-evaluator.ts`** (classifier rule 0, `:110`/`:116-127`) | C §8 — two Forge versions with different classifier rules writing one store disagree about one row. |

## 4. ASSUMPTIONS to revalidate — per cluster, cited to the PRD decision

### Cluster A (PRD `13d3142`)

- **A §7.3 — "forge executes the working tree."** Every executed acceptance test in A §7.1/§7.2 (AC-3…AC-7,
  N-1…N-9) must be confirmed to run against the artifact it thinks it is testing (`forge-dev` vs `forge`). This
  is the **highest-value trigger in the cluster.**
- **Explicitly NOT a trigger (A §7.3):** the git-path-resolution facts (probes p5/p5b/p6b — AC-1/AC-2/AC-3/AC-7's
  git semantics) are about **git's** path resolution, not forge's runtime, and are **insensitive** to FG-553.
  **Do not re-run p5 for FG-553** — it remains the acceptance probe for AC-1/AC-2 across the change.
- **Corrected runtime boundary (§4.2/OQ-4, PRD-a `13d3142`) — do NOT re-assume reds lack Bash/git.** P7
  (`docs/plans/foundations-lane-a-probes/p7-red-runtime-capability.out` SECTION 1, executed under two
  genuinely-distinct manifest-verified runtimes — codex-subscription and claude-oauth; Pi is not tool-capable for
  reds on this host, so no Pi red execution exists) proved reds **already have effective Bash + git-read**
  (`/usr/bin/{bash,git}` ship in the agent image, so the capability is image-level). A post-FG-561/FG-553 revalidation must NOT re-derive the falsified "no Bash / do not
  invoke git" assumption. **Red CAPABILITY (bash/git present) is independent of the promotion mechanism** — the
  artifact-identity arms below decide *which forge/artifact runs*, not whether reds can run commands; capability is
  a property of the agent image, unchanged by promotion. What FG-553 CAN move is the mount wiring: **the `:ro`
  mount's filesystem WRITE-DENIAL is the distinct property to re-verify** (P7's bounded-write arm — `touch`/redirect
  refused `Read-only file system`, exit 1 — is the acceptance check; re-run it against the promoted artifact, not
  the git-read capability).

### Cluster B (PRD `bf906b4`)

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

### Cluster C (PRD `b5d7417`)

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

1. **Artifact-identity probe (A §7.3 / B OQ-4) — THREE separately-recorded arms.** FG-553 introduces a
   **stable-vs-dev runtime split**: `forge-dev` (or `npm run forge` / whatever live-source launcher FG-553
   preserves) runs the **working tree**, while machine-wide `forge` runs the **promoted release**, not the edited
   source. This probe proves that split in three arms so that an acceptance test knows which artifact its `forge`
   invocation actually exercises. **Each arm states its command and RECORDS WHICH EXECUTABLE/ARTIFACT IT RAN.**
   Mechanism names (the dev entry point / live-source launcher, the promotion mechanism, and the version /
   release-identity surface that reports the promoted SHA) are **whatever FG-553's OQ-6 introduces** — bind them
   at run time; do not assume the spellings here. It runs **post-FG-553**; keep it a rerunnable BRIEF and **do not
   claim results**.

   - **ARM 1 — forge-dev sees the working tree.** Edit a sentinel line in the working-tree source (e.g.
     `src/v2/spawn.ts`, and **separately** `src/cli/commands/review-loop.ts`). Run the **DEV** entry point
     (`forge-dev` / `npm run forge` / the live-source launcher FG-553 preserves). **ASSERT the sentinel IS
     observed at runtime.** **Record:** *forge-dev ran the working tree.* Output: **PASS/FAIL** + the
     executable/artifact identity actually run.
   - **ARM 2 — stable forge does NOT see an unpromoted edit, and reports the promoted SHA.** With that **same
     working-tree sentinel edit STILL PRESENT and UNPROMOTED**, run the **STABLE** machine-wide `forge`. **ASSERT
     the sentinel is NOT observed** (stable runs the promoted release, not the edited working tree) **AND** that
     stable `forge` **reports/identifies the CURRENTLY PROMOTED SHA** (e.g. via a version / release-identity
     surface). **Record:** *stable forge ran the promoted release `<SHA>`, not the working tree.* Output:
     **PASS/FAIL** + the executable/artifact identity actually run.
   - **ARM 3 — after promoting the exact candidate SHA, stable forge runs and identifies it.** Promote the
     **EXACT candidate SHA** through FG-553's promotion mechanism. Run stable `forge`. **ASSERT the promoted
     change IS now observed AND** stable `forge` **identifies the promoted artifact as that exact candidate SHA.**
     **Record:** *stable forge ran promoted artifact = candidate SHA.* Output: **PASS/FAIL** + the
     executable/artifact identity actually run.

   **Interpretation:** if ARM 1 fails to observe the sentinel, or ARM 2 observes it (stable ran the working tree),
   or ARM 3 fails to identify the promoted SHA, then tests edit the working tree while `forge` runs a different
   artifact — **every executed acceptance test in A §7 and B §7 is invalid until re-bound to the promoted
   artifact.**
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

## 8. PRE-IMPLEMENTATION GATE (MANDATORY PROCESS PRECONDITION on orchestrator dispatch)

**What kind of gate this is.** This is a **mandatory process precondition binding on the primary orchestrator's
decision to dispatch any foundation child** — a required, non-optional step the orchestrator MUST perform, whose
enforcement is the orchestrator's own responsibility. It is an **operator / process gate, not a code-enforced
production check**: no production intake path — no code-gated campaign or decomposition transition — auto-verifies
the audit result or blocks child dispatch on it today. Nothing in the codebase "fails closed" here; the fail-closed
behavior is a **rule the orchestrator is obligated to follow**, and skipping it is a **process violation**, not a
mechanism the system prevents. (If a code-enforced intake check that programmatically blocks dispatch on the audit
result is wanted, that is **net-new follow-up work** to be named and built — it does not exist and cannot exist
pre-implementation, since the orchestrator's "intake" is an operator/process decision, not a code-gated transition.)

**The precondition.** Before the orchestrator dispatches **any** foundation child (any A-\*, B-\*, or C-\* slice),
it MUST verify, as a required precondition, that:

1. the delta-audit **result artifact EXISTS** at its committed output path
   `docs/plans/foundations-post-fg561-delta-audit-result.md` (§7) on the integration branch; **AND**
2. that artifact records a bound `$POST_FG561_SHA` and an overall **PASS** verdict; **AND**
3. every §4 assumption in it is recorded **RE-CONFIRMED** or **CHANGED-with-a-named-rebinding**, and every
   **DISSOLVED** assumption carries a recorded route back to its cluster's PRD for re-derivation.

If any of (1)–(3) is unmet, the orchestrator **must not** dispatch any foundation child — it is obligated to hold
until the audit result exists and records PASS. "Has the gate been satisfied?" is a **yes/no check against a
durable committed artifact** — the presence-and-PASS of `…-delta-audit-result.md` — so the precondition is
objectively decidable rather than a matter of judgment; but the act of checking it, and of holding dispatch when it
fails, is the **orchestrator's responsibility as a process obligation**, not something the system enforces. Not a
request, not a manual reading step that can be skipped — but also not code-gated.

This precondition sits **above** the per-child red prerequisites in
`docs/plans/foundations-decomposition.md` (A-FG356's AC-5 host gate, B-FG525's F9 container-gone red,
C-FG527-c's A-4 red, C-FG477-S5 / A-6's probe): those reds must be observed against **the audited artifact**, so
they are downstream of this gate. A child whose captured red or acceptance probe is FG-553-sensitive (A-FG559,
B-FG566, C-FG527 / C-FG477-S5 per §4) **may not treat that evidence as valid until the audit re-binds it.**

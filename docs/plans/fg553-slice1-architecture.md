# FG-553 (Slice 1) — architecture + plan. **STOP FOR REVIEW. No children created. No implementation.**

**Epic:** FG-561 · **Contract:** `docs/prds/durable-orchestration-continuation.md` @ `e6fd56b`
**Status:** architecture + planning complete; **REVISED after operator review (8 bounded corrections applied);
awaiting re-review before any implementation begins.** Direction (OQ-6/BD-15) accepted and unchanged.

**Status update (2026-07-14):** **Child 0 (`bin/forge` signal/exit fidelity) has LANDED as `97363ca` (PR #119)** —
the signal-fidelity prerequisite is satisfied and verified by execution (four cases, three mutants killed).
**Child 1 (store-compatibility policy) has LANDED as `275ac63` (PR #120).** It shipped the additive-only
open path, the reader-excluding quiesce (`journal_mode=DELETE` → `BEGIN EXCLUSIVE`, host-verified to refuse a
held reader with no corruption), the one-way boundary that never downgrades, the forward schema-version gate,
and `forge store converge` (operator-invoked, `--confirm-quiesced`, quiesce-gated). Two design outcomes
emerged during implementation and are now part of Child 1, beyond the original plan:
- **Dual-shape usage insertion.** Additive-only alone would have made a version-B usage writer *lose* capture
  on an unconverged 0.1.x store (the fresh-only INSERT violates the preserved legacy NOT NULL columns and the
  failure was silent in the production callers). Operator decision rejected that loss: `insertUsageRows` now
  inspects `model_calls` once and writes the legacy columns with 0/0/0 placeholders when present, so capture
  works on both shapes; a partial/inconsistent legacy shape raises a named actionable error.
- **The convergence operational contract, not a cross-process registry.** A PID-marker opener registry /
  maintenance lease was attempted and REVERTED — it cannot observe an already-deployed ungated binary (the
  exact BD-15 principle), broadens every open path, and adds stale-marker/liveness failure modes. Instead:
  `forge store converge` ends the overlap window (one-way); the operator must quiesce all forge processes
  first; the journal-mode gate is a best-effort active-connection backstop, not proof every process is dead;
  a pre-FG-568 process resuming after convergence fails its legacy inserts ATOMICALLY (lost captures, no
  partial write, no corruption — host-verified); the forward gate cannot constrain already-installed ungated
  binaries (HONEST LIMIT preserved).
**Status update (2026-07-15):** **Child 2 (release closure + manifest + R1/R2 provenance) has LANDED as FG-569.**
It shipped the load-bearing **exec-not-spawn** entry: `bin/forge` is now a `#!/bin/sh` shim that resolves `$0`
**through symlinks** (the machine-wide `forge` is an npm-link SYMLINK on PATH) and `exec`s node ONCE with tsx
loaded in-process via `bin/forge-loader.mjs` (`exec node --import …/forge-loader.mjs …/src/cli/index.ts "$@"`).
**Exactly one process exists, and its `process.execPath` IS the control runtime (R1), self-evidencing** — there
is no spawned `tsx` grandchild. This **supersedes Child 0's spawn-based signal re-raise** (§2 C3): with no child
there is nothing to mirror — a signal to `forge` reaches the single process directly, and the FG-567
signal-fidelity guard was rewritten for this exec form. A built release additionally ships a self-contained,
**immutable (read-only-at-rest)** closure with a `forge-release.json` manifest and R1/R2 runtime provenance.
**This slice stays INERT: no promotion, no `current` symlink, no PATH change — that is Child 4 (FG-571).** R3/R4
launched-workload provenance stays out of scope (FG-555). Children **3–5 remain planned**; the analysis,
decisions (OQ-6/BD-15/T9), Appendix A probes, and mutation reasoning below are unchanged, except where a
Child-0/Child-2 closeout line is annotated for the shipped exec entry.

**The rule this slice is planned under (from FG-551):** *a property concerning the FINAL RUNTIME must be
demonstrated by EXECUTING or MUTATION-TESTING the final artifact. A source-pattern match is not evidence.*

---

## 1. Decisions

### OQ-6 — RESOLVED
**Release directory + atomic `current` symlink + a POSIX-shell PATH shim + a shared versioned interpreter
store. The load-bearing move is EXEC, NOT SPAWN.**

- The machine-wide `forge` becomes a near-frozen `#!/bin/sh` shim that resolves `current`, reads the release
  manifest, and **`exec`s the pinned absolute interpreter** against the release entry point. `/bin/sh` is the
  only interpreter whose absolute path is guaranteed **without consulting PATH** — which is exactly what lets
  F29 pass in its sharpest form: *a shell with no `node` on PATH at all.*
- **The shim sits OUTSIDE the release closure**, deliberately. If it were inside, a bad promotion would brick
  `forge` itself and rollback-via-forge would be impossible. **Honest cost: shim changes are therefore NOT
  atomic with a release.** Mitigation: keep its contract minimal (resolve → read manifest → exec) and treat
  any change to it as an install-level breaking change.

**Why exec-not-spawn is the whole ballgame.** The pre-FG-569 `bin/forge` was `#!/usr/bin/env node` and
`spawn`ed `node_modules/.bin/tsx` — **which was ALSO `#!/usr/bin/env node`.** So the kernel re-entered
PATH resolution for the child, and **the process that actually loaded `better-sqlite3` was a PATH-resolved
CHILD.** Pinning only the outer shebang would have looked like a fix, passed `forge --version`, and **still
failed F29**. That is the FG-551 failure shape exactly — an adjacent thing satisfying the assertion. Exec once,
load tsx in-process, one process — **which FG-569 has since shipped in two distinct entries, and only one of
them satisfies F29.** The live dev `bin/forge` is now `#!/bin/sh` and `exec`s node once with tsx in-process, so
no spawned child exists — but it still `exec`s a **PATH-resolved** `node` (and only `readlink`s `$0` when it is a
symlink). That is fine for a dev checkout, where node is on PATH, but it does **NOT** fix F29: with no node on
PATH it cannot start. The **built RELEASE entry** (emitted by `forge release`'s `renderEntry`) goes further: it
`exec`s an **absolute, manifest-pinned interpreter** and resolves its own release root with shell builtins plus
that same absolute interpreter's `realpathSync` — canonicalizing `$0` through promotion symlinks WITHOUT a
PATH-resolved `readlink`. That entry — not the live `bin/forge` — is the one that runs under a hostile /
node-free / even readlink-free PATH, including when invoked THROUGH a promotion-style symlink (verified by
execution: `--version` and `status --json` through such a symlink both succeed there).

So the benefits split by entry. Two come from exec-not-spawn itself and hold in **both** entries: **R1 becomes
self-evidencing** (`process.execPath` of the CLI process *is* the control runtime — under the old spawn entry it
merely named an accidentally-resolved child), and the `bin/forge` exit-laundering defect below is removed. The
third — **F29** (availability under a hostile/node-free PATH) — comes **only** from the release entry's
absolute-interpreter pin, and does NOT hold for the live dev `bin/forge`.

**Rejected:** dedicated git worktree (`git checkout` is non-atomic → fails F27; git versions neither
`node_modules` nor the native binding, so it cannot carry the closure); pinned snapshot with no pointer
(promotion degenerates to in-place copy; a torn tree is reachable → fails F27); vendored interpreter per
release (correct but T9 forces retention, so ~100MB × N releases buys nothing the shared store lacks);
containerized control plane (Forge needs host tmux, Docker, git, filesystem).

**What it costs:** *"commit and it is live" is dead for the control plane* — that IS the slice, but price it
in. Disk, permanently: T9 forbids GC'ing a release with live processes, so retention is not optional.
`forge-dev` and `forge` diverge, so a bug reproducible under only one becomes possible — mitigate by making
release identity visible in command output.

**EXTERNAL-ARTIFACT CONTRACT (correction #4) — the two artifacts OUTSIDE the release closure, made explicit.**
The closure (§3) is atomic; the two things it depends on but does not contain are the **interpreter store**
and the **PATH shim**. Each needs its own contract, because "atomic `current` swap" says nothing about them.

*Interpreter store* (`~/.forge/runtimes/node-<version>-<abi>/`, shared across releases):
- **Immutable + versioned install.** Each interpreter lands at a version+ABI-keyed path and is **never
  modified in place.** A new interpreter is a new path, not an overwrite.
- **Validated BEFORE any release selects it.** Installation verifies the interpreter runs and reports the
  expected `process.version` + `process.versions.modules` *before* a manifest is allowed to reference it. A
  release manifest may reference **only** an already-validated interpreter path.
- **Retained while referenced.** An interpreter is reclaimable only when **no retained release** names it in
  its manifest — the same lifetime rule as releases, one level down. (An anchored process holds its release,
  which holds its interpreter.)
- **In-place replacement is prevented, not merely discouraged.** The install path is treated as immutable;
  a corrupted/partial interpreter install must be **discarded and rebuilt at a fresh path**, never patched
  under a live reference.

*PATH shim* (`/bin/sh`, machine-wide `forge`, outside the closure — the acknowledged atomicity crack):
- **Frozen contract:** resolve `current` → read manifest → `exec` the manifest interpreter. Nothing more.
- **Atomic install/replace:** the shim is written to a temp path and **atomically renamed** into place; a torn
  shim is never on PATH. Any change to its *contract* is an install-level breaking change (not atomic with a
  release), and is gated behind an explicit re-install, not a promotion.

**Interruption tests are no longer only the `current` swap** (correction #4): F27 must also cover an
**interrupted interpreter install** (kill mid-install → no release may reference a half-installed interpreter;
the store is unchanged) and an **interrupted shim install** (kill mid-rename → the previous shim is intact and
`forge` still runs). See the revised F27 rows in §4.

### BD-15 — RESOLVED
**Additive-only migrations on the ordinary open path; the destructive DDL moves OFF it into an explicit,
quiesce-gated migration; add a schema-version stamp as a forward gate.**

**The decisive constraint: you cannot retrofit a gate into an already-installed old binary.** F35 is "long
launch under version A, new command under version B." A gate added in B protects B from a newer store — it
does **nothing** to stop B from destroying the schema A is still using. The only policy safe against a peer
that *cannot be made to cooperate* is one where the newer process never removes what an older one depends on.
That is additive-only. Every other candidate assumes cooperation the deployed binary cannot provide.

**Coupling to OQ-6 — this is the architectural point.** Additive-only is what makes T9's "retain the old
release and let A finish" actually safe. Invert it: with destructive-on-open migrations, retention would
faithfully keep A's **code** alive while B silently destroyed A's **store**. The runtime fix would *mask* the
absence of the data fix and the system would look correct while corrupting itself. **Retention without
additive-only is a false sense of safety.**

**"No destructive DDL" is necessary but NOT the whole policy (correction #5). The real rule is
backward-compatible evolution across the supported overlap window** — the window in which a version-A process
and a version-B process share the store. Additive-only is one half; these are the rest:

- **Incompatible ADDITIVE changes are still breaking.** Adding a `NOT NULL` column without a default, or a new
  `CHECK`/`UNIQUE` constraint a version-A writer's inserts cannot satisfy, breaks A **without any DROP**. The
  overlap-window rule: **a new column must be nullable or defaulted**, and **no new constraint may reject a
  write an in-flight old writer still emits.** Evolution is backward-compatible or it waits.
- **Old-writer / new-reader is a first-class case, not just old-reader/new-writer.** A version-A process keeps
  *writing* rows in the old shape after B has migrated. B's readers and B's `NOT NULL` expectations must
  tolerate A's writes for the whole overlap window. Test **both** directions on one real DB.
- **The explicit destructive migration is an IRREVERSIBLE BOUNDARY, and it bounds rollback.** Once the
  operator-invoked, quiesce-gated destructive/converging migration runs, the store is at a schema an *older*
  release can no longer safely open. **Therefore rollback across that boundary is not a pointer swap** — a
  release promoted *before* the destructive migration cannot be rolled back to *after* it and still trust the
  store. The destructive migration must (a) require quiesce (no other Forge process on the store — enforced,
  per C1, against **every** open, not just writers), (b) record that the boundary was crossed via the
  schema-version stamp, and (c) make the one-way nature explicit so rollback tooling refuses to cross it
  silently. Ordinary promotions stay freely reversible; only this boundary is one-way.

### T9 — SETTLED BY EXECUTION (5 host probes)

| behavior | result |
|---|---|
| A process **anchors** to a release at its first resolution through `current` (for Forge: process start) | — |
| Once anchored, **all** later resolutions stay in that release — module-relative **and** re-traversing `current` | **no mixing** ✓ |
| Pointer-swap promotion | **does not tear** an in-flight process ✓ |
| **Deleting** the anchored release | **kills it** at its next lazy load — ESM `ERR_MODULE_NOT_FOUND`; **native dlopen fails** ✗ |
| Process spawned *after* promotion | correctly gets the new release (intended, not mixing) |

The fatal case is **Forge's actual hot path**: `better-sqlite3`'s `.node` is dlopen'd at the first
`new Database()` (`db.ts:177`), long after process start, module-relative to the anchored release.

> **INVARIANT: a promotion may swap the pointer. It may NEVER delete a superseded release while any process
> anchored to it is still running.** Release GC is a lifetime problem.

**Correction owned:** my first T9 claim was right in conclusion but overstated in mechanism, and my first
native probe returned a *wrong* answer (an apparent mixed-release load) because it used a CWD-relative path
instead of the real module-relative shape. The architecture pass caught the gap; execution settled it.

**CJS — NOW SETTLED BY EXECUTION (was HIGH-open; resolved per correction #6).** CJS anchors **identically to
ESM**. Probe (`$scratch/cjs-t9`): an anchored process's lazy `require("./sibling.cjs")` and its module-relative
native `dlopen` both resolve to release **A** when A is retained (proven by the require stack naming
`rel-A/entry.cjs`); **deleting A** yields `MODULE_NOT_FOUND` on the lazy require — the same failure shape as
ESM. **The T9 anchoring rule and its retention invariant are runtime-uniform (ESM = CJS = native dlopen); no
loader-kind divergence.**

Exact probe (preserved for reproduction):
```
rel-A/entry.cjs: require("./sibling.cjs") + process.dlopen(join(__dirname,"binding.node"))
anchored require("./current/entry.cjs") → setTimeout 2s → swap current→rel-B [±rm rel-A]
RETAIN: lazy require → A ; native dlopen → A          (safe)
DELETE: lazy require → MODULE_NOT_FOUND               (fatal, == ESM)
```

**Still OPEN (do not assume):** open file handles to release files; a child process spawned by an anchored
parent (it re-resolves `current` → *correctly* gets the new release — intended, not mixing — but a design
assuming parent/child version parity would be wrong).

**Initial implementation performs NO release GC** (correction #6). Child 4 swaps and **retains**; a release
is never deleted. Automatic GC is deferred to a *later* ticket that must ship a **proven** anchored-process
lifetime mechanism (know which processes are anchored to a release before reclaiming it). Until then,
retention is unbounded-by-design and reclaimed only by an explicit, operator-invoked, quiesce-gated sweep —
never automatically.

### OQ-2 — FEASIBILITY: **YES.** (Decision remains FG-563's.)
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` is set (`claude.ts:55`, deliberately, per FG-542). `forge launch
wait` **does not exist** (`run|list|show|rm` only). The **disposable Monitor is a working external wake
channel.**

**Specific evidence (correction #3/#4), with the layers kept honest:**
- **DURABLE (reproducible from the forge launch record):** launch **`launch-fg551-corrective-cf4yks`**
  (`forge launch run`, started `2026-07-14T19:16:17.736Z`) reached terminal **`exited 0`**. `forge launch
  show <id>` re-derives this. **This is all the launch record proves.**
- **OPERATOR-OBSERVED (NOT reproducible from the launch record alone):** a disposable Monitor watching that
  launch emitted one stdout line on the terminal transition, and that line arrived in *this* session as the
  wake event *"TERMINAL launch-fg551-corrective-cf4yks -> exited 0"*, under
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` with no harness background task. **The forge launch record does
  NOT prove the wake reached the session** — that coupling lives in the harness's Monitor-task output
  (`…/tasks/<taskid>.output`), which is harness-side, not Forge durable state. So this is a **specific
  operator-observed fact**, classified as such, not something re-derivable from the launch record.

**Feasibility conclusion stands on the combination:** the wake channel demonstrably worked at least once
under the disabling env. So **Slice 2 is not being designed against a channel that cannot exist**, and *"a
disposable Monitor running one blocking `forge launch wait`"* is a legitimate production shape. **Do not
require "Monitor eliminated."** (A design consequence, noted for FG-563: because the wake→session hop is
*not* in Forge durable state today, Forge cannot itself prove a wake was delivered — which is one more reason
Monitor liveness must be made observable.)

**Its failure mode is SILENCE — with a specific instance.** The Monitor for run `launch-fg552-audit-*` used a
bash-4 `declare -A` on this host's bash 3.2; it died on its **first line**, wrote the error to **stderr**
(the Monitor tool does not surface stderr as an event), and sat armed and silent until timeout while the three
reds it watched had already reached terminal — the durable launch records were correct the whole time. Any
design leaning on Monitor must make its **liveness observable**, because a dead Monitor is indistinguishable
from a running one.

---

## 2. Conflicts surfaced against the accepted PRD — **NOT amended**

- **C1 — BD-15's premise is understated. STATUS: RECONCILED into the PRD (FG-568, `275ac63`; FG-573).** Precise
  statement: **each process's FIRST store open — INCLUDING a logically read-only caller — can bootstrap a
  WRITABLE handle and run migrations.** `getDb({readOnly:true})` (`db.ts:399`) computes `wantReadOnly`
  (`db.ts:404`) and, when no writable handle exists in-process, falls through to the writable `getDb()`
  (`db.ts:412`), which runs `db.exec(SCHEMA_SQL)` + the now **additive-only** `applyMigrations`
  (`db.ts:428-429`) — no `DROP COLUMN` on this path; the destructive drop is confined to
  `runDestructiveConvergenceMigration` (`db.ts:221`, invoked by `forge store converge`).
  Confirmed read-only callers that therefore migrate on first open: `show.ts:57`, `status.ts:26`, `runs.ts:38`,
  `export.ts:20`, `metrics.ts:36`, `ops.ts:157`, `report.ts:17`, `sweep.ts:85`. **Strengthens BD-15; kills
  promotion-quiesce as a sufficient policy** — even a logically read-only command mutates the schema under an
  in-flight launch. *(Verified by orchestrator.)* **This correction has since been applied:** BD-15's premise
  now reads "every open, including a logically read-only caller" (PRD BD-15 + the 2026-07-15 revision-log
  entry, FG-568). The additive-only fix means those first opens now run only backward-compatible migrations —
  the destructive `DROP COLUMN` is confined to the operator's quiesce-gated `forge store converge`.
- **C2 — CORRECTED per review #3. tmux changes the ENVIRONMENT in which R3 is resolved; it does NOT make R4
  exist for every launch.** The distinction, stated precisely:
  - **R3** is the resolution of the launched command's **`argv[0]`, performed by the recorder** (the exit
    recorder's `spawnSync(a[0], …)`, `launch.ts:128`). It happens on **every** launch.
  - **R4** is a **subsequent** resolution performed **inside the launched workload** (e.g. a nested
    `bash -lc` the workload itself invokes resolving `node`/`npm`/`forge`). It exists **only when the workload
    performs one** — it is **not** universal.
  - What tmux actually does (`respawn-pane`, `launch.ts:253`): it runs the wrapped command through its
    configurable, unrecorded `default-shell`, so **the environment in which R3 is resolved is the tmux
    shell's environment, not the forge CLI's.** Consequence: **resolving R3 inside the forge CLI process would
    produce a plausible, well-formed, WRONG answer** — R3 must be resolved *in the recorder*, in the
    environment the command actually ran under.
  - The PRD's argv-fidelity claim **stands** (Forge does not rewrite argv). This informs FG-555's R3 job; it
    does **not** move FG-555's boundary, and it does **not** claim R4 is universal.
  - **This C2 correction does NOT go into the PRD** (review #3 + #7). It is an implementation-informing note
    for FG-553/FG-555, recorded here only.
  *(Verified by orchestrator: `launch.ts:253` interposes the shell; `launch.ts:128` is the recorder's
  resolution.)*
- **C3 — the pre-Child-0 `bin/forge` laundered a killed child into success.** `bin/forge:11` was
  `child.on("exit", (code) => process.exit(code ?? 0))`. **Verified by execution:** a SIGKILL'd child gave
  `code=null` → **`forge` exited 0.** Anything checking `forge`'s exit code — CI, scripts, the review-loop's own
  verification — reads **success** when forge was killed. This violates BD-3 in the live artifact.
  **`claude.ts:241` (`if (signal) process.exit(128)`) is NOT the pattern to copy** (correction #1): it
  *prevents the false exit 0*, but it is **insufficient for signal fidelity** — it converts OS-signal evidence
  into an ordinary numeric 128, which is the same F7/F8 attribution loss Child 0 must avoid. **Child 0 must
  RE-RAISE the child's actual signal** (`process.kill(process.pid, signal)`), so a direct observer of `forge`
  still sees `signal=SIGTERM/SIGKILL`, not a number. **exec-not-spawn deletes this defect by construction**
  (no child to mis-mirror at all). **STATUS: LANDED as `97363ca` (PR #119), then SUPERSEDED by FG-569's
  exec-not-spawn.** Child 0 shipped the re-raise fix against the spawn structure (`bin/forge:11` re-raised the
  spawned child's own signal, verified by execution across all four cases with all three mutants killed).
  **FG-569 then deleted that spawn structure by construction:** the live `#!/bin/sh` `bin/forge` `exec`s node
  once, so there is no child to mirror and a signal reaches the single process directly (the FG-567
  signal-fidelity guard was rewritten for the exec form).

---

## 3. Proposed bounded children — **PROPOSAL ONLY. Not filed.**

Each lands as one reviewable PR. Every acceptance case **executes or mutates the final artifact**; each names
its **red baseline** and the **hollow version to reject**.

| # | Child | Scope | Owns | Acceptance (executed) |
|---|---|---|---|---|
| **0** | **`bin/forge` signal/exit fidelity** (**LANDED as `97363ca`, PR #119**; later **SUPERSEDED by FG-569's exec-not-spawn** — the spawn structure this fix guarded no longer exists, so the live `#!/bin/sh` entry has no child to re-raise and a signal reaches the single process directly. — correction #8; prerequisite satisfied. **Four-case signal fidelity verified by execution:** child exits 0 → `code=0, signal=null`; child numerically exits 143 → `code=143, signal=null` (stays numeric — the F8 case); child killed by SIGTERM → `code=null, signal=SIGTERM`; child killed by SIGKILL → `code=null, signal=SIGKILL`. **All three mutants killed:** revert to `code ?? 0` → SIGKILL laundered to 0; `process.exit(128)` → signal erased to a numeric 128; numeric-143-as-signal → the F8 case reddens — proving `process.exit(128)` is insufficient because it erases the signal.) | Fix the entry point that launders a killed child into exit 0 (`bin/forge:11`, `code ?? 0`). **Correct fix is SIGNAL FIDELITY, not `process.exit(128)`** (correction #1): re-raise the child's OWN signal on the wrapper (`child.on("exit",(code,signal)=>{ if(signal){process.kill(process.pid,signal);return;} process.exit(code??0); })`). **`process.exit(128)` is insufficient — it converts OS signal evidence into an ordinary numeric exit**, exactly the F7/F8 attribution loss this campaign forbids. (`claude.ts:241`'s `exit(128)` is *better than laundering to 0* but still collapses signal→numeric; do NOT copy it here.) Small, isolated, no dependency on any other child. | — | **EXECUTE, three cases, all mutation-tested:** (1) child exits **0** → wrapper exits **0**; (2) child **numerically** returns **143** → wrapper stays **numeric 143, no signal** (`signal===null`, decision=EXIT 143) — the F8 case, must NOT become a signal; (3) child **terminated by SIGTERM** → **wrapper itself terminates by SIGTERM** (re-raised), not a numeric code. **Red baseline proven today** (SIGKILL child → forge exits 0). **Mutants, each must redden a distinct case:** restore `code ?? 0` → case 3 goes green-wrong (kill→0); use `process.exit(128)` → case 3 fails (wrapper exits numeric 128, no signal) AND risks conflating case 2; treat numeric 143 as a signal → case 2 reddens. **Why first:** a killed child reading exit 0 (or a signal laundered to a number) can silently corrupt the evidence of *every later child's* executed acceptance test — a promotion/ABI/F35 test that KILLS a process and trusts `forge`'s exit code/signal would misread it. This must be true before any later test is trustworthy. |
| **1** | **Store-compatibility policy** | Destructive DDL off the open path; schema-version stamp + forward refusal gate; legacy-column convergence → explicit quiesce-gated migration; **backward-compatible overlap-window evolution** (correction #5: nullable/defaulted-only additions, no new constraint rejecting an in-flight old writer, old-writer/new-reader tolerated, destructive migration as a one-way rollback boundary). Fixes read-only-open-still-migrates (`db.ts:169`). | BD-15 | Two-process **F35** on one real DB, **incl. the read-only-command variant AND both directions** (old-writer/new-reader; new-writer/old-reader). Red today: `DROP COLUMN` killing A's insert. Mutants: re-add destructive DDL to the open path; add a `NOT NULL`-no-default column and show an old writer breaks; guard only the writable entry. |
| **2** | **Release closure + manifest + R1/R2 provenance** (**LANDED as FG-569** — inert: no promotion, no `current` symlink) | Builder producing a self-contained, **immutable (read-only-at-rest)** release: entry + source + **entire `node_modules`** + **compiled native binding** + manifest (commit SHA, absolute interpreter path, ABI, lockfile identity). **exec-not-spawn landed here**; the two-process `spawn(tsx)` structure is gone — the live `bin/forge` is a `#!/bin/sh` shim that `exec`s node once with tsx in-process. **R1** provenance (`process.execPath` of the CLI process). **R2 provenance (correction #1): the exit RECORDER captures its OWN interpreter path, ABI, and release identity, from inside the recorder process — NEVER inferred from R1.** | **R1, R2** | **EXECUTE the release entry under a hostile PATH — incl. NO NODE AT ALL** — real output. Assert **from the running process** `process.execPath`==manifest interpreter and `process.versions.modules`==manifest ABI (**R1**). **R2: EXECUTE the recorder and assert IT records its own `process.execPath`/ABI/release id from inside itself; mutant — infer R2 from R1 (copy the CLI's value) → must go red because the recorder can run under a different interpreter than the CLI.** Torn-closure: release with mismatched `node_modules` **refused at build**. |
| **3** | **Bounded ABI assertion** | Replace `node-preflight`'s minimum-major floor with an exact ABI assertion against the manifest, before any native load. | — | **EXECUTE under a real too-NEW ABI-incompatible Node** (v26/ABI 147, on this host) → named refusal, **not** opaque `ERR_DLOPEN_FAILED`; likewise too-old. **Red baseline today** (`node-preflight.ts:26` admits Node 26). Mutant: revert to `>=` → too-new red. |
| **4** | **Atomic promote/rollback + PATH shim + env-sanitization contract** | The `current` pointer, atomic rename swap, rollback, near-frozen `/bin/sh` shim, `forge-dev` preserved; the **external-artifact contract** (immutable/versioned interpreter install, validate-before-select, retain-while-referenced, no in-place replace, atomic/frozen shim — see §1). **Env-sanitization contract (correction #2): the launcher neutralizes caller Node/runtime-injection vars (`NODE_OPTIONS`, `NODE_PATH`, and peers) so ambient env cannot redirect or block the pinned interpreter.** Swap **retains**; **NO release GC** (correction #6). | promotion, F29-env | **F26/F27/F28** by execution; **F27 also covers interrupted interpreter-install and interrupted shim-install** (correction #4). **T9 test includes a lazy NATIVE binding load AND a CJS require** (both proven runtime-uniform). **Env mutation (correction #2): with an absolute pinned interpreter, set `NODE_OPTIONS=--import <evil>` → assert the injected module does NOT run and forge behaves identically to clean env; set a `NODE_OPTIONS` that would prevent start → assert forge still runs. Red baseline PROVEN today: injection runs before forge.** F25: dev broken → `forge-dev` **must FAIL**, stable `forge` **must SUCCEED**; mutant — `forge-dev` execs the stable release → red. |
| **5** | **Installed-surface compatibility** | `~/.forge` seeds/workflows/routing-policy (**copies, not symlinks** — verified), hooks, scripts, project `.forge` assets, dashboard: for each — promotion re-installs / version-pins / explicitly out of the control path. | — | Executed: an installed copy **older** than the promoted runtime → named, actionable failure, not a silent mis-run. |

**Ordering:** **0 first (prerequisite), then 1.** Child 0 is a prerequisite because a killed child reading exit
0 can invalidate the executed evidence of every later child (correction #8). Child 1 is next: BD-15 constrains
promotion, and **promotion is what creates concurrent versions** — landing the runtime work first would make
the store hazard *more* likely. Both 0 and 1 are fully independent of the runtime work and independently
valuable.

**Revised R-ownership map (correction #1):** **R1 → Child 2** (CLI `process.execPath`). **R2 → Child 2**, but
captured **independently inside the recorder**, never inferred from R1. **R3 → the R3/R4 provenance CONTRACT
is Child 2's; the R3 IMPLEMENTATION is FG-555's** (resolved in the recorder, per corrected C2). **R4 →
FG-555**, and only where a workload actually performs a nested resolution (not universal).

**Not in this slice:** FG-555's R3/R4 *implementation* (FG-553 ships only the **contract**); FG-552's wait
primitive; FG-562's claim; FG-563's OQ-2 decision. **FG-553 does not wait on FG-555 to close.**

---

## 4. Falsification-oriented acceptance matrix (F23–F31, F35, T9)

Every case **executes**; each names the mutant that must redden it and the **hollow version to reject**.

| F | Fault | Required | Executed how / red baseline | **Reject this hollow version** |
|---|---|---|---|---|
| **F23** | Dev source made syntactically invalid | Stable readers + observer still work | Write a real syntax error into the **dev worktree**, then RUN machine-wide `forge` → exit 0, real stdout. **Red by construction today** (the FG-425 AC5 incident). Mutant: point `current` at the dev worktree → must redden. | Grepping that `bin/forge`'s path doesn't contain the worktree. **Source-pattern match.** |
| **F24** | Transient missing-export | Stable commands work **in this AND unrelated projects** | Remove a cross-file export in dev; run a stable command **in a different project dir** → success. | Testing only the current project — the "unrelated project" clause is the one most likely to be quietly dropped. |
| **F25** | Live-source cmd on broken source | Dev cmd fails **locally**; stable unaffected | **Two executions:** `forge-dev` → **must FAIL**; then `forge` → **must SUCCEED**. Mutant: `forge-dev` accidentally execs the stable release → must redden. | Asserting only "stable works". That is satisfied by a `forge-dev` that silently runs the stable release — **destroying the live-source loop the PRD forbids removing.** |
| **F26** | Validated promotion | Whole closure moves atomically; no mixed tree | Observe **from the running process**: release id, `process.execPath`, ABI all == B's manifest. | Reading the symlink target. Proves nothing about what the process loaded. |
| **F27** | Promotion interrupted — **now THREE artifacts (correction #4)** | Previous stable stays selected and usable; no half-installed external artifact is reachable | (a) Kill mid **`current`-swap** → `forge` still runs A. (b) Kill mid **interpreter-install** → no release references a half-installed interpreter; store unchanged. (c) Kill mid **shim-install** → previous shim intact, `forge` still runs. | Checking only the `current` pointer. **The interpreter and shim are outside the closure and were the untested half.** |
| **F28** | Promotion with in-flight launch | Runtime identity diagnosable; store policy holds; anchored process unaffected | Anchored process + swap + **lazy NATIVE binding load AND lazy CJS require** (both proven runtime-uniform — the real hot path is native). **Retention invariant enforced.** | An ESM-only T9 test. **My own first probe was exactly this and it was insufficient — corrected.** |
| **F29** | Hostile ambient ENVIRONMENT (not just PATH — correction #2) | Control plane **RUNS** the pinned interpreter, and **no caller env var redirects, injects into, or blocks it** | Bare `forge` from a shell the operator did **not** pre-sanitize — **incl. one with NO node on PATH.** **PLUS env-injection (proven red today):** `NODE_OPTIONS=--import <evil>` → the injected module must **not** run; a `NODE_OPTIONS` that would prevent start → forge still runs; `NODE_PATH` set → does not alter resolution. *"Fails cleanly" is NOT a pass.* | A caller-applied PATH pin (**containment, not isolation**) **AND** a fix that pins only the interpreter PATH while leaving `NODE_OPTIONS`/`NODE_PATH` live — **proven insufficient: injection runs before forge even with an absolute pinned interpreter.** |
| **F30** | Provenance | R1–R4 each captured/derived/declared-unknowable | **R1** asserted from the running CLI process; **R2 asserted from inside the RECORDER process, independently — mutant: infer R2 from R1 → red (recorder may run under a different interpreter)**; R3 resolved **in the recorder** (corrected C2), R3/R4 impl honored by FG-555. Recording argv ≠ resolving R3; the recorder's `process.execPath` proves **R2 only**, never R1/R3/R4. | Recording argv and calling it provenance; **deriving R2 from R1.** |
| **F31** | Incompatible ABI | **Refused before native load** | Real Node 26 (ABI 147, on this host) → **named refusal**. Pass condition **IS a clean refusal**, not a successful run and not `ERR_DLOPEN_FAILED`. | Asserting "the control plane runs" — that would **reject a correct F31.** |
| **F35** | Two versions, one store | BD-15 overlap-window policy holds; no destructive DDL under an in-flight peer; **backward-compatible both directions** | Two real processes, one real DB — **incl. the read-only-command variant** (`db.ts:169`) **AND old-writer/new-reader** (A keeps writing old-shape rows while B reads). | Testing only writable opens, or only new-writer/old-reader. **The read-only path migrates too, and old-writer/new-reader is the direction most likely dropped.** |
| **T9** | Mid-flight promotion | Anchored process unaffected; **release never GC'd while anchored**; **no automatic GC at all in this slice** | Anchored process + swap + lazy **native** load + lazy **CJS require**; swap + **delete** → next lazy load fails, so deletion of an anchored release must be **prevented**, not merely observed. Slice ships **swap-and-retain only**. | An ESM-only probe (corrected). **A test that permits automatic GC** — this slice ships none until a proven anchored-process lifetime mechanism exists. |

---

## 5. Risks / open

- **RESOLVED — CJS `require()`** is settled by execution (§1, T9): CJS anchors identically to ESM and native
  dlopen; runtime-uniform. No longer open.
- **RESOLVED-with-consequence — ambient env can subvert an absolute pinned interpreter (correction #2).**
  PROVEN today: `NODE_OPTIONS=--import ./evil.mjs` runs attacker code *before* forge, and a bad `NODE_OPTIONS`
  *prevents* forge from starting — **even with an absolute pinned interpreter and a clean PATH.** So interpreter
  pinning is necessary but not sufficient; the launcher's env-sanitization contract (Child 4) is what closes
  F29's environment axis. Red baseline exists now.
- **HIGH — the PATH shim + interpreter store are outside the atomic closure.** A genuine crack, stated not
  papered over; the external-artifact contract (§1) and F27(b)(c) bound it but do not make it atomic with a
  release.
- **MEDIUM — no schema-version stamp exists today**, so the forward gate buys nothing against *already
  installed* binaries. It makes every **future** promotion safe. Honest limit.
- **MEDIUM — disk retention is unbounded by design; this slice ships NO automatic GC** (correction #6). A
  release is reclaimed only by explicit operator sweep; automatic GC waits for a proven anchored-process
  lifetime mechanism in a later ticket.
- **RESOLVED — `bin/forge` exit laundering was scoped as CHILD 0 and has LANDED (`97363ca`, PR #119)**
  (correction #8). Before it landed, **every executed acceptance test in this slice that kills a process and
  trusts `forge`'s exit code/signal would have misread it** (a kill read as success), which is exactly why it
  went first. Child 0's fix was signal fidelity (re-raise the spawned child's signal), not `process.exit(128)` —
  verified by execution across all four cases, all three mutants killed. **FG-569's exec-not-spawn has since
  superseded it: the live `#!/bin/sh` `bin/forge` `exec`s node once, so there is no child to re-raise and a
  signal reaches the single process directly (the FG-567 signal-fidelity guard was rewritten for the exec
  form).** See the Child 0 row.

---

## 6. PRD reconciliation (correction #7)

- **C1 has been RECONCILED into the PRD (FG-568, `275ac63`).** It was a factual correction to BD-15's own
  evidence (each process's first store open, including a logically read-only caller, can bootstrap a writable
  handle and migrate), strengthening not contradicting it. BD-15's premise and the store rows now read "every
  open, including read-only callers' first open" (PRD BD-15 + the 2026-07-15 revision-log entry), and the
  destructive `DROP COLUMN` is confined to the operator's quiesce-gated `forge store converge`. FG-573 then
  reconciled the R1/R2 current-state (FG-569 exec entry + provenance); R3/R4 (FG-555) remain open.
- **C2 does NOT go into the PRD** (corrections #3 + #7) — in any wording. It is an implementation-informing
  note for FG-553/FG-555, recorded in §2 only. Its earlier "R4 exists on every launch" phrasing was wrong and
  has been corrected here; nothing about it reaches the accepted contract.
- **C3** is now Child 0; no PRD change (it is a code defect, not a design record).

## 7. Gate

**STOP. Operator re-review required before any implementation begins.** No child tickets filed. On approval:
reconcile C1 into the PRD (maintainer), file children **0–5** against this plan, then dispatch **Child 0
only** (the signal/exit-fidelity prerequisite) — because every later child's executed evidence depends on
`forge` not reporting success on a kill. **UPDATE: Child 0 has since LANDED as `97363ca` (PR #119)**; the
prerequisite is satisfied. **Child 1 has LANDED (`275ac63`, PR #120), and Child 2 has LANDED as FG-569**
(exec-not-spawn entry + inert release closure + manifest + R1/R2 provenance — still INERT: no promotion, no
`current` symlink, no PATH change). Children **3–5 remain planned** and unchanged. **C1 has since been
reconciled into the PRD (FG-568), and the R1/R2 current-state reconciled (FG-569/FG-573)** — see §2/§6.

---

## Appendix A — Durable, reproducible architecture probes (corrections #2, #3)

**These are genuinely rerunnable, not pseudocode.** The actual self-contained scripts and their literal
captured outputs are committed alongside this plan:

| probe | script (rerunnable) | literal output |
|---|---|---|
| T9 anchoring — ESM + CJS + native dlopen | `docs/plans/fg553-probes/t9-anchoring.sh` | `…/t9-anchoring.out` |
| NODE_OPTIONS subverts a pinned interpreter | `docs/plans/fg553-probes/node-options-injection.sh` | `…/node-options-injection.out` |
| bin/forge signal fidelity (Child 0) | `docs/plans/fg553-probes/signal-fidelity.sh` | `…/signal-fidelity.out` |

Each script builds its own fixtures (including a fresh copy of the repo's real
`node_modules/better-sqlite3/build/Release/better_sqlite3.node`), prints its runtime identity, and reproduces
its `.out` verbatim. Run: `NODE=<abs-node> bash docs/plans/fg553-probes/<script>.sh`.
**Runtime identity captured in every `.out`:** `node v24.17.0`, `NODE_MODULE_VERSION` (ABI) **137**,
`darwin arm64`.

### A1 — T9 anchoring (literal output, `t9-anchoring.out`)
```
mjs — swap, RETAIN old release:  anchored to A → lazy native dlopen -> release A          (SAFE)
mjs — swap AND DELETE:           anchored to A → lazy native dlopen FAILED -> dlopen(...)  (FATAL)
cjs — swap, RETAIN old release:  anchored to A → lazy require -> A ; native dlopen -> A    (SAFE, == ESM)
cjs — swap AND DELETE:           anchored to A → lazy require FAILED -> MODULE_NOT_FOUND    (FATAL, == ESM)
```
**Conclusion (uniform ESM/CJS/native):** a process anchors at first resolution and stays in that release;
swap-and-retain is safe; **deleting an anchored release is fatal at the next lazy load** (native dlopen is
Forge's real hot path). → retention invariant; **no automatic GC this slice.**

### A2 — NODE_OPTIONS subverts an absolute pinned interpreter (literal output, `node-options-injection.out`)
```
baseline (clean env, absolute interpreter):   [forge] real entry point ran
NODE_OPTIONS=--import ./evil.mjs:              [INJECTED] attacker code ran BEFORE forge   THEN  [forge] real entry point ran
NODE_OPTIONS=--not-a-real-flag:                node: --not-a-real-flag is not allowed in NODE_OPTIONS   (startup blocked)
```
**Conclusion:** an absolute pinned interpreter path is necessary but **NOT sufficient** — ambient
`NODE_OPTIONS` injects before forge and can block startup. F29 needs the env-sanitization contract (Child 4);
the mutant "pin PATH but leave `NODE_OPTIONS` live" is proven red.

### A3 — bin/forge signal fidelity (literal output, `signal-fidelity.out`) — proves the Child 0 fix

> **Superseded by FG-569 (exec-not-spawn).** This probe records the *spawn-era* Child 0 fix. The live
> `bin/forge` is now `#!/bin/sh` and `exec`s node once — there is no spawned child, so the re-raise below no
> longer applies; a signal reaches the single `forge` process directly (the FG-567 signal-fidelity guard was
> rewritten for the exec form). The captured output is retained as the historical Child 0 record.

Child 0's spawn-era wrapper re-raised the child's own signal (`if(signal) process.kill(process.pid,signal); else
process.exit(code??0)`). The script uses a **direct process observer** of the wrapper, so the two layers are
kept explicit (correction #3):
```
child exits 0:            DIRECT observer of WRAPPER: code=0    signal=null      → decision=EXIT 0
child NUMERIC exit 143:   DIRECT observer of WRAPPER: code=143  signal=null      → decision=EXIT 143   (stays numeric — the F8 case)
child killed by SIGTERM:  DIRECT observer of WRAPPER: code=null signal=SIGTERM   → decision=RE-RAISE SIGTERM
```
**Layering, stated explicitly (correction #3):** a **direct process observer** (parent `waitpid`, forge's own
watcher, Docker) sees the wrapper's true disposition — for a signalled death, **`code=null, signal=SIGTERM`
(or `SIGKILL`)**; that is the OS-signal evidence. A **shell** later encodes a signalled child as
`$? = 128+signum` (SIGTERM→143, SIGKILL→137), **but that number is NOT itself OS-signal evidence** — a
program can also deliberately `exit(143)` (the F8 case above, where the direct observer correctly sees
`signal=null`). The two must never be conflated: Child 0 preserves `signal` for the direct observer;
`process.exit(128)` would erase it and leave only an ambiguous number.

**The pre-fix `bin/forge`** (`process.exit(code ?? 0)`, before `97363ca`): a SIGKILL'd child gave `code=null` → forge
exited **0** — the red baseline Child 0 **removed**. Child 0's spawn-era `bin/forge` then re-raised the child's own
signal (a SIGKILL'd child gave `code=null, signal=SIGKILL` to the direct observer). **FG-569 has since replaced the
spawn structure with the `#!/bin/sh` exec entry: there is no child, so a signal reaches the single `forge` process
directly** — the FG-567 signal-fidelity guard was rewritten for that exec form.

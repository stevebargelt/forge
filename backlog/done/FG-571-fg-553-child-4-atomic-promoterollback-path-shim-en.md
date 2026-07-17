---
id: FG-571
type: story
status: done
title: "FG-553 Child 4: atomic promote/rollback + PATH shim + env-sanitization contract (swap-and-retain, no GC)"
created: 2026-07-14
closed: 2026-07-17
closed_commit: 2f80496
---

**Parent:** FG-553 · **Epic:** FG-561 · **Plan:** `docs/plans/fg553-slice1-architecture.md` (Child 4)
**Depends on:** FG-569 (release + manifest), FG-570 (ABI assertion).

## Problem

FG-569 builds an inert release; nothing promotes it to be the machine-wide `forge`. Promotion must be atomic
and reversible, must not break an in-flight process, and must not let the caller's ambient environment
subvert the pinned interpreter (proven: `NODE_OPTIONS=--import <evil>` injects before forge, and a bad
`NODE_OPTIONS` blocks startup, even with an absolute pinned interpreter).

## Scope

- **`current` pointer + atomic promote/rollback** — a release-dir + atomic `current` symlink swap; rollback
  is a pointer swap. An interrupted promotion leaves the previous stable runtime selected and usable.
- **The near-frozen `/bin/sh` PATH shim** (the machine-wide `forge`): resolve `current` → read the
  **Forge-authored canonical execution descriptor inside the immutable release `current` selects** → `exec`
  the interpreter it names. **The shim never parses the release manifest**; trusted Node validates that
  manifest as the authority on what the release is. Installed atomically (temp + rename); its contract change
  is an install-level breaking change, gated behind an explicit re-install.
  *(Mechanism corrected 2026-07-16 — see the revision log. The original "read manifest → exec the manifest
  interpreter" shape was proven exploitable by a read-only red-security audit.)*
- **Promotion is a staged-unit pipeline (2026-07-16):** candidate input → **trusted materialization into a
  new staging dir** (a caller-controlled candidate directory is NEVER promoted in place) → parse + validate
  the **staged bytes** → generate the canonical descriptor inside that unit → validate the complete unit →
  **freeze** → atomic publication → **ONE `current` swap**. The descriptor ships INSIDE the unit, never as a
  separately swapped sibling of `current` — a record swap plus a pointer swap is not atomic as a pair and
  would open a fresh mismatch window.
- **External-artifact contract:** the interpreter store is immutable/versioned, validated before a release
  references it, retained while referenced, never replaced in place.
- **Env-sanitization contract:** the launcher neutralizes caller Node/runtime-injection vars
  (`NODE_OPTIONS`, `NODE_PATH`, and peers) so ambient env cannot redirect or block the pinned interpreter.
  **Bounded, not broad:** an explicit per-variable list with a recorded rationale — never a wholesale env
  wipe. Unrelated operator environment (`PATH`, `HOME`, `FORGE_HOME`, `AWS_*`, `NTFY_*`, `TERM`, locale)
  survives untouched.
- **Release-identity provenance is FAIL-CLOSED (added 2026-07-16 — HIGH correctness hole found in the
  FG-571 propagation census).** FG-569's shipped `renderEntry` exports `FORGE_RELEASE_ID` only when its
  shell-builtin manifest-read loop finds an `"id"` line; when that read yields nothing, a
  **caller-supplied `FORGE_RELEASE_ID` survives and is recorded as provenance** — contradicting FG-569's
  own rule that release identity is derived from the manifest and NEVER read from ambient env. Unsetting
  before the read stops the spoof but is **not sufficient**: it silently degrades a real release's
  provenance to unknown. The contract is therefore:
  - **`forge-dev` (live source):** unset ambient `FORGE_RELEASE_ID`; dev provenance stays **null** (a dev
    entry has no manifest — null is the honest answer, per FG-569's "not recorded, never manufactured").
  - **Stable shim / release entry:** unset ambient `FORGE_RELEASE_ID`, derive identity **solely** from the
    selected release's manifest, and **fail closed with a named error** when that identity is absent,
    malformed, or unreadable. **Never continue a supposed release with a missing/null identity.**
  This lands in FG-571 because promotion has not shipped yet: closing it here prevents vulnerable releases
  from ever becoming machine-wide.
- **Swap-and-RETAIN; NO automatic GC.** T9 (host-verified): a process anchors to a release at start and a
  pointer swap does not tear it, but **deleting a release with anchored live processes is fatal** (ESM,
  CJS, and native dlopen all uniform). So a release is never GC'd while anchored; automatic GC waits for a
  proven anchored-process lifetime mechanism in a later ticket.
- **The stable/dev SPLIT is created here, not merely preserved (clarified 2026-07-16).** `bin/forge-dev`
  does **not exist today**: `package.json` `bin` declares only `forge`, and the machine-wide `forge` is
  currently an npm-link symlink into the live checkout — so the live-source path and the machine-wide path
  are **the same artifact**. FG-571 splits them, and F25 is what proves the split is real.

## Acceptance (EXECUTED)

- **F26:** validated promotion → new commands atomically use the promoted version; no mixed tree visible.
- **F27:** interrupted promotion → previous stable runtime stays selected; also covers an interrupted
  interpreter-install and an interrupted shim-install.
- **F28 / T9:** a process anchored to a release is unaffected by a mid-flight swap (test a lazy NATIVE binding
  load AND a lazy CJS require); a release is never deleted while anchored.
- **F29 (env):** bare `forge` from a shell the operator did NOT pre-sanitize runs — including a node-free
  PATH; `NODE_OPTIONS=--import <evil>` does NOT inject (proven red today); a blocking `NODE_OPTIONS` does not
  prevent startup. A caller-applied PATH pin is containment, not isolation — it does not satisfy F29.
- **F25 (BEHAVIORAL — proves the stable/dev split, not filenames; sharpened 2026-07-16):** with the live
  checkout genuinely broken:
  - `forge-dev` **must FAIL** from that checkout;
  - stable `forge` **must still EXECUTE the promoted release**;
  - the two **must report DIFFERENT provenance** (asserted from the running processes — dev identity null,
    stable identity the selected release's manifest id — not from file paths or symlink targets);
  - **mutant:** a `forge-dev` that delegates to / execs the stable release **must go RED** (it would destroy
    the live-source loop the PRD forbids removing);
  - installation happens **only in a disposable prefix** — never `npm link`, never touching the real
    machine-wide shim or `current` pointer.
- **FG571-RI (NEW — fail-closed release identity; the census HIGH):** release identity is derived solely from the
  selected release manifest and never from ambient env. Executed regression matrix, every cell:
  - **poisoned env** (`FORGE_RELEASE_ID=<forged>`) against a **valid** manifest → the forged value is
    ignored; the reported identity is the manifest's;
  - manifest identity **missing** → **named error, fail closed** (not null, not the ambient value, not a
    silent run);
  - manifest identity **malformed** → named error, fail closed;
  - manifest **unreadable** → named error, fail closed;
  - `forge-dev` with poisoned ambient `FORGE_RELEASE_ID` → identity **null** (dev has no manifest);
  - **mutant:** restore the FG-569 read-loop behavior (no unset before read) → the poisoned-env case must
    go RED. **Mutant:** degrade a missing/malformed identity to null-and-continue instead of failing closed
    → those cases must go RED.
  Rationale: unset-before-read alone would prevent spoofing while quietly degrading real release provenance
  to "unknown" — both halves must be proven.

- **F33 (NEW 2026-07-16 — manifest→exec trust boundary; closes 6 confirmed HIGH audit findings).**
  The required invariant, executed end-to-end:

      candidate input → trusted materialization → parse + validate STAGED bytes →
      generate canonical descriptor → validate complete unit → freeze →
      atomic publication → ONE `current` swap

  Executed adversarial regressions, each **mutation-sensitive** (prove the vulnerable version is
  EXPLOITABLE — attacker code actually runs, evidenced by a filesystem marker — not merely that the fixed
  version refuses):
  - **duplicate JSON keys** — proven divergence: `JSON.parse` (promotion) takes the LAST value, the old sh
    reader took the FIRST, so a candidate that PASSED validation exec'd `/tmp/attacker-node`;
  - **invalid JSON carrying forged key-shaped lines** — drove exec without passing validation at all;
  - **absolute** and **traversal** entries;
  - **entry symlink** pointing outside the release;
  - **interpreter-store path that is a symlink** to outside bytes (lexical `isStoredInterpreter` accepted it);
  - **mutation of the SOURCE candidate DURING promotion**;
  - **mutation AFTER validation but BEFORE pointer publication** (validate-to-swap TOCTOU);
  - **mismatched descriptor and manifest**;
  - **partial/torn staging** and **interrupted pointer swap**.

  Descriptor schema is strict and fail-closed: **exact field count**, restricted character set, no
  duplicate/extra/missing fields, values consumed through **quoted shell variables and never evaluated as
  shell syntax**. Entry and loader remain **FIXED schema constants** baked into the shim — not dynamic
  record values; only what must vary (interpreter, release id) is in the descriptor. Release identity is
  **re-validated by trusted Node after startup** against the immutable authoritative manifest.

## Not in scope
- Automatic release GC (deferred — needs a proven anchored-process lifetime mechanism).
- Installed-surface (seeds/hooks/dashboard) compatibility — FG-572.
- A POSIX-sh JSON parser; a separately published record/`current` pair; process supervision; reopening
  OQ-6 / BD-14 / BD-15 / T9.

## Revision log
- **2026-07-16** — Scope + AC expanded before implementation, on operator direction, from two findings in the
  FG-571 pre-implementation propagation census: (1) `forge-dev` does not exist, so this ticket **creates**
  the stable/dev split rather than preserving an existing command — F25 restated behaviorally (provenance
  divergence + delegation mutant + disposable-prefix-only installation); (2) the FG-569 entry lets a
  caller-supplied `FORGE_RELEASE_ID` survive a failed manifest read — closed here as **FG571-RI**, fail-closed,
  because promotion has not landed yet and this is the bounded place to fix it before vulnerable releases
  become machine-wide. No change to OQ-6 / BD-14 / BD-15 / T9 or the accepted promotion architecture.
- **2026-07-16 (mechanism correction, operator-directed).** The bounded review-loop stopped at
  `needs_fix_max_rounds` with an open HIGH (`manifest.entry` traversal), having found one real hole per
  round. The operator STOPPED the iterative loop and commissioned one bounded read-only red-security audit
  of the manifest→exec trust boundary. It returned **6 confirmed HIGH findings**. Three shared one root
  cause: **the shim parsed the CANDIDATE's raw manifest with a hand-rolled POSIX-sh line reader whose
  semantics differ from `JSON.parse` and which enforced fewer checks than promotion.** Verified by execution
  on the host —
  `{"id":"safe","interpreter":"/tmp/attacker-node","entry":"src/cli/index.ts","interpreter":"/store/node/bin/node"}`
  → `JSON.parse` validates `/store/node/bin/node`, the sh reader execs `/tmp/attacker-node`. A candidate that
  PASSED `validateCandidate` executed a different interpreter.
  Rather than teach an sh line-matcher to replicate `JSON.parse` (unbounded machinery, and the shim has no
  interpreter yet — finding one is its job), the invariant MOVED: all parsing/validation happen once in
  trusted Node, and the shim consumes only forge-authored data. The orchestrator's first proposal — a
  descriptor swapped as a SIBLING of `current` — was **rejected by the operator**: a record swap plus a
  pointer swap is not atomic AS A PAIR and merely relocates the mismatch window. The descriptor therefore
  ships INSIDE the immutable staged unit, so the single `current` swap selects both.
  **Bounded correction to the MECHANISM, not the architecture:** OQ-6's substance (release directory +
  atomic `current` symlink + POSIX-shell PATH shim + shared versioned interpreter store; exec-not-spawn) is
  unchanged, as are BD-14/BD-15/T9 — anchoring is still the shim's single `cd -P` on `current`.
  Recorded as **F33**; plan §1 (OQ-6 + the PATH shim contract) updated to match.

## Threat boundary (operator decision, 2026-07-17) — what FG-571 defends, and what it does not

Four read-only red-security audits ran against this work. The first three found **eleven confirmed HIGH
findings, every one closed with an executed exploit-proving mutant.** The fourth returned three HIGH whose
schedules all require the *same local principal that owns `$FORGE_HOME`*. That is the boundary, and it is
recorded here rather than chased.

### Protected (real, defended, proven by execution)
- **Untrusted candidate content** — a release built elsewhere, downloaded, or handed over, which the operator
  promotes. Closed: duplicate-key parser divergence (`JSON.parse` took the last value, the shim's POSIX-sh
  reader took the first, so a candidate that PASSED `validateCandidate` exec'd `/tmp/attacker-node`), forged
  non-JSON key-shaped lines, `manifest.entry` traversal/absolute/near-match, candidate symlinks anywhere in
  the unit (incl. `forge-exec` and `forge-loader.mjs`), symlinked path components, and validate-one-directory-
  select-another.
- **Malformed manifests** — fail-closed by name; a release that cannot state who it is does not run.
- **Hostile ambient caller environment (F29)** — a caller who can invoke `forge` but does NOT own
  `$FORGE_HOME`: `NODE_OPTIONS=--import <evil>`, startup-blocking `NODE_OPTIONS`, `NODE_PATH` redirection,
  node-free PATH, incompatible node first. Proven: an absolute pinned interpreter is necessary but NOT
  sufficient — the mandatory mutant shows PATH-pinning alone still executes injected code, invisibly.
- **Crashes and interrupted publication** — SIGKILL mid release-install, interpreter-install, shim-install and
  mid `current`-swap; nothing partial is ever selectable, the previous stable runtime stays usable.
- **Concurrent supported Forge operations** — the `(current, previous)` pair publishes as ONE swap;
  content-addressed interpreter identity makes a race for the same identity benign (identical identity ⇒
  identical bytes), proven with N real racing processes.

### HONEST LIMIT — same-principal tampering is OUT OF SCOPE
**A principal able to arbitrarily rewrite `$FORGE_HOME` can subvert Forge and the surrounding user account.**
That principal is the operator's own UID: it already owns `~/.zshrc`, the Forge checkout, the installed shim,
and the validator itself. Before FG-571 the machine-wide `forge` was an npm-link symlink into that same
writable checkout, so this axis is strictly *improved* by FG-571 and was never closed by the status quo.

**`chmod`/read-only-at-rest is an operational ACCIDENT BARRIER, not a security boundary against its owner.**

Stronger hostile-host protection would require a **separate trust domain** — another OS principal, root-owned
storage, or hardware-backed signing. That is **not FG-571 scope**, and is deliberately **not filed as a
follow-up**: it is an optional product/security direction, not missing closure for this ticket.

### Disposition of the fourth audit's F1–F3 (findings preserved, not altered)
Confirmed from that audit's own evidence at tip `3dd566f`:
1. *"No in-place rename, repair, thaw, or deletion of an existing published unit was found on the reviewed
   promotion and rollback paths."* ✓
2. Selection publishes as one selection-symlink swap; the shim resolves `current` once. The
   `.unit-<id>-<rand>` name is not created exclusively — the auditor recorded this as a **residual
   availability/race concern** and explicitly *"did not establish a direct content-substitution schedule"*. No
   legitimate concurrent schedule changes selected bytes between validation and selection. ✓
3. Each of F1–F3 requires arbitrary `$FORGE_HOME` write, in the auditor's own words:
   - **F1** (`paths.ts:74`, evidence ledger) — *"write access to `$FORGE_HOME` (which necessarily permits
     planting `releases/`)"*. The ledger would be trusted by location — the same mistake one directory up.
     Fixing it needs *"a key unavailable to those principals"*, which does not exist for a same-UID owner.
   - **F2** (`promote.ts:1106`, validate-to-select window) — *"the same local account that owns the forge
     home"*.
   - **F3** (`release.ts:673`, shim execs without re-verifying) — *"the release owner or another principal
     able to restore write bits"*.

**Disposition: OUT OF SCOPE — same-principal tampering.** Not defects against this ticket's threat model.
Each recommended fix relocates the trust root to another directory inside the same home directory the
adversary owns, which is an infinite regress, not a fix. The findings stand on the record unaltered; only
their disposition is recorded here.

## CLOSURE — AC-to-evidence walk (merged `2f80496`, PR #124)

Every line walked against **executed** evidence at the exact merged tip. `147/147` across all six FG-571
integration suites run together **on a macOS host**; `test:all` 2420 + 79; typecheck clean; both required CI
checks (`test`, `test-extended`) green at `ac6c83b`, the tip that merged as `2f80496`. Governing rule
throughout (FG-551): *a property about the FINAL RUNTIME must be demonstrated by EXECUTING or
MUTATION-TESTING the final artifact — a source-pattern match is not evidence.*

- **F25 — behavioral stable/dev split (4 tests).** With the live checkout genuinely broken: `forge-dev`
  FAILS, stable `forge` still EXECUTES the promoted release, and the two report **different provenance
  asserted from the RUNNING PROCESSES** (dev id null, stable id the selected release's) — not from paths or
  symlink targets. **Mutant:** a `forge-dev` that delegates to the stable release goes RED. Installation only
  ever in a disposable prefix. *(`fg571-env-identity.integration.test.ts`)*
- **F26 — atomic promotion (2).** Promote A then B; release id, `process.execPath` and ABI all read **from
  the running process** are B's. A failed candidate validation leaves A selected and cannot report success.
  **Mutant:** swap-before-validate. *(`fg571-promote.integration.test.ts`)*
- **F27 — interruption, all four artifacts (5).** SIGKILL mid release-install, mid interpreter-install, mid
  shim-install, and mid `current`-swap. In every case nothing partial is selectable and the previous stable
  runtime still RUNS. *(`fg571-promote.integration.test.ts`)*
- **F28 / T9 — in-flight anchoring (2).** A process anchored to A completes on A across a mid-flight
  promotion to B — lazy ESM import AND lazy CJS require AND lazy NATIVE dlopen (the real hot path). New
  invocations get B. No release deleted. **Mutant:** delete the anchored release → its lazy native load goes
  RED, which is *why* promotion retains. *(`fg571-promote.integration.test.ts`)*
- **F29 — hostile ambient environment (7).** Stable `forge` runs with NO node on PATH; runs when PATH
  resolves an INCOMPATIBLE node first; `NODE_OPTIONS=--import <evil>` does NOT inject; a startup-blocking
  `NODE_OPTIONS` does not block it; `NODE_PATH` cannot redirect resolution; unrelated operator vars SURVIVE
  (sanitization is bounded, not a wipe). **MANDATORY MUTANT:** pin PATH but leave `NODE_OPTIONS` live → the
  injection RUNS *and forge still exits 0* — proving an absolute pinned interpreter is necessary but NOT
  sufficient, and that the failure is invisible. *(`fg571-env-identity.integration.test.ts`)*
- **FG571-RI — fail-closed release identity (25).** Poisoned `FORGE_RELEASE_ID` + a valid manifest → forged value
  IGNORED. Missing / malformed / unreadable identity → **named error, fail closed** — never null, never the
  ambient value, never a silent run. `forge-dev` + poisoned env → identity null (the honest answer for an
  entry with no manifest). **Both mandatory mutants:** restoring FG-569's read-loop reddens the poisoned-env
  case; degrading a missing identity to null-and-continue reddens the fail-closed cases.
- **F33 — manifest→exec trust boundary (54, across `fg571-trust-boundary` + `fg571-entry-containment` +
  `fg571-interpreter-store` + `fg571-unit-provenance`).** The full invariant executes end-to-end: candidate →
  trusted materialization → parse+validate STAGED bytes → forge-authored canonical descriptor → validate
  complete unit → freeze → atomic publication → ONE `current` swap. Adversarial matrix, each **mutation-
  sensitive** (the vulnerable version is proven EXPLOITABLE by a filesystem marker, not merely refused):
  duplicate JSON keys (`JSON.parse` took the LAST, the sh reader the FIRST → a candidate that PASSED
  `validateCandidate` exec'd `/tmp/attacker-node`); forged non-JSON key-shaped lines; absolute + traversal +
  near-match entries; entry symlink out; symlinked path COMPONENT; interpreter-store symlink escape; source
  mutated DURING promotion; mutation after validation before publication; descriptor↔manifest mismatch;
  torn staging; interrupted swap; `forge-exec` and `forge-loader.mjs` as symlinks out; two different
  interpreters with the SAME version+ABI getting DISTINCT paths; N real processes racing one identity.

**Also landed beyond the original AC**, each from a red finding: the `(current, previous)` pointer **pair
commits in ONE swap** (an interrupted promotion previously lost the rollback target); the interpreter store
is **content-addressed with the FULL SHA-256** (a 64-bit truncation made the "immutable" key collidable); and
**selection evidence is the bytes, never the pathname** (a path-equality shortcut was being treated as
provenance, and the occupied-id branch validated one directory then selected another after deleting the
validated unit).

**Threat boundary:** see the section above — protected surfaces are proven; same-principal `$FORGE_HOME`
tampering is an honest limit, dispositioned, not a defect against this ticket.

**Not in scope, unchanged and verified:** no release GC, no PID registry, no supervision; `forge dashboard`
still refuses in release mode (FG-572). **Containment held for the entire campaign:** the real
`~/.forge/current`, `~/.forge/releases` and `~/.forge/interpreters` were never created, the machine-wide
`forge` still resolves to the operator's live checkout, the provider registry at `~/.forge/runtimes` is
untouched, and `npm link` was never run. Post-merge smoke: `forge --version` → `0.1.0` and `forge backlog
list` OK through the existing real symlink.


## Label correction (2026-07-17) — F32 → FG571-RI

FG-571 minted **F32** as its local label for *fail-closed release identity*. That collided with an existing
canonical id: the PRD's F-row matrix
(`docs/prds/durable-orchestration-continuation.md:543`) already defines **F32** as *"A reader arrives during
meta-record publication → a running launch never reads as absent or as 'no such launch'"*, which belongs to
**FG-552** and is referenced from FG-552's own ticket.

Leaving both would corrupt the campaign coverage map before FG-552 begins. **Not a behavioral defect** — merge
`2f80496` stands unchanged — so this is a mechanical relabel only: FG-571's local `F32` → **`FG571-RI`**
across this ticket, the production comments, and the test titles (27 occurrences in six source files).
`147/147` unchanged, typecheck clean, diff verified label-only.

**Canonical F32 is untouched and must stay that way** — neither renumbered nor altered, in the PRD or in
FG-552's ticket.

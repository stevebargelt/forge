# Decision: release-fixture temp residue is bounded by fixture lifetime and left to expire with the container; no startup sweep of stale `/tmp/fg569-rel-*` is built

**ID**: FORGE-DEC-034
**Date**: 2026-08-10
**Status**: Decided
**Decided by**: forge (FG-698)
**Supersedes**: N/A
**Scope**: forge
**Elevated from**: N/A

---

## Context

Release-tier integration fixtures build multi-GB workspaces under the container's `/tmp`.
`src/v2/release.integration.test.ts` creates ONE workspace at `:171`
(`mkdtempSync(join(tmpdir(), "fg569-rel-"))`), makes 6 `isolatedSourceFrom()` calls and 30
`buildRelease()` / `buildFromIsolatedSource()` calls beneath it, and frees the whole thing only in
a root-level `after()` (`:186-189`). Nothing is freed incrementally.

Measured during the FG-695 investigation (2026-08-09, agent container): ONE
`--test-name-pattern 'FG-575 (guard)'` run — the shared `before()` hook's single isolated source
plus a single release build — peaked at **398 MB**, and left nothing behind on a clean exit.
`node_modules` alone is 93 MB and is copied whole per isolated source (`:127`) and again into each
release closure. 3.5 GB for a full run of that file is consistent with 398 MB for one build.

This cost real time during FG-688: stranded temp space explained 77 container test failures while
CI on clean runners was green at the same sha. An environment mechanism presented itself as
product breakage.

FG-698 asks for teardown that survives partial failure (AC1/AC2), a bound on peak use (AC4),
containment of inner spawned runs (AC5) — and, in AC3, an explicit either/or about residue left
behind when the process DIES and `after()` never runs at all:

> (a) fixtures are reclaimed on a later run (e.g. a startup sweep of stale `/tmp/fg569-rel-*`
> workspaces owned by no live run), **or** (b) the ticket states with evidence why
> container-scoped leakage is acceptable and bounds it another way. Silence is not a resolution.

This ADR answers AC3. AC1/AC2/AC4/AC5 are answered by code in the same change.

---

## Problem

When a release-tier runner is SIGKILLed (OOM, timeout, container teardown mid-run), its
`after()` never executes and its entire workspace survives. Should forge grow machinery that
reclaims that residue on a later run, or should the residue be allowed to expire on its own —
and if the latter, what actually bounds it?

---

## Options Considered

### Option A: Startup sweep of stale workspaces owned by no live run

On startup (or at the head of the release tier), glob `/tmp/fg569-rel-*`, decide which entries
belong to no living process, and remove them.

**Pros**:

- Reclaims residue from a killed run without waiting for the container to exit.
- Would also help an operator running the tier repeatedly on a long-lived machine.

**Cons**:

- **There is no ownership record to key it on.** The workspaces are bare `mkdtemp` directories.
  Nothing inside them names a pid, a run, or a start token. A sweep would therefore have to key on
  a *glob plus a heuristic* — age or mtime — not on ownership.
- **The heuristic is unsafe here, because same-glob producers genuinely run concurrently.**
  `scripts/run-integration-tests.sh:57` execs a single `node --test "${FILES[@]}"` over the whole
  shard, and `node --test` runs files in PARALLEL (verified empirically in this container: two
  probe files' bodies both entered at the same millisecond; 14 CPUs available). More pointedly,
  the test at `src/v2/fg644-dirty-tree-execution.integration.test.ts:186` spawns
  `docker/forge-test.sh … src/v2/release.integration.test.ts` as an INNER `node --test` run (an
  800s spawn timeout inside a 900s test) — so an inner process mints its own
  `/tmp/fg569-rel-*` while an outer release run
  may be live against the same glob. A build that copies 93 MB of `node_modules` and then runs a
  release can look "idle by mtime" for minutes. An age heuristic can therefore delete a LIVE peer's
  workspace mid-build.
- That trade is bad on its face: it exchanges a **bounded, self-expiring leak** for a **new class
  of nondeterministic failure** — and nondeterministic teardown failures in the release tier are
  precisely the FG-688 shape this ticket exists to stop.
- **Doing it safely means owning real machinery forever.** The ownership/liveness rule is
  buildable — this repo already has both halves: `src/util/process-identity.ts` (pid + start token
  + host/boot, classified `alive` / `dead` / `unknown`, where `unknown` is never upgraded to
  `alive`) and `src/util/run-lock.ts` (stale windows, renewal, expiry-only takeover). Reusing them
  would mean stamping an identity file into every fixture root, reading it back, and honoring
  `unknown` conservatively. That is a durable maintenance surface, guarding an automatic,
  destructive, multi-GB `rm -rf` keyed on a glob — for residue that expires when the container does.
- A sweep broadened beyond the one glob is worse still: sibling integration files mint their own
  temp roots under other prefixes (`fg569-r2-`, `fg566-setup-`, `fg552-sabotage-`, and ~dozens of
  `forge-*` roots), and `/tmp/forge-work` (144 MB) is *intentionally* persistent.

---

### Option B: Accept container-scoped leakage; bound it by fixture lifetime ✅

Build no sweep. Instead shorten how much is ever live at once, and make teardown honest about what
it could not remove.

**Pros**:

- **The residue is already self-limiting, by measurement.** `/proc/mounts` in the agent container
  has **no `/tmp` entry at all** (verified: zero matching lines); the root filesystem is
  `overlay / overlay rw,…` and `df -h /tmp` reports the same `overlay` device mounted at `/`
  (110G total, 21G available). `/tmp` is the container's overlay ROOT filesystem — not a tmpfs, not
  a bind mount, not a shared scratch volume. Residue is **container-lifetime-scoped**: it is not on
  the host, no other container sees it, and it dies when the container does. "Surviving from earlier
  runs" means earlier runs inside the SAME container session.
- Nothing new to maintain, and no automatic destructive removal is introduced anywhere.
- The mechanism that actually hurt (a whole file's 3.5 GB accumulating and then stranding as one
  lump) is addressed at its source rather than swept up afterwards.

**Cons**:

- A killed run still strands whatever was live at that instant, until the container exits.
- A long-lived container that runs the release tier many times can still accumulate across runs —
  now bounded by per-run peak rather than by per-run total, but not zero.
- The reasoning is environment-dependent, so it must be re-opened rather than inherited if the temp
  root ever stops being container-scoped (see Revisit Conditions).

---

## Decision

**Chose**: Option B — accept container-scoped leakage, bound it by fixture lifetime.

**Rationale**: The evidence that makes the sweep attractive is the same evidence that makes it
unnecessary. `/tmp` here is the container's own overlay root, so the residue has a hard expiry
already — the container's lifetime — and it is invisible to the host and to every other container.
Against that, a sweep is an automatic, destructive, multi-GB removal keyed on a glob, with no
ownership record to key it on, in a tier whose files run in parallel and which spawns further inner
runs minting the SAME glob concurrently. The reachable version of the sweep can delete a live peer's
workspace mid-build. Trading a bounded, self-expiring leak for a nondeterministic mid-build deletion
is a bad trade on a personal single-user tool — it is unnecessary machinery, not a safety
improvement, and forge would own it forever.

Option A was rejected on **blast radius, not feasibility**. The liveness rule is buildable and this
repo has the parts; it just is not worth what it guards.

---

## What bounds the residue instead

1. **Fixture lifetime, per test rather than per file.** `release.integration.test.ts` pins the
   shared set at the end of `before()` (`buildRoot`, the shared `release/`, `forge-home`) and an
   `afterEach` disposes every unpinned top-level entry under the workspace. Each test's isolated
   sources, release closures and project dirs are freed as that test ends instead of accumulating
   across 30 builds. A process death therefore strands only what was live at that instant — not a
   whole file's accumulation.
2. **The bound is enforced structurally, not numerically.** A guard test declared last asserts the
   workspace's top-level entries still equal the pinned set, so anything that outlives a test — or
   any new shared fixture pinned without thought — surfaces as a failure rather than as silent
   growth. No byte threshold is asserted anywhere: a byte figure is host- and
   dependency-dependent, and degrades into a flaky number that gets raised until it means nothing.
3. **Teardown no longer strands a whole workspace on a partial failure.**
   `disposeReleaseWorkspace()` makes the tree removable, removes it, and REPORTS what survived with
   path and reason on stderr — it never throws. The previous ordering (`thawReleaseTree()` then
   `rmSync()`) lost the entire workspace to one EACCES/ENOENT, because the strict thaw threw before
   the removal ran.
4. **Inner spawned runs allocate INSIDE the outer fixture.** fg644 passes `TMPDIR` into both inner
   spawns, so a killed inner run's `fg569-rel-*` workspace lands under the outer fixture and is
   removed by the outer teardown instead of being stranded beside it.

Residue that disposal genuinely cannot remove is named on stderr with its reason, rather than
silently stranded. Diagnostics go to stderr specifically because fg644 parses inner-run STDOUT as
TAP.

---

## AC4 measurement — before/after peak temporary space

> **PLACEHOLDER — filled in by FG-698 step 8.** Both figures must come from
> `scripts/fg698-measure-temp-peak.sh` at the same sampling interval, in the same container, over
> the same file, with the exact commands recorded; plus the caveat that the figure measures ONE FILE
> IN ISOLATION while `node --test` runs files in parallel, so shard composition (FG-624's
> bin-packing) — not this file alone — decides whether the tier's peak retires ENOSPC. If the
> "before" run could not be completed (headroom or wall time), say so explicitly here and state what
> was measured instead; do not present a partial or cross-method figure as the before/after evidence.

---

## Consequences

**Positive**:

- No new destructive machinery, no ownership/liveness bookkeeping to maintain, and no risk of
  deleting a live peer's workspace.
- Peak temporary use during a release-tier file scales with the size of ONE fixture generation
  rather than with the number of fixtures, and the lifetime invariant is enforced by a test.
- A teardown fault now reports instead of stranding multi-GB silently — the FG-688 diagnosis
  ("77 container failures, green CI at the same sha") is visible in the run's own stderr next time.

**Negative / Trade-offs**:

- Residue from a killed run persists until the container exits. On a long-lived container running
  the tier repeatedly, that is still nonzero.
- The decision is explicitly conditional on the environment, so it carries a re-open obligation
  rather than being settled forever.

**Risks**:

- *Per-test disposal races a process a test spawned*, turning deterministic passes into intermittent
  EACCES/ENOENT. Mitigated by ordering — `afterEach` runs after the test body's own `finally`, so
  the dashboard tests have already SIGKILLed their process groups — and by disposal never deciding a
  verdict.
- *Someone "simplifies" by making `thawReleaseTree` itself tolerant.* That would break its fail-loud
  contract at `src/v2/promote.ts:935` (thaw the STAGING unit before `validateCandidate` and before
  the exec descriptor is authored into it) and at `src/v2/release.ts:1379` (a refused build must
  leave no release behind). The strict thaw and the tolerant disposal are deliberately two
  functions.

---

## Implementation Notes

- **Do not build the sweep later without re-reading this file.** If a future run reaches for one,
  the missing piece is not the liveness rule (`src/util/process-identity.ts` +
  `src/util/run-lock.ts` already model pid + start token + host/boot and stale windows) — it is an
  ownership RECORD written into each fixture root at creation, and a conservative `unknown` policy.
  Without both, any sweep is an age heuristic over a glob with concurrent same-glob producers.
- Disposal removes exactly the path it is handed: it never follows a symlink and never chmods or
  removes outside that path. That is why the residue-reporting case exists at all — a fixture root
  inside an unwritable parent is genuinely unremovable from inside the tree, and disposal reports it
  rather than reaching out to fix the parent.
- No hardlink/reflink sharing of `node_modules` with the invoking checkout, ever:
  `freezeReleaseFiles` would clear write bits on the operator's real dependency tree through the
  shared inodes (FG-575).

**Known remaining, deliberately not acted on**: 10 test files call the strict `thawReleaseTree`
inside cleanup; FG-698 converts 2 of them (`release.integration.test.ts:187`,
`launch-r2.integration.test.ts:40`). The other 8 — `fg571-trust-boundary`, `fg571-env-identity`,
`fg571-entry-containment`, `fg571-unit-provenance`, `fg571-promote`, `fg565-f23-f24-broken-source`,
`fg583-promoted-layout`, `launch-cli` — are the same defect class and are now a one-line adoption of
`disposeReleaseWorkspace()` each. FG-698 also forbade re-fixing the per-test try/finally fixtures it
verified as already correct, so those keep their strict thaw. `src/v2/promote.ts:935` is production
and must KEEP the strict thaw.

---

## Revisit Conditions

Re-open this decision — do not inherit it — if any of the following becomes true:

- **The release tier's temp root stops being container- or reboot-scoped.** This decision holds only
  while residue expires on its own. It does NOT hold if the tier's temp root becomes a
  host-mounted, shared, or otherwise persistent volume, where residue outlives every process that
  could have owned it.
- **The tier is run routinely outside a container.** On an operator's Linux laptop `/tmp` survives to
  reboot, which is a far weaker bound than a container's lifetime; on macOS the per-user tmpdir is
  OS-purged on its own schedule. Either makes the leak long-lived enough to reconsider.
- **A long-lived container runs the release tier many times per session** and per-run peak stops
  being the binding constraint — i.e. cross-run accumulation, not one run's peak, is what exhausts
  the disk.
- **Fixture roots gain an ownership record** for some other reason. The main cost of Option A
  disappears at that point, and a sweep keyed on real ownership (honoring `unknown` as
  not-safe-to-delete) becomes cheap enough to reconsider on its merits.

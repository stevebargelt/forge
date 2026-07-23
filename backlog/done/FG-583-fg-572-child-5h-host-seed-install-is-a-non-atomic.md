---
id: FG-583
type: story
status: done
title: "FG-572 Child 5h: host seed install is a non-atomic cp loop — an interrupted upgrade can expose a mixed but Zod-valid workflow set to a concurrent forge next"
created: 2026-07-17
closed: 2026-07-23
closed_commit: 8272e5b
---

**Parent:** FG-572 · **Epic:** FG-561 · **Depends on:** FG-577 (install from the correct tree first)
**Source:** bounded pre-implementation audit, run
`run-fg-577-fg-578-bounded-pre-implementation-audit-of-the-forge-install-provenance-surface-b19e9a`
(task-red-security-125943), read-only at `07f2c8d`. Findings 3 (medium) + 4 (medium). **NEW scope discovered
by the audit — not part of FG-577's or FG-578's acceptance criteria.**

## Problem

Host seed installation is a **sequential `cp` loop with no staging, no publication point, no lock, and no
rollback** (`scripts/install-seeds.sh:24-30`, driven by `src/cli/commands/upgrade.ts:140`). `forge next`
consumes the shared workflow surface directly, with no provenance/readiness check
(`src/cli/commands/next.ts:39` → `src/v2/loader.ts:44-66`).

Two supported Forge processes therefore share `$FORGE_HOME` with no protocol:

- Process A runs `forge upgrade` and is interrupted, or is simply between `cp` calls.
- Process B runs `forge next` and reads a **truncated YAML** (fails dispatch), or — the sharp case — reads an
  **old/new mixture that still passes Zod** and dispatches under a workflow/policy set **no release ever
  shipped**.

`doctor` cannot even name the mixed state, because `SEED_SPECS` (`src/v2/seed-drift.ts:46-51`) omits
workflows entirely (that omission is FG-579's).

The PRD's settled threat boundary explicitly protects **crashes / interrupted writes** and **concurrent
supported Forge processes**. This violates that boundary with **no attacker and no same-UID tampering** — an
ordinary interrupted upgrade is sufficient. It is NOT the same-principal case FG-571 dispositioned as an
honest limit.

Related: an install that fails partway leaves a mixed host while `upgrade` reports completion and does not
block consumers (finding 4). The resulting state is detectable by `doctor`/`route validate` **when invoked**,
but not on the ordinary dispatch path.

## Goal

Every consuming process observes one complete, release-owned host seed generation: either the generation that
was current before an upgrade or the complete generation published by that upgrade, never a torn or mixed
surface. The installed generation must be sourced through FG-577's established executing-release resolver, so
a promoted runtime installs its own release-bundled assets even when a divergent development checkout exists.

Either publish the complete consumed host surface **atomically** with a cross-process reader/writer protocol,
or make every **consuming dispatch** refuse on a detected incomplete/mixed surface. Prefer whichever is the
smaller mechanism — FG-571's lesson stands: elaborate safety machinery signals a wrong architecture, and the
invariant should MOVE rather than accrete guards. Note FG-571 already settled an atomic-publication pattern
(one-swap `(current, previous)`, staged unit, never a sibling record) — reuse that vocabulary; do not invent
a second.

A failed/interrupted installation must have a **named, repairable state**, propagated to human output,
`--json`, exit status, doctor, retry advice, and dispatch/campaign consumers.

## Architecture and execution guardrails

- Source release-owned assets through FG-577's canonical executing-release provenance. Do not fall back to a
  caller-selected `FORGE_REPO_DIR`, the live development checkout, or a path trusted merely because it is under
  `releases/*`.
- Resolve and validate staging/publication destinations without following a replaceable destination symlink
  outside the intended disposable `$FORGE_HOME`. A failed trust check must refuse before publishing; it must not
  mutate an unrelated host path. This protects supported upgrade/crash concurrency without expanding the threat
  model to arbitrary same-UID tampering.
- Test the actual promoted release layout and installed command surface, not only direct library calls or a
  development-mode fixture.
- If an architect artifact is rejected or re-run, carry forward its complete risk register and dispositions;
  correcting one finding must not discard unrelated HIGH risks from the earlier pass.
- Container agents must run verification synchronously. They must not background a test and end their turn to
  await a completion notification that cannot wake an agent container.

## Acceptance Criteria

- Kill/read interleavings — after agents copied, mid-`workflows`, and before/failed recompile — must **never**
  permit `forge next` to dispatch a **mixed but Zod-valid** workflow set. Observed RED against current code:
  the mixed-valid dispatch must be reproducible before the fix.
- A reader interleaved between individual installed files never consumes a torn surface.
- An interrupted install leaves a named, repairable state — not a host that reports healthy.
- Propagation consumers asserted: library, CLI human output, `--json`, exit code, doctor, retry advice,
  campaign/dispatch.
- A promoted-layout acceptance test runs the installed `forge upgrade`/dispatch surfaces from release A, with a
  deliberately divergent development checkout, and proves the published generation came exclusively from A.
  After atomically promoting release B, a new invocation must consume one complete B generation; an invocation
  already running remains anchored to the generation it opened.
- Tests cover source and destination trust failures: caller-selected/dev bytes cannot become the promoted seed
  source, a replaceable destination symlink cannot redirect publication outside the disposable `$FORGE_HOME`,
  and refusal leaves the unrelated target byte-for-byte unchanged.
- Tests use **disposable FORGE_HOME**; the real `~/.forge` is never touched.

## Not in scope
- The workflows coverage gap in `SEED_SPECS` and the ownership/severity split (FG-579).
- Source selection for the installer (FG-577).

## Acceptance Evidence

Shipped in merge commit `8272e5b` (PR #154). All acceptance criteria met.

| AC | Evidence | Verdict |
|----|----------|---------|
| Kill/read interleavings never permit `forge next` to dispatch a mixed-but-Zod-valid set; RED reproducible before fix | `src/v2/fg583-mixed-generation-refusal.integration.test.ts` — "the flat layout is never a dispatch source: a mixed flat set is REFUSED, not read". The invariant moved to one place: `src/v2/loader.ts` `workspaceGeneration`/`noCompleteGenerationError` removed the flat dispatch fallback, so no dispatch consumer ever reads a torn flat set. RED-first reproduction landed then made green. | met |
| A reader interleaved between individual installed files never consumes a torn surface | `src/v2/seed-generation.ts` `publishSeedGeneration` stages a complete generation under a private dir and commits with ONE `rename(2)` over the seed pointer (FG-571 one-swap vocabulary); test "a reader interleaved between individual installed files never sees a torn surface". | met |
| An interrupted install leaves a named, repairable state — not a host that reports healthy | `src/v2/seed-generation.ts` `inspectSeedInstall` (healthy \| no-generation \| incomplete); `src/cli/commands/doctor.ts` reports NOT INSTALLED + non-zero exit; tests `src/cli/commands/fg583-doctor-seed-install.integration.test.ts`, `src/cli/commands/fg583-next-refusal.integration.test.ts` (refuses under a torn/no generation). | met |
| Propagation consumers asserted: library, CLI human output, `--json`, exit code, doctor, retry advice, campaign/dispatch | Single refusal point in `loader.ts` inherited by every dispatch consumer (next/invoke/gate/campaign/continue — threaded anchor); `fg583-next-refusal.integration.test.ts` asserts human output + retry advice + non-zero exit; `fg583-doctor-seed-install.integration.test.ts` asserts doctor human line + `--json` block + exit. | met |
| Promoted-layout acceptance test: installed surfaces from release A with a divergent dev checkout, generation exclusively from A; after promoting B a new invocation consumes complete B, a running invocation stays anchored to A | `src/cli/commands/fg583-promoted-layout.integration.test.ts` — "promoting B — a NEW invocation consumes complete B; an ALREADY-RUNNING invocation stays on complete A, never an A/B mix"; anchor via `resolveSeedGeneration` (resolved once) threaded through the dispatch chain. | met |
| Source/destination trust failures covered: caller/dev bytes cannot become the promoted source; a replaceable destination symlink cannot redirect publication outside disposable `$FORGE_HOME`; refusal leaves the target byte-for-byte unchanged | Source: `fg583-mixed-generation-refusal.integration.test.ts` "SOURCE trust: a divergent dev checkout's bytes never become the promoted seed source" + "publishing dev/arbitrary bytes is REFUSED" (`publishSeedGeneration` derives source from `trustedAssetRoot`). Destination: "DESTINATION trust: a replaceable destination symlink is refused BEFORE any byte is written; the unrelated target is left unchanged" + the installed-surface variant in `fg583-promoted-layout`, via exported `promote.ts` `realpathContains`. | met |
| Tests use disposable FORGE_HOME; the real `~/.forge` is never touched | All FG-583 tests `mkdtempSync` their own FORGE_HOME (`src/v2/seed-generation.testkit.ts`; each `fg583-*.test.ts` `beforeEach`); the `fg583-next-refusal` auth-mode fix (`sk-stub` apikey) ensured the seed gate is reached on a host with no oauth volume, keeping the isolated disposable-home behavior deterministic on CI. | met |

**Additional hardening (red-security):** generation integrity is a CLOSED set — `loader.ts` refuses a Zod-valid file resolved from a generation but absent from its provenance manifest (torn/extra file), for both workflows and runtimes; regression test "integrity is a CLOSED set: a Zod-valid workflow ADDED to a generation but absent from its manifest is REFUSED".

**Follow-up filed:** FG-605 (route preflight consuming routing policy from the generation — the dispatch-adjacent RACI change reverted to baseline to keep this ticket scoped).

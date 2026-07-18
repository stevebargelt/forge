---
id: FG-579
type: story
status: done
title: "FG-572 Child 5c+5d: seed-drift omits workflows and conflates ownership with coupling severity — stale workflow mis-runs silently, needs a named refusal on the consuming path"
created: 2026-07-17
closed: 2026-07-18
closed_commit: 1aa25a05a7bd5d2796e3331a45daab7209a9b158
---

**Parent:** FG-572 · **Epic:** FG-561 · **Depends on:** FG-577 (5a — the remedy must install from the right tree first)
**Source:** FG-572 read-only architecture pass, run `run-fg-572-installed-surface-compatibility-read-only-architecture-pass-75b811`, at `12b13c2`.

Combines the architect's 5c + 5d deliberately: 5c alone **only reports**, and a detector the operator may never
run does not satisfy FG-572's "named, actionable failure — not a silent mis-run" AC. They ship together or the
invariant isn't closed.

## Defects (verified at 12b13c2)

1. **Coverage.** `SEED_SPECS` (`src/v2/seed-drift.ts:46-51`) covers runtimes, agents, constraints, raci — and
   **omits `workflows` entirely**, the one forge-owned *executable* surface with a silent mis-run mode. Also
   omits `~/.claude/skills`. Host corroboration: `~/.forge/workflows` is the **oldest** installed surface
   (2026-06-21) and is byte-identical to `seeds/workflows` only by operator discipline.
2. **Conflated axes.** `autoRefreshable` (`seed-drift.ts:31`) fuses **ownership** (who may edit) with
   **coupling severity** (what breaks), and `ok` is computed from it (`:103`) — so prose drift can never fail.
   The axes come apart: an operator-edited `forge-raci.md` is **legitimate** drift that must never fail, while
   a stale `workflow` is a forge-owned **mis-run** that MUST fail. One boolean cannot express both.
3. **Escape hatch.** `FORGE_REPO_DIR` (`seed-drift.ts:56`) lets an env var re-point the baseline at a dev
   checkout, silently defeating the release-bound comparison. Its fate under promotion needs a decision.

## Coupling detail (why workflows is the sharp case)

`src/v2/loader.ts:44-66` reads + zod-validates. Two different failures:
- (a) a stale workflow that **still passes schema** runs the wrong phases/agents with **no signal** — the exact
  AC violation. Only this needs new machinery.
- (b) a stale workflow missing a newly-required field throws with the offending path (`loader.ts:63`) — already
  named, already good.

## Scope

- Add `workflows` (+ `~/.claude/skills`) to `SEED_SPECS`.
- Split `autoRefreshable` into **ownership** vs **coupling-severity**; recompute `ok` from severity.
- Align digest vocabulary to **SHA-256 of bytes** — matches FG-571's established interpreter identity exactly.
  `sameContent` (`seed-drift.ts:75-81`) is a whole-file string compare today; restating it as a digest costs
  nothing and lets a JSON payload carry a digest instead of the bytes. **Do not invent a second identity
  mechanism** — reuse FG-571's content-addressing.
- Decide `FORGE_REPO_DIR`'s fate under promotion.
- **The named refusal must fire on the path that CONSUMES the workflow** (dispatch/resolve), with `doctor` as
  the advisory. A detector alone does not satisfy the AC.

## Acceptance (EXECUTED)

- An installed workflow differing from the promoted release's bytes produces a **named, actionable refusal at
  dispatch** — observed RED against current code (a stale-but-schema-valid workflow currently mis-runs silently).
- Operator-owned prose drift (agents/constraints/raci) **reports** and never fails the gate.
- Forge-owned executable drift (workflows) **fails**.
- The mutation-sensitivity bar: each regression test must go red against the *precise* defective behavior, not
  merely because the feature is absent.
- Propagation consumers checked: library, CLI human output, `--json`, exit behavior, retry/advice, campaign,
  dashboard/operator surfaces, durable docs, schema contracts.
- Tests use **disposable FORGE_HOME**.

## Explicitly NOT a version marker

A version stamp in `~/.forge` is strictly **weaker** than the comparison forge can already make: it cannot
detect an operator hand-edit — the stamp still reads `release-abc123` after the file is rewritten underneath
it. The stamp can lie; the bytes cannot. This is FG-571's "selection evidence is the BYTES, never the pathname"
applied one boundary outward. Do not add one.
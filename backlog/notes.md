**Last session ended 2026-07-27.**

**Where we left off:** FG-621 merged (#164, `3b42035`) and FG-627 merged (#165, `8714232`). The first
real end-to-end isolated dispatch forge has ever run was executed, and it exposed three separate
defects in one afternoon — the substrate works, the verification paths around it had never been
exercised. Stopped before implementing the expanded FG-566, at the operator's call.

**Picked up next:**

1. **FG-566** — implement the expanded scope. **Dispatch with isolation OFF (`--project
   ~/code/forge-fg356`, no `FORGE_WORKTREES`).** This is a hard constraint, not a preference: FG-566
   fixes the very thing that breaks isolated pipeline runs, so turning isolation on kills the
   integration gate on the dependency-less candidate worktree before any work happens. Route
   `implementation_full` (two consumers, a new declared contract, publication-path failure
   classification). Worth asking the architect explicitly whether the expanded scope stays ONE
   cohesive change — it grew substantially and may want splitting, better learned at the plan gate
   than mid-build.
2. **FG-627 — record AC 4's answer in the ticket and CLOSE it.** Every AC is met but the ticket is
   still open. Evidence: the real dispatch started an agent container (run
   `…-dogfood-693dbc`, task `task-architect-824e5d`, `container evidence: confirmed container exit …
   exit code 0`) where it previously died at provisioner exit 125; the provisioner's project mount is
   still `:ro` (`spawn.ts:1011` untouched); CI green on #165. AC 4 asked whether the linked-worktree
   substrate fails identically — **it does**, measured directly (fresh worktree and fresh clone are
   both empty of `node_modules`; `runNext.ts:3226` sets `repoRootForMount = args.worktreePath ??
   args.projectDir`, so the read-only mount source is the isolated workspace on both). So FG-627 is a
   pre-existing FG-376 defect, not an FG-621 regression. Needs the AC walk + Acceptance Evidence grid.
3. **FG-621 AC 11** — the only open criterion. After FG-566 lands, re-run the dogfood WITH isolation
   and verify from durable state: task workspace under `~/.forge/worktrees/clones/`, `tasks.base_sha`
   recorded, the agent's commit on `forge/<runId>/<taskId>`, parent unchanged apart from the capture
   fetch. Then the full AC walk and close.

**External state to remember:**

- **`forge launch run` does NOT propagate the caller's environment (FG-626).** Every `FORGE_*` gate is
  silently inert under the launch pattern the orchestrator template mandates. Use
  `forge launch run --name X -- env FORGE_WORKTREES=1 <cmd>`. Ambient profile env survives (the tmux
  server inherited it), which is why auth always worked and masked this.
- **FG-621's AC 2 live evidence was captured at `09fd810c` but is NOT in the ticket yet** — it lives
  only in this session's scratchpad. Do not paste it as-is at close time: re-run
  `./scripts/fg621-clone-boundary-smoke.sh` against the FINAL SHA, per the operator's rule that
  acceptance evidence against a superseded SHA is worse than none.
- The smoke script requires this repo's `node_modules` because it builds its fixture through forge's
  own `createTaskClone`. That is deliberate — it previously injected `GIT_AUTHOR_*` and
  `safe.directory` and would have reported SUCCESS while real dispatch failed.
- **Live-checkout rules are now in `backlog/PLAN.md`** and are not optional: agent work and branch
  setup happen only in `~/code/forge-fg356`; no destructive git command against `~/code/forge` inside
  a compound chain.
- WIP backup at `~/forge-wip-backup-20260727T093244/` (5 files). The operator has since committed and
  pushed them (`1b6f13a`); the backup can be deleted once they are satisfied.
- Two failed dogfood runs remain (`…-6c5400`, `…-dogfood-693dbc`), deliberately left as the record of
  what FG-626 and FG-627 cost. Their `forge/run-fg-566-…/task-architect-*` anchor refs are still in
  `~/code/forge` — harmless, but they accumulate.

**Decisions worth not relitigating:**

- **FG-566 was expanded IN PLACE** into the shared readiness contract for all Forge-owned host-side
  verification, with two consumers (review-loop local fallback; FG-357/FG-425 integration-gate
  verification against the exact publication candidate). Operator decision; explicitly **no separate
  integration-gate ticket**.
- **FG-627 stays separate** and owns container-side nested-volume mount mechanics. FG-566 owns
  host-side readiness. Do not merge them.
- **AC 2 / AC 11 are not operator-only work.** "Operator-run" came from *agent containers* having no
  Docker daemon; it never applied to the orchestrator, which has Docker on this host and ran AC 2
  itself. Do not hand these to the user as their step.
- **No third required CI check for AC 2.** Standing argv-shape coverage plus one-time live evidence
  from a fail-closed script (exit 0 pass / 1 failed assertion / 2 prerequisite, never a skip).
- **Linux hard-fail is inherited**, so FG-621's evidence is macOS-only and cannot alone justify a
  universal default-on flip. FG-345 closeout must choose macOS-first or lift the gate. Do not smuggle
  Linux support into FG-621.
- **Isolation was never "nearly ready" — only its substrate was.** Three verification-path defects fell
  out of one real run. Carry this into FG-345's aggregate walk rather than assuming the remaining work
  is small.
- The recurring failure shape this session, worth naming at every gate: **silence read as success** —
  a verification block behind a condition production never satisfied; fixtures supplying the identity
  the product owed; a smoke script that could only fail at real scale; a parity test that proved a
  plan, not a mount; and a CI-watch condition that read "no checks yet" as "all passed."

**Shipped (for reference):**

- **FG-621 (#164)** — private writable `git clone --shared` for mutating agents at a recorded base
  SHA; objects-only `:ro` parent mount (parent refs/index/HEAD/packed-refs ABSENT, not merely
  unwritable); mandatory derive-then-verify alternates identity check; six-step capture ordering with
  `worktreePath` omitted for clone sources so post-fetch mutation is structurally impossible; clone
  reaping extended in the existing reaper; `tasks.base_sha`; agent commits as
  `forge-agent <agent@forge.local>`. Ticket REMAINS OPEN on AC 11.
- **FG-627 (#165)** — dependency mountpoints created at workspace creation for both substrates, derived
  from `planDependencyVolumes` so they cannot drift from what gets mounted. Ticket open pending closeout.
- **FG-626** — filed: `forge launch run` drops caller env.
- **FG-566** — expanded and retitled to the shared host-side verification readiness contract.

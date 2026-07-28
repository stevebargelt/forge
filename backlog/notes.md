**Last session ended 2026-07-28.**

**Where we left off:** FG-566 shipped, was reopened the same day when the first real isolated dogfood
falsified its AC 1, then shipped again and closed on the operator's ruling that *"the real gate
completes" means it executes to a genuine code verdict, not that every downstream test passes.*
Three dogfood attempts were spent getting there. The last one got all the way through readiness and
returned a genuine verdict — and in doing so exposed FG-636, which is now the most consequential
open defect.

**Picked up next:**

1. **FG-636 — the integration gate returns a FALSE `integration_failed` on an unmodified candidate.**
   Highest priority: it makes every pipeline gate untrustworthy, and it fails *closed* on good work,
   so the cost is silent lost throughput rather than a bad merge. Established: `de356f6a` is green in
   CI (nine checks) and green on the host (`npm run test:unit` in the clone, clean tree, exit 0), but
   the same tier run by the gate inside the publication candidate fails nine tests — on the ARCHITECT
   phase's output, i.e. a tree with no code change. The nine span `fg366-runtime-name-resolved`, five
   `fg482` blocked_by_red CAS cases, and the three FG-270 `runNext-spec` cases; all read or publish
   under `FORGE_HOME`, and the candidate lives *underneath* the real `FORGE_HOME` at
   `~/.forge/worktrees/publications/<attemptId>-r0`. **The mechanism is deliberately NOT asserted in
   the ticket** — CWD-inside-FORGE_HOME, concurrency with the live DB, and the constructed gate env
   are each plausible and each imply a different fix. Establish it with evidence before fixing.
   Evidence run: `run-fg-628-…-dogfood-3-8a668c`, task `task-architect-2b12d8`.

2. **FG-621 AC 11 — now provable, but not yet walked.** Dogfood 3 satisfied it in substance and the
   durable state is still on disk: task workspace under `~/.forge/worktrees/clones/`, `tasks.base_sha`
   recorded, provisioning succeeded, agent container ran, gate reached a verdict. What remains is the
   AC walk itself plus **AC 2's live evidence, which must be re-captured** — the existing capture is
   at the superseded `09fd810c`, and evidence against a stale sha is worse than none. Re-run
   `./scripts/fg621-clone-boundary-smoke.sh` (fail-closed: 0 pass / 1 assertion / 2 prerequisite)
   against the final sha; it needs the repo's own `node_modules` because it builds its fixture through
   forge's `createTaskClone`. Then the 12-AC walk, the Acceptance Evidence grid, and close. **FG-345
   default-on unblocks after that** — and its aggregate walk should not assume the remaining isolation
   work is small; that assumption has now been wrong three sessions running.

3. **FG-628 — still entirely unimplemented.** It was the dogfood *vehicle* three times and never got
   past the architect phase, so none of its actual work exists. Both halves still matter, and the
   second is the one that quietly degrades every pipeline: a red that crashes before starting its
   container ingests as non-blocking `inconclusive (0.00)`, so a gate opens with zero adversarial
   review and looks completely normal.

**External state to remember:**

- **ntfy delivery is failing** (`network: fetch failed`). Milestone events record fine but nothing
  reaches the phone — two went undelivered this session (`risk_found`, `shipped`). Non-ticket thread;
  check the endpoint before relying on notifications for an unattended run.
- **`docs/prds/evidence-led-review-lifecycle.md` is untracked in `~/code/forge` and is not mine.**
  Left alone deliberately. Decide whether to commit or delete it.
- `~/code/forge-fg356` is reset to merged `main`, clean. Its `dashboard/node_modules` was created by
  hand as the FG-628 workaround — leave it until FG-628 lands, or reds will crash there again.
- Publication candidates are retained on failure and now carry a full installed `node_modules` (that
  is FG-631's subject). Several are accumulating under `~/.forge/worktrees/publications/`.
- Three failed dogfood runs remain (`…-a64a73`, `…-dogfood-2-3ea443`, `…-dogfood-3-8a668c`) as the
  evidence trail for FG-566's reopen and FG-636. The FG-566 pipeline run `…-0f7edc` also carries a
  deliberately messy task topology — two duplicate architect artifacts and a cancelled third — kept as
  FG-629's evidence.
- WIP backup at `~/forge-wip-backup-20260727T093244/` (5 files) — still deletable.

**Decisions worth not relitigating:**

- **Lifecycle-script suppression is DROPPED, and a rebuild allowlist was REJECTED.** Operator
  decision, with the reasoning recorded in FG-566: the boundary was internally inconsistent because
  preparation is immediately followed by the candidate-controlled `npm run test:unit` on the host with
  the inherited operator environment. Suppression never stopped hostile candidate code — it only broke
  native dependencies. The allowlist is worse: package names and lockfile identities are themselves
  candidate-controlled, and it becomes the dependency-policy system FG-566 fenced out. **The honest
  trust model is now documented**: host verification assumes candidate code is not actively malicious,
  and real isolation would require sandboxing installation AND verification.
- **The trust boundary that DID matter is command provenance, not script suppression.** `configDir`
  was removed from `HostReadinessRequest` entirely — no parameter a caller can bind to the workspace.
  Keep that; it is independently reviewed.
- **Host-side dogfooding tests the INSTALLED forge, not your branch.** The integration gate, readiness,
  publication, review-loop and capture all execute in the npm-linked `~/code/forge`. Agent-side
  changes dogfood fine from a branch because the container mounts the project; host-side changes must
  be merged and pulled first. One dogfood run was wasted learning this.
- **Do not run `forge-dev upgrade` to render a `CLAUDE.md` change from an unmerged branch** — its dry
  run publishes a new host-wide seed generation (routing policy, workflows, template) for every project
  from branch code. The FG-566 render was done by hand and verified byte-identical to the seed body.
- `forge next` dispatches ONE wave and must be re-run to advance; advancing a gate does not dispatch
  the next phase.

**Shipped (for reference):**

- **FG-566 (#166, #167 → `de356f6a`)** — shared readiness contract for Forge-owned host-side
  verification. Closed, reopened when the dogfood falsified AC 1, closed again with both AC grids.
- **FG-627 (`8714232`)** — closed with its AC grid; AC 4's answer recorded (the linked-worktree
  substrate fails identically, so the fix belongs at workspace creation).
- **Filed:** FG-628, FG-629, FG-630, FG-635, FG-636 (forge defects found only by driving real
  pipelines) and FG-631, FG-632, FG-633, FG-634 (FG-566 review findings deferred with scope reasons).
  FG-625 was widened rather than duplicated — it now owns two defects on `review-loop.ts:924`.

**The pattern worth carrying forward, because it was six-for-six:** *silence read as success.* A
crashed red reading as "reviewed, undecided". A retry reading as "red re-run". A `request-changes`
reading as "the agent saw the plan". A run reading as "complete" with a guaranteed phase never
dispatched. An ABI check comparing a value to itself and returning ok forever. A self-host guard
ordered behind an early return so it never ran. Every one produced green output and a confident
status. The two things that actually caught them were **running the real pipeline** and **diffing
artifacts field-by-field instead of reading their summaries**.

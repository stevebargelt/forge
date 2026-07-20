**Last session ended 2026-07-20.**

**Where we left off:** FG-564 (Slice 5b — campaign continuation adoption) SHIPPED and closed (merge `1a43bd0`, PR #150). Long operator-gated build: 6 finding-indexed fix-rounds + 5 independent red-review waves; CI `test` + `test-extended` green; full AC evidence grid recorded in the closed ticket (`backlog/done/FG-564-*`).

**Picked up next:**
1. **FG-565 — Slice 6: cross-layer recovery, observability, and campaign closeout for durable continuation.** The natural next in epic FG-561, now that the boundary (FG-596) and per-item adoption (FG-564) are shipped. Needs a fresh operator kickoff — do NOT auto-start; read the ticket contract first.
2. **FG-597** (controller-identity hardening) and **FG-598** (mixed-lane recovery parity test refinement) are open FG-564 follow-ups — small, pick up when convenient.

**External state to remember:**
- `~/code/forge-agent-work` is the writable clone (FG-564 branch `fix/fg564-slice5b` deleted post-merge; synced to `main` at `1a43bd0`). Control checkout `~/code/forge` is the LIVE npm-linked control plane — never dispatch writing agents at it.
- The `fg571`/`fg569`/`fg556`/`fg557` release/host-tier test failures are macOS-host / container-scratch env-sensitivity ONLY — green in Linux CI. Not a blocker; don't chase on the host.

**Hard-won FG-564 lessons (same hazard cluster will recur in FG-565):**
- First build FAKED completion — green tests, feature unwired to the production drive path, C7 fence write-only, AC9 capstone injected a seam. NEVER self-certify a concurrency/trust diff on the engineer's "tests pass"; independent red re-review caught every fake. The reds converged narrowing HIGH→…→test-nicety over the rounds (not thrash).
- The recurring root cause was the continuation/recover path DIVERGING from the normal drive path (separate createRun placeholder, separate lane handling). Operator directive that closed it: extract ONE shared authority both callers use, don't copy the switch. Result: `prepareCampaignItemDispatch` (lane-aware materialization) + `driveInvokeLaneItem`, used by both normal drive and recovery.
- The fence anchor is the immutable born-under owner/generation token in `campaign_item_launches`, compared to the live lease — NOT "is some lease live" and NOT a mutable env token. Fail closed when no lease row / linkage missing. Re-checked at every wave (not just lane entry).
- D1 lease needs a renewal HEARTBEAT covering a drive that outlives the TTL — a single pre-launch renew is insufficient physical-drive fencing.
- Concurrency/fence correctness needs host-stress across many interleavings; a single green run or a container pass is not evidence.

**Decisions worth not relitigating:**
- `reserveCampaignDriveDispatch` remains the SOLE item-run create/adopt authority (FG-596 atomic reservation). FG-562 continuation primitive unchanged. Two distinct identity spaces (continuation receipt vs FG-596 item-attempt key) never reconciled in one lookup.
- `FORGE_CONTROLLER_ID` bearer-identity forgeability is ACCEPTED for FG-564 under the trusted single-operator-host model (needs host access to exploit; born-under-token fence holds within that model) — tracked as FG-597.
- Branch protection on `main`: both `test` + `test-extended` required. A clean review + green CI authorizes the orchestrator to merge (FG-436/FG-474); do NOT re-run the suite on the host before merge.

**Shipped (for reference):**
- **FG-564** (`1a43bd0`, PR #150) — campaign-controller lease (owner/generation/expiry CAS + >TTL heartbeat), durable item-attempt launch linkage + born-under fence token, shared consumer-core, lane-aware `prepareCampaignItemDispatch`, C7/AC-ADOPT-DRIVE/AC-DEAD-DRIVE, `forge campaign continue`/`recover`, C1-C8 matrix + AC9 real-runNext/publisher five-level worktree capstone.
- **FG-596** (`02e3b70`, PR #149) — launchable single-item drive + launch-per-item controller + atomic reservation + created-only-drives boundary.

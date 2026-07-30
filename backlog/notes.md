**Last updated 2026-07-30 (mid-session, autonomous block).**

**Where things stand:** The forge repo is DB-authoritative. FG-608 closed on
`f391b544` (PR #177): the live `ticket_events` constraint-shape divergence
(single-column PK that never existed in committed history) is detected and
transactionally rebuilt at open; the parity guard now compares PK/UNIQUE/index
shape for every table; the real cutover ran clean — 598 tickets, mode `db`,
flip recorded by `f391b54`. `store: db` is the expected banner here; ticket
verbs are DB writes (no more stage-both-sides-of-backlog/ ritual); backlog/*.md
is a frozen snapshot.

**FG-645 closed on `1754c386` (PR #178) — zero-red tranche 2.** The real
inventory (from an in-container baseline run, superseding the old "~15/63"
estimate) was 21 suites / 129 reds, one root cause: spawned forge CLI children
probe the compiled-in /forge-backlog authority mount. Repair: opt-in testkit
seam (src/backlog/container-authority.testkit-spawn.ts — see the new
docs/how-to-testing.md section). All five tiers now 0 failures in a real agent
container; host worktree 435/435 with the docker arms executing.
`docker/verify-launch-tier-in-image.sh` now commits its copied scratch and RUNS
FROM A DIRTY CHECKOUT (74/74 live), runs post-fix before pre-fix and always
both arms; the tmux falsification baseline was re-derived 10→14 (the four
FG-569 tmux-gated tests) — **operator: ratify or veto that baseline
acceptance** (revert 0594424e's script hunk to veto).

**Picked up next:**

1. **FG-642 — dashboard browser-test tier dark in agent containers** (Chrome
   candidate list lacks /usr/local/bin/chromium; the silent skip concealed a
   real red). Operator-designated next; the last known zero-red violation.
2. **FG-646 is explicitly OFF the queue** (operator instruction 2026-07-30):
   do not work it. Context if it comes back: the dry-run still writes
   project_key despite claiming otherwise, but the forge repo's own line is
   now legitimately committed post-cutover.
3. FG-609 (FG-496 Slice D) remains the next implementation item per PLAN
   after the zero-red work; FG-638→640 filed and approved, dispatch not yet
   authorized.
4. Non-ticket: rotate the leaked Docker Hub token (carried since 2026-07-28).

**External state:**

- ntfy still DOWN (`forge notify` fails network: fetch failed) — no push for
  unattended runs.
- `~/.forge/forge.db.pre-fg608.bak` (280MB) remains the pre-FG-608 restore
  point. The migrate in-flight predicate concern from the previous handoff
  did NOT reproduce (no active runs for the project dir at migrate time) —
  stays parked, needs a demonstrated failure before any work.
- Two stale orchestrator-session run rows remain active in the DB (bf2fa4,
  085fdf) — no liveness signal exists; do NOT cancel by age.

**Decisions worth not relitigating:** ZERO-RED RULE unchanged (deterministic
tests execute everywhere they claim coverage; skips are never evidence).
Interim evidence-led review (Change 0) remains ACTIVE and was exercised on
FG-608 and FG-645 end-to-end (manual ledger, disposition-before-fix, one
batch fixer, delta-bounded recheck). FG-637 stays deferred. docker-exec
ENOTEMPTY stays on WATCH (n=2).

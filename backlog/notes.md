**Last session ended 2026-08-07.**

**Where we left off:** FG-691 and FG-576 both shipped. FG-576 was the big one — it ran as a
full pipeline, the build wave lost a child to `result_missing`, and the operator directed a
SALVAGE of the 8 completed children rather than a 12-step re-drive. The remaining DAG
(steps 4 → 7 → 9/12) was completed as targeted invokes, then reviewed, merged and closed with
a full AC1-AC15 evidence grid. The session ended cleanly at that point, not mid-thread.

**Picked up next:**

1. **FG-688 — promoted by operator decision (2026-08-07).** A terminally-failed ordered wave
   still has no adopt-preserving re-drive. Its ticket now carries the third reproduction with
   real numbers (8 of 9 children and +12,685 lines nearly discarded on FG-576) plus a SECOND
   defect found in the same incident: `forge recover <parent> --json` recommends
   `--re-drive`, but `performReDrive` refuses unless the failure kind is
   `fanout_wave_orphaned`, and FG-576's parent failed `prerequisite_blocked`. Following
   forge's own printed advice is refused. Treat them as ONE gap — fixing only the inspector
   leaves the expensive half.
2. **FG-682 — now demonstrated, not theoretical.** FG-576 hit it live: a correction found
   after the docs stage has no amendment path, and re-running shipping refused
   `blocked_environment (candidate_not_checked_out)`. It cost a documented tip-equality
   override (recorded in full on FG-576). Adjacent to FG-688; both are review/recovery
   control-plane gaps.
3. **FG-681 — the darwin/Linux split is now expensive, not just noisy.** THREE of FG-576's
   five defects were darwin-only and structurally invisible to the Linux agent containers and
   to CI. Every one shipped green through CI and was caught only by a host run. That changes
   the cost calculus of leaving it open.

**External state to remember:**

- **`~/code/forge-fg576` is retained.** It holds tags `fg576-salvage-candidate` (731d46d2,
  the 8-child integration candidate) and `fg576-salvage-step4-branch`. Deleting it loses the
  salvage provenance; the branch itself is merged and deleted on the remote.
- **`~/code/fg584-dogfood` is still deliberately retained** (FG-584 AC14 evidence cites base
  SHAs that exist only there).
- **ntfy is BACK UP.** `forge notify milestone` reported a successful push this session after
  nine consecutive sessions of `network: fetch failed`.
- **The agent image was rebuilt** this session (`forge upgrade --rebuild-image`); doctor now
  reports it not-stale, and both `claude` and `codex` CLIs are present in it. The STALE report
  was real, not FG-543's false positive.
- **Non-ticket thread:** the FG-576 clone's `better-sqlite3` is built against forge's control
  runtime, so a direct `node`/`npm` invocation there fails `ERR_DLOPEN_FAILED` unless run via
  `forge launch run --require-control-toolchain`. Bit the operator once this session.

**Decisions worth not relitigating:**

- **Salvage, never `--re-drive`, for a partially-complete wave.** `recover.ts:498-508` states
  it re-drives the FULL wave; on FG-576 that meant discarding 8 completed children including a
  64-minute step. The salvage path (durable tag → targeted invokes against the candidate →
  normal review) worked and is the precedent.
- **`orphaned` asserts LAUNCHER loss and never child death** (FG-576 D17). No surviving-child
  lifecycle state; splitting it widens into provider-process recovery semantics no AC needs.
- **Receipt `project_dir` is STORED canonical**, enforced at both boundaries by one helper.
  Settled after three wrong-direction fixes; the round-trip assertion carves out that one
  field and every other field still round-trips verbatim. Do not "restore" the old
  expectation.
- **Claude's env isolation withholds credential-SELECTION variables BY EXACT NAME**, not by
  family prefix like Codex's. The Claude child IS Claude, so `CLAUDE_`/`ANTHROPIC_` are its
  own behavior controls; withholding the family would strip operator settings. Deliberate
  asymmetry between the two adapters.
- **RF-2 (dashboard rows mouse-only) folded into FG-692**, not filed separately — same client,
  same accessibility pass as its WCAG contrast item.
- **A green CI is not evidence when the failure is platform-specific.** FG-576 sat fully green
  on all ten CI checks while one integration test was red on darwin. Merging was held until
  the host was green too.

**Shipped (for reference):**

- **FG-691** (`0d0ed85a`, PR #222) — an explicit instant on the paired lease predicates,
  defaulting to `storeNowMs()`; exact-expiry now assertable and added to both sweeps.
  Reviewed clean: 4 lenses, 0 findings.
- **FG-576** (`04fbfeb9`, PR #223) — `forge orchestrator`, the provider-neutral launcher:
  receipt store, launcher-owned liveness with a process-identity fence, resolution +
  capability matrix, Forge-owned Codex instruction carrier, both adapters, `forge show` and
  dashboard surfaces. 15/15 AC met with evidence at the final candidate. Five defects were
  found and fixed during the build, two by its own security regressions.

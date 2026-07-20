**Last session ended 2026-07-20.**

**Where we left off:** FG-596 (the launch-boundary prerequisite for the durable-continuation epic) shipped and closed after a long, operator-gated build; the session ended cleanly at that merge. FG-564 (Slice 5b) is teed up but deliberately NOT started.

**Picked up next:**
1. **FG-564 — Slice 5b, campaign continuation adoption.** The live next item, but it needs a FRESH operator kickoff — do NOT auto-start. Contract is fully specified in the ticket: per-item continuation claim on FG-596's boundary, BD-3 authoritative-read + F17 receipt-keyed adopt consumer-enforcement, FG-425 preservation, five-level PRODUCTION-PATH proof, instance-stable controller identity + running-campaign takeover, and the new **AC-ADOPT-DRIVE** — only the lease-holding controller may convert an `adopted` reservation into a physical re-drive (takeover after lease expiry). Dispatch WRITING agents against the clone `~/code/forge-agent-work` via `--project`.
2. When FG-564 starts, **brief its reds from round 1** on the FG-596 hazard cluster (below) — same primitives, same failure modes.

**External state to remember:**
- `~/code/forge-agent-work` is the writable clone (FG-596 branch deleted post-merge; on `main`). Control checkout `~/code/forge` is the LIVE npm-linked control plane — never dispatch writing agents at it.
- The 7 `fg571`/`fg569` release-tier test failures are macOS-host / container-scratch env-sensitivity ONLY — green in Linux CI (verified against main). Not a blocker, not FG-596's; don't chase them on the host.

**Decisions worth not relitigating:**
- **FG-596 dispatch reservation is ONE atomic transaction per run-producing lane** (`reserveCampaignDriveDispatch`: gen+key+run-insert+link+CAS). This replaced a growing detector stack (operator decision B) after ~10 review rounds kept exposing adjacent crash windows. "running item with no run" / "run created but not linked" are now unrepresentable; a structural guard test enforces no bare run-emission in the drive path. Do NOT reintroduce per-crash-point detectors — make the invariant atomic.
- **created-only-drives:** an `adopted` reservation links the keyed run but FG-596 NEVER physically drives it (returns `recovery_needed`). Live-drive fencing (one live driver per run) is FG-564's lease, recorded as binding AC-ADOPT-DRIVE (`05f147e`). Do not add liveness heuristics to FG-596.
- Split of the epic into FG-596 (boundary) + FG-564 (adoption) with per-item granularity, instance-stable controller identity, and dead-drive-item recovery in FG-564 — all operator-locked; don't re-open.
- Concurrency fixes were host-stress-verified (20x × 240 interleavings); a container pass or single run is not acceptable evidence.

**Shipped (for reference):**
- **FG-596** (`02e3b70`, PR #149) — launchable single-item campaign drive + launch-per-item controller + `campaign_items.attempt_generation` + atomic reservation + structural guard + created-only-drives boundary.
- **FG-592 / FG-522 / FG-526** (`2d54330`, PR #146) — R4 modal wording, `forge status` redTaskId, workflow `activity:` field doc.
- FG-564 architecture pass → FG-596/FG-564 split with implementation-ready contracts (`b761c46` / `358bfca`).

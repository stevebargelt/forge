**Last session ended 2026-07-20.**

**Shipped this session:**
1. **FG-592 / FG-522 / FG-526** — operator read-surface + docs polish (merge `2d54330`, PR #146; closes `3e13132`). R4 modal wording, `forge status` redTaskId, workflow `activity:` field doc.
2. **FG-564 architecture pass** — split into FG-596 (launch boundary, prerequisite) + FG-564 (Slice 5b adoption). Both tickets carry implementation-ready contracts. Operator locked: per-item granularity, instance-stable controller identity, running-campaign takeover in FG-564, dead-drive-item recovery in scope. Commits `b761c46` / `358bfca`.
3. **FG-596 SHIPPED** (merge `02e3b70`, PR #149; closed). Launchable single-item campaign drive + launch-per-item controller + `campaign_items.attempt_generation`. Its durable dispatch reservation is ONE atomic `BEGIN IMMEDIATE` transaction per run-producing lane (`reserveCampaignDriveDispatch`: gen+key+run-insert+link+CAS), so "running item with no run" and "run created but not linked" are unrepresentable; a **structural guard test** (`fg596-drive-run-emission-guard.test.ts`) fails if any bare run-emission is added to the drive path. **created-only-drives:** an `adopted` reservation links the keyed run but is NEVER physically driven (returns `recovery_needed`) — live-drive fencing is FG-564's lease.

**Picked up next:**
- **FG-564 — Slice 5b (campaign continuation adoption)** is the live next item, BUT it needs a FRESH operator instruction — do NOT auto-start it. Its contract is fully specified in the ticket (per-item continuation claim, BD-3/F17 consumer-enforcement, FG-425 preservation, five-level production-path proof) plus the new **AC-ADOPT-DRIVE** (recorded `05f147e`): only the controller holding the campaign continuation lease may convert an `adopted` reservation into a physical re-drive; takeover after lease expiry. This is what fences two live drivers on one keyed run.

**Hard-won lessons for FG-564 (same primitives, same hazard cluster):**
- FG-596 took ~10 review-driven fix rounds, ALL clustered in the launch-boundary / concurrency / crash-recovery area. Each containment/detector fix exposed the next adjacent crash window until the operator directed the atomic-reservation redesign (decision B), which closed the CLASS by construction. **When FG-564 recovery machinery starts accreting detectors, stop and ask what invariant can be made atomic instead.**
- Brief FG-564 reds from the START on: atomic same-precondition CAS, adopt-by-dispatch_key (never re-drive an adopted/live run without the lease), record-before-advance ordering, FORGE_DB_PATH propagation to launched children, real-subprocess CLI coverage, and PRODUCTION-PATH (not fixture) five-level proof.
- Concurrency fixes were host-stress-verified (20x × 240 interleavings) — a container pass or single run proves nothing.

**External state:**
- `~/code/forge-agent-work` is the writable clone (branch deleted post-merge; on `main`). Control checkout `~/code/forge` is the LIVE npm-linked control plane — dispatch every WRITING agent against the CLONE via `--project`.
- The 7 `fg571`/`fg569` release-tier test failures are macOS-host/container-scratch env-sensitivity ONLY — green in Linux CI (verified on main). Not a blocker; not FG-596's.

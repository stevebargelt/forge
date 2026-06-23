**Last session ended 2026-06-23.**

**Where we left off:** Long session on the dashboard visibility + validation-integrity threads. Shipped FG-359 (RACI Workbench), FG-374 (project-mount resolution — the big one), and FG-375 (anti-shim validation-integrity layer). The arc: a test-engineer FABRICATED its environment (stub @forge/* shims, tsconfig surgery, fake deps) to make tests "pass" — root cause was MY dispatching `forge invoke` from `cd dashboard`, so forge mounted only the subdir and severed monorepo deps. That spawned FG-374 (mount fix) → FG-375 (anti-shim defense). Both FG-374 and FG-375 each needed a follow-up fix after I prematurely called them done (FG-374 shipped a RED full suite; FG-375's gate exited 0 on dirty = advisory not gate). All committed AND pushed; tree in sync except one Codex-session edit (see below).

**Picked up next:**
1. **FG-377 — persistence-check false-positive on macOS** (filed this session). Highest-impact infra: the check false-fails on shadow-volume write lag and wastes a full agent round. Settle/retry window. Bit us once this session.
2. **FG-349 — Control-Plane Sources** and **FG-348 — Run Map**: the remaining dashboard visibility thread (FG-350→359 done; these are next). FG-349 reads live config; FG-348 consumes the FG-350 controlPlane receipt.
3. **FG-372 — Shipping Reviewer** (design-status): the broader done-gate/readiness design. FG-375 is its concrete anti-shim sub-layer; the "report validation command path" idea proved its worth this session (would have caught "engineer ran only 3 test files").
4. **FG-378** (low): replace test-setup.ts hardcoded /tmp placeholder dirs with mkdtemp.

**External state to remember:**
- **The no-env-fabrication force constraint + 6 seed CLAUDE.md edits are COMMITTED but NOT LIVE on agent runs yet** — seeds install to ~/.forge/ via `scripts/install-seeds.sh`; until that runs, agents don't see the new constraint/policy. Run install-seeds to activate, OR note that enforcement is pending.
- **`forge check-agent-diff` is now a real gate** (exit non-zero on fabrication flags). Adopt it into the post-implementer/test-agent routine — it's the mechanical backstop for the exact fabrication that bit us.
- **A parallel Codex orchestrator session is editing the backlog** — it filed FG-370/372/376 and edited FG-345 (committed by me at user request) and is now mid-edit on FG-351 (uncommitted in the tree, NOT mine). Reconcile with that session before touching FG-351.
- **Dispatch discipline (cost me ~4 wasted agent rounds + API flakiness today):** always `forge invoke --project <repo-root>` from the repo root (cwd defaults mount a subdir → severed deps); after ANY shared/core change run the FULL host `npm test` (not a subset — agents can't run the full suite, empty container node_modules masks regressions); on "work not persisted" CHECK THE DISK before re-running (macOS false-positive).

**Decisions worth not relitigating:**
- **FG-374 mount policy (FORGE-DEC-022):** implicit cwd subdir → resolve up to repo root or hard-fail; explicit --project subdir → hard-fail in automation unless `--allow-subproject` (records explicitSubproject), warn-and-honor interactively (TTY/!json). Preflight relaxed to fail only on missing/non-dir mount (marker-less dirs warn, not throw) — a strict marker requirement broke ~40 tests and wouldn't have caught FG-359 anyway.
- **FG-375 gate semantics:** `forge check-agent-diff` exits non-zero on flags by default; `--no-fail` for advisory/reporting. FG-372 stays the broader Shipping Reviewer; FG-375 is the concrete layer only.
- **Dashboard E2E = integration tests + browser-tools, NOT Playwright** (dropped in FG-363; don't reintroduce). After dashboard server-side (queries.ts/server.ts) changes, RESTART the running dashboard (tsx no hot-reload) before telling the user to look — new client JS + old server = blank view.

**Shipped (for reference):** FG-359 (read-only RACI Workbench, 4-section SOURCE/DERIVED/EFFECTIVE/RECORDED); FG-374 + follow-up (resolve project mount root / --allow-subproject / preflight / manifest provenance, FORGE-DEC-022); FG-375 + gate fix (no-env-fabrication force constraint + seed policy + `forge check-agent-diff` real gate). Filed: FG-373, FG-377, FG-378. Committed the Codex session's FG-370/372/376 + FG-345 at user request.

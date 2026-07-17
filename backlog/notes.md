**Last session ended 2026-07-16.**

**Where we left off:** The operator authorized an autonomous run of the FG-561 Slice-1 sequence (FG-573 → FG-570 → FG-571 → FG-572 read-only pass), then **narrowed it mid-session to "stop after FG-570 lands"** — so only FG-573 and FG-570 were done, and **FG-571/FG-572 were deliberately never started**. FG-570 is merged (`5044c5d`, PR #123) and closed, with a durable closure-evidence walk appended to its own ticket (`920a6f8`). `main` is clean and pushed. The last act was a bounded backlog-only cleanup; nothing is mid-flight.

**Picked up next:**
1. **FG-571 (FG-553 Child 4: atomic promote/rollback + PATH shim + env-sanitization) — STOPPED pending operator go.** This is the next Slice-1 child and its brief is already settled: follow the accepted FG-553 plan, **swap-and-retain only (no release GC)**, and **no process supervision / PID ownership registry / "confirm dead" machinery**. The operator's standing safety constraint: **do not modify or activate the real machine-wide `current` pointer, installed shim, interpreter store, or the active Forge runtime during validation** — use disposable test locations. Test promotion, rollback, torn/interrupted installs, hostile PATH, NODE_OPTIONS/NODE_PATH injection, lazy ESM/CJS/native loads, and forge-dev isolation.
2. **FG-572 (Child 5: installed-surface compatibility)** — after FG-571. The operator scoped this as a **read-only architecture/propagation pass ONLY**: establish the compatibility treatment for every external surface (especially the dashboard workspace); **do not implement, allocate tickets, or pick an accepted-unavailability product boundary without the operator.**
3. **Standing test/infra false-alarm tickets** — FG-556 (`/var` symlink canonicalization, macOS-host-only), FG-557 (wall-clock re-sync threshold), FG-559 (linked-worktree `.git` pointer). None block; together they'd make a host/agent run trustworthy at a glance. FG-558 (dashboard PRD missing `awaiting_recovery`) is a small docs fix. (FG-551/tmux is now **done** — the old block listed it as open.)

**External state to remember:**
- **`~/code/forge-fg561` is a standalone clone** used as the writer-agent workspace for this campaign, per the operator's "never use writable main as an agent implementation workspace" rule (DEC-019's shadow volume isolates `node_modules`, NOT source). Its `fg570-bounded-abi-assertion` branch was merged + deleted; the clone itself is still on disk and reusable for FG-571.
- **Docker Desktop stopped mid-session** and silently failed a review-loop round (`reviewer_failed`, zero-byte result). If a reviewer returns an invalid/absent result, check `docker info` before suspecting the code.
- **No Node 26 on this host** (nvm tops out at v25/ABI 141). The F31 too-new arm gets its real Node v26.3.1/ABI 147 from **CI `test-extended`**, which provisions it. Anything needing a genuinely-too-new interpreter locally must account for this.
- Untracked `docs/research/competitive/pinecone-forge-assessment.md` is the operator's own research doc — never `git add -A` at repo root without looking.

**Decisions worth not relitigating:**
- **A release is the sole authority on its own binding's ABI.** Anything unverifiable about it — missing/empty/garbage `abi`, or a manifest that won't parse — **refuses BY NAME**; it never falls back to the dev pin. My original "fail open when the ABI is undeterminable" brief was **wrong** and produced three separate reviewer findings; this is the corrected principle.
- **`engines: "^24"` (the ABI-137 range) is settled** (FG-574, closed with FG-570). The "keep engines loose" alternative was considered and rejected; engines is the earlier install-time signal and **must bump with `.nvmrc`**.
- **The Node prerequisite is ABI equality, not an exact Node version.** The gate compares only `process.versions.modules`, so any ABI-137 release starts; `.nvmrc` is the *tested/supported* way to obtain that ABI. README + `docs/work-laptop-setup.md` say this now — don't "fix" them back toward naming a version.
- **PRD / plan / epic / backlog are orchestrator-direct; only `docs/**` prose (e.g. concepts.md, work-laptop-setup.md) goes to the documentation-maintainer.** Operator corrected this last session; it held all of this one.
- **`closeout_guidance_only` is a near-pass** — confirm the withheld findings are genuinely backlog closeout, then merge; don't re-loop to chase it.

**Operational lessons (worth keeping):**
- **Reconciliation tickets need a whole-corpus grep UP FRONT.** FG-573 took **7 review rounds** because the reviewer found one stale spot per round. Grep every phrasing of the changed premise across ALL backlog + docs and fix in one pass. Revision-log entries get an **inline "superseded" marker**, never a rewrite.
- **Docs drift cuts both ways:** prose can be *stricter* than shipped behavior, not just staler. Both late FG-570 findings were my README/setup prose demanding an exact Node version the code never required.
- **The review-loop earned its keep** — every FG-570 finding was real and mine. Reviewer-caught: fail-open on unreadable ABI, malformed-manifest fallback, two docs-drift spots.
- `forge launch run` + a Monitor on the launch record drove every round; watch durable launch state, never pgrep. Host `npm run test:extended` still dies under tmux — let CI own the extended tier.

**Shipped (for reference):**
- **FG-570** — FG-553 Child 3: bounded ABI assertion replacing the minimum-major floor (merged `5044c5d`, PR #123). Exact ABI equality (upper AND lower bound), named refusal before native load, native-free import graph, fail-closed on an unverifiable release manifest. F31 executes for real in CI under Node v26.3.1/ABI 147 (mandatory — reddens, never skips) plus a host triad (v25/141, v24/137, v23/131); `>=` mutant reddens the too-new case.
- **FG-574** — `package.json engines: "^24"`, closed with FG-570.
- **FG-573** — PRD/epic/plan/concepts reconciled to landed FG-567/568/569 behavior (merged `73f7f56`, PR #122; closed `c6c306b`).
- Backlog/record reconciliations to `main`: FG-570 closure-evidence walk (`920a6f8`), FG-570+FG-574 close + merge-sha propagation across the Slice-1 records (`2e0cac5`).

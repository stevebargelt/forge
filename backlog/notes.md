**Last session ended 2026-07-26.**

**Where we left off:** FG-559 fully CLOSED — the last acceptance criterion (the production agent image actually exiting 122) was verified end-to-end once docker.io came back and the image was rebuilt. Nothing from that thread is outstanding. The session's other live thread was ticket-filing discipline: the operator audited the backlog mid-session and dispositioned 4 of this session's own tickets as fold/close/demote.

**Picked up next:**
1. **FG-345 needs an OPERATOR DECISION before any implementation** — folded in from the closed FG-621: does host-side commit become authoritative under worktree mode (and the stale contract at `worktree-lifecycle.ts:231-242` gets corrected), or do agents get a writable git? This is the critical path for the worktree default-on flip and is explicitly NOT the orchestrator's call. Do not start FG-345 implementation without it.
2. **FG-356** — orphan worktree cleanup. Ready NOW: dependency FG-351 is done and it needs nothing from the FG-345 decision, so it can proceed in parallel. Live evidence it matters: `git worktree list` still shows a leftover `/private/tmp/forge-fg583-review.r8yO2f` from an old FG-583 review.
3. **FG-623** — measured ~2% flake on the REQUIRED `test` check (a 1ms margin against a live clock, 8/400 failures on an idle host). Small, self-contained, and removes noise from every future merge gate.
4. **FG-556** — now down to its ORIGINAL single file (`fg425-publication-cas.worktree.test.ts`); it is the one remaining worktree-tier failure on macOS. Fix pattern is demonstrated twice in-repo: `realpathSync(mkdtempSync(...))` at the fixture root.

**External state to remember:**
- **The agent image was rebuilt 2026-07-26** and now carries the FG-559 git probe with NO bypass (verified: `FORGE_SKIP_GIT_PROBE` count 0 in the baked entrypoint). docker.io was unreachable for part of the session and is now fine.
- **A smoke fixture is left on disk** at `scratchpad/smoke/` (a real linked worktree + parent repo) — that scratchpad path is session-scoped and will be reaped; recreate with `git worktree add` if needed.
- `~/code/forge-stable`, `~/code/forge-fg559`, `~/code/forge-fg624` (disposable clones/worktrees) still exist. Delete when no longer wanted.
- **`forge-dev` is NOT on PATH** despite being declared in `package.json` bin — use `./bin/forge-dev` from the checkout. Stale npm link; CLAUDE.md instructs `forge-dev upgrade`, which fails as written.
- **Another session edits tickets in this repo concurrently.** It corrected FG-625 while this session was independently investigating the same question, and both arrived at the same answer. Check `git status` before assuming an uncommitted backlog edit is yours.

**Decisions worth not relitigating:**
- **FG-625's root cause is UNKNOWN and the ticket says so — do not re-guess it.** Two diagnoses were made and BOTH are recorded as wrong: (a) the release integration tier's clean-checkout refusal — that was inferred from the fixer's own separate `forge-test --integration` run, not from review-loop's verifier; (b) that it is specific to `--local-extended` — `verifyWithReuse()` runs `scriptsForVerification()` on ANY dirty tree, and this project's derived gate list is `["npm run test:all","npm run test:extended"]`, so extended runs without the flag (measured). The demonstrated defect is that the post-fixer verifier DISCARDS `verification.steps`, so `verification_failed` carries no step, command, tier, or output. Direction is evidence-first: surface that result BEFORE changing behavior. Do not commit-before-verify, do not skip `test:extended`, do not touch FG-575's assertion.
- **TWO distinct local-verification paths exist in review-loop; do not conflate them.** Round-entry `verifyWithReuse()` (dirty tree → FULL tier incl. `test:extended`) vs post-fixer pre-commit `fix()` → `runVerify(localFallbackScripts())` (FAST tier only). The message `fix left uncommitted (verification failed)` comes from the second.
- **The red READ surface widening was ACCEPTED by the operator.** A whole-`.git` read-only mount lets a red read every branch, tag, reflog and sibling task branch. The isolation contract covers panel findings and the blue transcript, which are not stored in `.git`. `docs/invariants.md` #9 is amended to say so. **Do NOT build a red-only `--single-branch` clone path.**
- **The 6-minute CI shard budget does NOT move.** Raising `timeout-minutes` was proposed and rejected — the gate exists so suite-time growth gets addressed, not absorbed. FG-624 fixed it by balancing instead.
- **Two FG-559 gaps were REPORTED, not fixed, on purpose.** R1: reconcile cannot record `container.git_unavailable` for a 122 provisioner death in the host-crash window — unrecordable (`--rm`, no retained exit code), would need stderr-parsing on a five-condition conjunction. R2: a `.git` that is a file but not a `gitdir:` pointer — not reachable in practice.
- **Ticket-filing discipline was corrected.** Before `forge backlog file`: a fail-safe limitation that fails LOUDLY gets accepted; a deferred design option folds into its parent; a latent issue on another ticket's surface folds there; a small verified correction just gets fixed. Memory written: `feedback_dont_file_low_substance_tickets`.
- **FG-622 stays an idea, not a story.** Relative `gitdir:` pointers fail loudly at the probe, satisfying the safety requirement; pinned by a characterization test.

**Non-ticket thread worth keeping:** reaching the FG-559 container probe requires the RELATIVE-pointer shape (`gitdir: ../parent/.git/worktrees/wt`). Moving the parent repo away trips the HOST refusal first and no container starts — so the obvious test exercises the wrong layer and "passes" while proving nothing. Recorded in FG-559's closeout.

**Shipped (for reference):**
- **FG-559** — read-only parent `.git` bind for linked-worktree mounts; unconditional refusal (no env bypass); exit-122 sentinel classified on agent, provisioner and reconcile paths; structural verification of the pointer before mounting (SECURITY: a project-controlled `.git` could otherwise bind-mount any host path into every container). `7549b9f` (PR #161), closed `375d844` with 4/4 AC evidenced.
- **FG-624** — duration-aware integration sharding. Worst CI shard 6m10s timeout → 3m50s, budget unchanged. `4ad20e8` (PR #162).
- **FG-615** — dropped the stale "strip the `closed:` frontmatter" reopen instruction; `moveTicket` already strips it. `58b6b68`.
- Dispositioned: FG-611→FG-600, FG-616→FG-608, FG-621→FG-345 (all closed); FG-617, FG-620 closed; FG-622 demoted to idea.

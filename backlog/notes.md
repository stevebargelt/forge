**Last session ended 2026-07-28.**

**Where we left off:** FG-345 shipped isolation **default-on** and closed, but only after the operator
caught a regression neither the reviewer nor the orchestrator found: the self-host guard read
`isWorktreeModeEnabled()` ("is isolation the default on this host") as "is this dispatch isolated". Those
coincided while isolation was opt-in; default-on made them different, and a self-host `forge invoke`
would have mounted the live forge checkout unrefused. Fixed in `f50e383`.

**READ THIS BEFORE DISPATCHING ANYTHING — the dispatch contract changed today.**

1. **Isolation is now default-ON on macOS** (`FORGE_NO_WORKTREES=1` is the escape). Two preflight gates
   you will now meet that you did not before: the project must be a git repo, and its **tracked tree
   must be clean**. Commit or stash first; `FORGE_WORKTREE_IGNORE_DIRTY=1` bypasses but the agent then
   sees the committed snapshot, not your edits.
2. **`forge invoke` against `~/code/forge` now REFUSES** (self-host, `never-isolated`). So does
   `forge review-loop` pointed there — both its reviewer and its fixer dispatch through the same path.
   **`FORGE_WORKTREES=1` will NOT help and the refusal deliberately never mentions it** — arming it does
   not change what an invoke mounts. Use the workflow path (`forge new` / `forge next`) for forge-on-forge,
   or dispatch against the `~/code/forge-fg356` clone, or `FORGE_NO_WORKTREES=1` as an acknowledged override.

**Picked up next:**

1. **FG-623 — the lease flake now blocks review-loop verification.** Promoted from cosmetic today: it
   failed a `forge review-loop` verification gate on FG-345 and reproduced at **1-in-5** on an idle host
   against the ~2% the ticket records. It is a 1ms comparison against a live clock — cheap to fix, and it
   now taxes every review cycle including merge-gating ones. Highest value-per-effort item open.
2. **FG-637 — fan-out end-to-end composition coverage** (FG-628 follow-up). Deliberately deferred, not a
   defect: the decision path is shared (`dispatchReds` → `redRejection`) and correct by construction, and
   FG-482's fan-out cases cover the transition mechanics. What is untested is the composition. Its AC 3
   asks for the publisher interaction — a review-missing block must REFUSE publication and leave the
   target unmoved, not merely flip the task row.
3. **Non-ticket thread — rotate the leaked Docker Hub token.** A `dckr_pat_…` was printed into the
   session transcript while diagnosing docker. Treat as compromised; rotate at hub.docker.com → Account
   Settings → Personal access tokens. Not a backlog item, do not file one, but do not lose it either.

**External state to remember:**

- **ntfy is DOWN, and it is not a forge bug.** DNS resolves (`20.84.16.188`) but **TCP 443 never
  connects** to the Azure Container Apps host. Every `forge notify` this session failed
  `network: fetch failed`. Do not rely on push for an unattended run until the endpoint is back.
- **`docker-credential-desktop` was wedged** — `docker pull` hung with zero output for an hour, which
  looked exactly like a blocked network and was not (the registry answered in 225ms throughout). Fixed by
  restarting Docker Desktop. If pulls hang silently again, test the helper directly before blaming the
  network. A cosmetic leftover: `docker images` lists busybox while `docker image inspect` says no such
  image — harmless here, worth a look if it spreads.
- **`~/code/forge-fg356`** is the disposable clone, reset to merged `main`, clean. It is where all
  implementation ran this session and where `review-loop --project` must point for forge-on-forge.
- `agent-dev-worker:latest` (`1432466af8b5`) is current — FG-628 touched no `docker/` files, so no
  rebuild is needed for the FG-621 smoke or anything else.

**Decisions worth not relitigating:**

- **The workspace contract (operator, 2026-07-28).** A task workspace is committed tracked content at the
  recorded base SHA plus inputs explicitly supplied through Forge's own provisioning/environment
  mechanisms. Ambient local state — uncommitted, untracked, ignored — is **intentionally not inherited**.
  That is the contract, not a gap. **No generic carry-in system, no child ticket for one.**
- **The macOS-only worktree gate is PERMANENT**, not pending work. FG-358 was closed out-of-scope
  (`6c0a1a6`): forge runs only on a macOS host per DEC-004, and "Linux" in these gates means the agent
  CONTAINER. Any doc or comment still citing FG-358 as pending is stale.
- **FG-345 is narrowed to managed workflow-dispatched agents.** `forge invoke` and today's `review-loop`
  are direct shared-checkout surfaces outside the guarantee. **Do not build invoke
  merge/publication machinery** — the evidence-led review programme is expected to replace legacy
  review-loop behavior, and that question lands there.
- **The not-carried diagnostic misses ignored files, knowingly.** It uses
  `git ls-files --others --exclude-standard`, so `.env` — the highest-value case — emits no warning.
  Collecting ignored files is out of scope by decision (unbounded `--ignored` enumerates `node_modules`).
- **FG-628's AC 2 and AC 5 were both widened mid-implementation** and the originals were wrong, not
  merely incomplete. AC 5's rule is keyed on the **review artifact's provenance**, never on failure kind
  or container lifecycle — a synthesized verdict blocks orthogonally to authority. `idle_timeout` threads
  no failure kind at all, which is why a kind-list approach could never have worked.
- **Do not start exploratory review-loop passes** (operator instruction). Run it for its purpose; do not
  re-loop clean code chasing polish.

**Shipped (for reference):**

- **FG-345** (`3ce0385` + `f50e383`) — isolation default-on, platform-aware; self-host guard keyed on
  actual per-dispatch isolation. Closed narrowed in scope.
- **FG-628** (`71d7eae`, 14 commits) — mountpoint precondition moved to the mount decision; a red that
  produced no review now blocks. The dogfood falsified the ticket's own scope before any code changed.
- **FG-621** — closed on a 12-AC walk with the boundary smoke re-captured live at `71d7eae` (25 probes).
- **FG-636** — verification env no longer leaks forge's `FORGE_*` control switches into candidate suites.
- **FG-379** — the four worktree env vars documented with precedence.
- **Filed:** FG-637. **Escalated:** FG-623. **Annotated as superseded:** FG-636, FG-351, FG-612, FG-620 —
  four *closed* records that had become wrong operator guidance, FG-620's the worst (it named
  `FORGE_WORKTREES=1` as the guard remedy, the exact advice the shipped refusal withholds).

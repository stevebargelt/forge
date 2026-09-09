# How-to: terminal-run cleanup (the closeout)

When a run becomes durably terminal, Forge reconciles every **disposable** Git workspace,
publication worktree, generated branch, and host readiness record that run created —
removing only what it can prove is safe to remove, and retaining everything else with a
named reason and a concrete recovery action. This is the **terminal-run closeout** (FG-677).

It exists because "the run is terminal" is necessary but **never sufficient** authority to
delete a workspace or a branch: a clean-looking clone may hold the only copy of work in a
side branch or a stash, a directory may be the working directory of a live process, or a
container may still have it mounted. The closeout deletes only on positive proof and fails
closed on anything it cannot prove.

## When it runs

- **Automatically**, at the `forge next` wave boundary. After `forge next` reconciles the
  run it just advanced, it drives the closeout for that run (best-effort — a cleanup problem
  never breaks the wave). Only durably-terminal runs are closed out; a run still in flight is
  left entirely alone.
- **On demand**, via `forge ops cleanup`.

There is **no daemon** — cleanup is piggybacked on the wave boundary and the manual command,
exactly like the FG-590 launch/container retirement it composes with.

## The commands

```
forge ops cleanup                 # close out the current project's durably-terminal runs
forge ops cleanup --dry-run       # INVENTORY ONLY: mutate nothing; print the exact proposed
                                  #   disposition and proof for every artifact
forge ops cleanup --project <dir> # scope to a specific project directory (default: cwd);
                                  #   ignored with --all
forge ops cleanup --all           # host-global convergence: also sweep terminal launches and
                                  #   retained containers across EVERY project on this host
forge ops cleanup --json          # structured JSON (the full RunCleanupReport + FG-590 result)
```

`--dry-run` performs **no** mutation. Its proposed dispositions match what the subsequent
real pass performs (absent any intervening state change), because every section runs the
same safety proofs and forks only at the final, irreversible step. (The destructive launch
and container sweeps have no dry-run mode — they only remove — so a dry run skips them and
reports the owned-closeout inventory alone.)

`--all` widens only the launch and container reach: it retires terminal launches and expired
retained containers across every project on this host, under the code-default retention
windows only — neither a project-local `.forge/config.yml` override nor a `FORGE_RETENTION_*`
env override reaches it, so no single project's configuration can widen or narrow a
host-global pass (see **Launch retention convergence** below). The report names this posture
explicitly: `retention: host-global (--all) sweep — CODE-DEFAULT windows only; FORGE_RETENTION_*
/ project-local overrides ignored so they cannot reach across projects`. The owned closeout
(git workspaces, generated branches, publication worktrees, readiness records) stays scoped to
**the current directory's project** — those artifacts are project-owned — so `--all` is a
host-global *launch/container* convergence surface, not a cross-project workspace reaper. An
explicit `--project <dir>` is ignored when `--all` is also given: the owned closeout always
anchors to cwd in that case, since `--all` already widens the only cross-project part of the
pass.

## What it owns, and what it only reports

The closeout **owns** the retirement policy for four resource classes:

| Resource class          | What it is                                                             |
| ----------------------- | --------------------------------------------------------------------- |
| `git_workspace`         | private task clones, linked task/review worktrees, stale registrations |
| `generated_branch`      | Forge-generated `forge/<runId>/<taskId>` task branches                 |
| `publication_worktree`  | installed publication-attempt worktrees under `~/.forge/worktrees/publications` (FG-631, absorbed) |
| `readiness_record`      | host readiness records under `~/.forge/host-readiness` (FG-632, absorbed) |

It **reports, but does not own**, the FG-590 disposition of **tmux launch sessions** and
**retained task containers** — those lines are shown for completeness (`tmux launches (FG-590,
reported): …`), never re-run or re-authorized here. FG-590 owns any future safe tmux-server
recycle; the closeout never kills or recycles a tmux server (FG-614 forbids it).

The closeout never deletes or compacts `~/.forge/runs`, review evidence, manifests, logs, or
the Forge database.

## Retention reasons

A retained artifact always names the exact reason and its path. The reasons:

**Content proofs (a workspace holds work that is not safely captured):**

- `uncommitted_work` — uncommitted, untracked, **or ignored** files are present.
- `unmerged_commits` — a commit on the branch/HEAD is not reachable from Forge-owned
  published/merged state.
- `remote_target_uncaptured` — the work targets a `remote:` publish target and is not proven
  landed there.
- `submodules_present` — checked-out submodules may hold unique work the top-level status
  does not see.
- `branch_uncaptured` — a generated branch's tip is not provably captured, so it is never
  force-deleted (branch-name shape alone is **never** deletion authority).

**Ownership / liveness (deleting would be unsafe or ambiguous):**

- `active_process_cwd` — a **live process** (including the long-lived tmux server) holds the
  directory as its working directory. Deleting it would brick every session that process
  later forks (the 2026-08-05 incident). The holding process is named in the report.
- `active_mount` — a **live container** still has the workspace mounted (probed directly via
  docker, never inferred from a task's status).
- `ownership_ambiguous` — Forge cannot positively attribute the directory to a terminal
  attempt: no attesting registry row, or, for a publication worktree, `git worktree list`
  in the owning project itself does not attest the directory as a registered worktree (a
  name collision or an orphaned bare directory git never registered). Registry row, name
  shape, and directory shape are each individually never ownership proof.
- `publication_in_flight` — a publication attempt is still in flight or its liveness is
  ambiguous; never raced.
- `readiness_live_reader` — a live dispatch may still consume the readiness record.
- `within_retention_for_investigation` — a failed/parked publication worktree kept inside its
  diagnostic window (7-day default) as evidence; it retires automatically after the window.
- `workspace_not_owned` — Forge could not prove the tree is one it owns (FG-693 identity /
  FG-621 ownership).
- `retained_failure_kind` — the task's failure kind preserves its workspace as evidence.
- `parent_repacking` — transient: the parent repo is running `git gc`; the next pass retries.
- `removal_failed` — the removal did not complete; retry, or remove by hand.

If an artifact cannot be **probed** (an unreadable process cwd, an unreachable docker daemon,
a tmux that cannot answer), the closeout **retains** it — it never guesses a directory is
unheld.

**Dead tmux panes are a proven negative, not an unprobed candidate.** The `active_process_cwd`
gate enumerates the tmux panes whose processes might hold a workspace cwd. A pane left behind
by `remain-on-exit` (`#{pane_dead}=1`) has no live process — its pid is gone, so probing it
can only fail. Such panes are now excluded at enumeration: a dead pane never contributes a pid
to the candidate set and so can never push the gate to *unprobed*. Previously a single dead
pane (the host carried over 1300) made every workspace's cwd gate read *unprobed*, so the
liveness check retained **every** terminal workspace as ambiguous and the cleanup inventory
could never converge. The honesty boundary is unchanged for live processes: a genuinely
unreadable **live** pid still reads *unprobed* and still forces retain — only the dead-pane
false positive is removed.

**An unreadable open-launch record fails the whole pass closed, not just one workspace.** Once
per pass the closeout reads every OPEN launch's working directory so a launch still running in
a workspace forces `active_process_cwd` retain at the git-workspace/publication-worktree
chokepoints. If that read throws — the launch-observation store exists but cannot be queried —
the pass does **not** fall back to "no open launches" (which would let a live launch's
workspace be reaped on a missed process probe). It instead retains **every** workspace in the
pass as `active_process_cwd`, with the holder text naming the read failure ("open launch
holders unreadable — retaining every workspace (fail closed): …"). Re-run `forge ops cleanup`
once the store is readable again.

## Recovering or archiving unique work before retrying

When the closeout retains a workspace because it holds unique work, recover it first, then
re-run `forge ops cleanup`:

- **Unique commits** (`unmerged_commits` / `branch_uncaptured`): merge or publish the branch,
  or archive its history —
  ```
  git -C <workspace> bundle create ~/archive/<task>.bundle --all
  ```
- **Dirty / untracked / ignored files** (`uncommitted_work`): commit or stash them, or copy
  them out —
  ```
  cp -a <workspace>/<paths you care about> ~/archive/<task>/
  ```
- **A stash**: `git -C <workspace> stash list`, then `git stash show -p` and save the patch.
- **A live process holding the cwd** (`active_process_cwd`): stop the process, or `cd` it out
  of the directory (the report names the holding pid), then re-run cleanup.
- **A live mount** (`active_mount`): stop the named container, then re-run cleanup.

The closeout is **idempotent and crash-safe**: interrupting it between the filesystem delete,
the git/branch & registry prune, and the durable record converges truthfully on the next
pass — a resource already retired is simply absent, and its disposition is a no-op.

## Launch retention convergence

Alongside the owned closeout, the cleanup pass composes the FG-590 retirement of terminal tmux
launch sessions (reported, not re-authorized — see above). That launch sweep is normally
**project-scoped**: to protect a live project's launches, it excludes any launch the
observation store attributes to a *different* project (RF-5). A project-local retention
override (a repo `.forge/config.yml` or a `FORGE_*` env, including a zero window) can re-time
the current project's cleanup but can **never** reach another live project's launches.

That scoping left one class of launch stranded. A launch whose owning project was a disposable
clone that has since been deleted is foreign to *every* remaining project, so the
project-scoped sweep never converged it — its dead tmux panes accumulated without bound (this
is how one host reached 1300+ dead panes). Such launches now converge:

- A launch is classified **vanished-owner** by a **path-based** test: its recorded checkout's
  parent directory/volume is present but the checkout leaf itself is absent. This classification
  **fails closed**: an owner on an **unmounted** external/network volume (parent absent), or a
  store or registry lookup that throws, resolves to *not vanished* and the launch stays excluded
  — bare "the leaf path is missing" alone is never enough; the parent must resolve too.
  Deliberately accepted: a checkout that was **moved** (not deleted) is indistinguishable from
  one that was deleted — the git identity a mover would still resolve by is derived from the
  now-absent recorded path, and a disposable clone shares its parent's repo identity, so the two
  cases can't be told apart from what's on disk. A moved checkout's already-terminal launch
  records therefore age out under the built-in retention windows below (never under a
  project-local or `FORGE_RETENTION_*` override), and a still-**running** launch is never
  affected — `removeLaunch` refuses to remove one. This is acceptable because those records were
  already orphaned before the move: no remaining project's scoped sweep owned them, so the only
  thing a moved project can lose is a longer-than-default local retention window on its
  diagnostic remains.
- Vanished-owner launches are swept under the built-in `DEFAULT_RETENTION_POLICY` windows
  (`exited_ok` retires promptly; failure/ambiguous is kept for the 7-day diagnostic window) —
  deliberately **not** the caller's policy. Using the default windows means a project-local
  zero-window override can never reach a vanished owner, which by construction guarantees it can
  never reach a **live** other project's launches either. RF-5 is preserved: a zero-window
  override retires a vanished owner past the default window, and still leaves every live
  other-project launch untouched.

This convergence runs from **any** project dir. `forge ops cleanup --all` additionally sweeps
every project's launches and retained containers host-globally, so an operator can force
convergence on demand regardless of which project they invoke from.

**Deliberate non-goal (this change):** the closeout pass is **not** bounded by a wall-clock or
probe-count budget. A single pass previously re-enumerated every tmux pane and spawned one
`lsof` per pid for *every* workspace gate — O(pids × workspaces) — so a closeout on a
dead-pane-laden host ran for hours holding the run lock. The pass is now bounded instead by two
structural fixes: excluding dead panes at enumeration (above) and a per-pass pid→cwd cache that
probes each candidate pid's working directory **at most once** and reuses it across every
workspace gate in that pass (O(pids), not O(pids × workspaces)). An explicit budget with honest
truncation reporting was considered and left out pending a product-set ceiling; if added later
it would degrade the un-probed remainder to the existing *unprobed → retain* verdict with a
named truncation reason, never a silent skip.

## Configuration

The retention windows are code defaults (success retires promptly; failed/ambiguous is kept
for a 7-day diagnostic window). Override only the timing with `.forge/config.yml`'s
`retention:` block or the `FORGE_RETENTION_SUCCESS_MS` / `FORGE_RETENTION_FAILURE_MS` env
vars. An override can only re-time cleanup — it can never widen the safety posture, because
the "never remove a running/held/uncaptured artifact" rules live at the destroy chokepoints,
not in the policy.

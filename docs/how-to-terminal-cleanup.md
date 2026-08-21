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
forge ops cleanup --project <dir> # scope to a specific project directory (default: cwd)
forge ops cleanup --json          # structured JSON (the full RunCleanupReport + FG-590 result)
```

`--dry-run` performs **no** mutation. Its proposed dispositions match what the subsequent
real pass performs (absent any intervening state change), because every section runs the
same safety proofs and forks only at the final, irreversible step.

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
  attempt (no attesting registry row). Path shape is never ownership proof.
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

## Configuration

The retention windows are code defaults (success retires promptly; failed/ambiguous is kept
for a 7-day diagnostic window). Override only the timing with `.forge/config.yml`'s
`retention:` block or the `FORGE_RETENTION_SUCCESS_MS` / `FORGE_RETENTION_FAILURE_MS` env
vars. An override can only re-time cleanup — it can never widen the safety posture, because
the "never remove a running/held/uncaptured artifact" rules live at the destroy chokepoints,
not in the policy.

# Cutting a project's backlog over to the DB store

A project's tickets live in exactly one authoritative store: `markdown` (files under `backlog/`, the default) or `db` (rows in `~/.forge/forge.db`, keyed by `project_key`). This doc is the operator runbook for moving one project from the first to the second with `forge backlog migrate`.

Read this before you run it. **The cutover is one-way in practice** — there is no Markdown export, so a migrated project's `backlog/*.md` becomes a frozen snapshot the moment it takes its first DB-only edit, and forge refuses to flip back after that.

Concepts: `docs/concepts.md` → **Backlog storage mode**. Command reference: `forge backlog --help` and the `forge-backlog` skill.

## What is and isn't affected

- **Nothing changes for a project you don't migrate.** `markdown` is still the default, and the cutover is per project. The shared tables the DB store uses are additive and sit unused until a project opts in.
- The additive schema is applied machine-wide on the next writable open of `~/.forge/forge.db`, migrated projects or not. That is safe by construction — the tables and columns are new, nullable or defaulted, and nothing reads them for a markdown-mode project — but it does mean the change is visible to every project on the host, not just the one you migrate.
- An **older forge binary** on the same host will open a migrated store happily. The schema changes are additive, so the forward version gate never fires; that older forge keeps reading the frozen `backlog/*.md` and never sees DB edits. `migrate` prints the forge revision that performed the flip so you can tell which bytes did it.

## Before you migrate

**1. Settle the project's identity.** The registry keys a project on its *repository evidence*, which is source-dependent: a repository registered while it had no remote gets a different evidence key the moment `git remote add origin` runs. `migrate` is what first commits a `project_key`, so this refusal only becomes reachable at cutover.

```bash
forge backlog mode          # should report a mode + project_key, not a refusal
```

If it refuses with an identity mismatch, the message names which side moved. When the *evidence* moved and `.forge/config.yml` is right:

```bash
forge backlog reidentify --confirm --key <projectKey>
```

`--confirm` is required: this is an operator assertion about which repository this is, never something forge infers, and there is no read-path or in-container way to do it.

**2. Rebuild and redistribute the agent image.** The image ships the in-container `forge backlog` reader (`docker/forge-backlog-reader.mjs` and the `forge` shim beside it). Rebuild it as part of the cutover so every host's containers are self-sufficient:

```bash
./docker/build.sh          # or, from a dev checkout: forge upgrade --rebuild-image
```

Forge also binds its own copies of both files over the same in-container paths at dispatch, so a container always executes the *dispatching* forge's reader rather than whatever was baked into the image. Treat that as belt-and-braces, not as a reason to skip the rebuild — a host whose forge cannot supply those files falls back to what the image shipped.

**3. Finish the project's in-flight work.** `migrate` refuses while the **target** project has an active run or a running campaign (activity in other projects never blocks it). This is not bookkeeping: the storage mode is read through a short-lived cache and campaign guards re-resolve the store on every drive step, so flipping mid-run would have earlier steps reading Markdown and later steps reading the DB.

## The cutover

```bash
cd ~/code/my-app
forge backlog migrate --dry-run     # plan only — writes nothing, not even the import
forge backlog migrate
```

`migrate` is **one atomic operation**: import → validate → flip.

1. **Import** `backlog/*.md` into ticket rows. All-or-nothing; a malformed source file writes zero rows.
2. **Validate** that the DB shadow exactly equals this checkout's Markdown set. It refuses and names the difference if anything is missing on either side, or if the import skipped a conflict.
3. **Flip** the host-side mode to `db`. This is last and runs in the same transaction as the no-active-work re-check and the cutover record.

**On any failure the mode is not flipped and Markdown remains authoritative.** There is no half-migrated project.

Two flags worth knowing:

- `--dry-run` reports the project_key, current mode, ticket count, and what it would flip to. It writes nothing at all — including not claiming a `project_key`, so you can inspect a cutover on a project that has never been imported.
- `--force` overwrites DB rows whose content diverged from the basis they were last imported from. Without it those ids are **skipped** and recorded as `import_conflict` events, and the validate step then refuses the cutover — Markdown never silently clobbers a newer DB edit. A forced overwrite records before/after evidence in the same event.

### Verify it took

```bash
forge backlog list --status active     # banner should read: store: db (project_key=…)
forge backlog show <id>
```

The banner is on stderr, so `--json` stdout stays pipeable. ` — backlog/ present but NOT authoritative` after the project_key is expected: the frozen files are still on disk.

## After the cutover: the one-way property

- `backlog/*.md` is a **frozen snapshot**. Nothing writes those files again; edits to them are invisible to forge.
- The **first DB-only edit is recorded**, and after it `forge backlog mode --set markdown` refuses. Reverting would silently discard every edit made since the flip — including edits to tickets that still have a Markdown file, which the orphaned-ticket check cannot see.
- Clean rollback therefore exists only *before* that first edit: `forge backlog mode --set markdown` while nothing has been edited in the DB.
- If you have already reconciled `backlog/*.md` by hand and accept losing whatever you missed, `forge backlog mode --set markdown --accept-frozen-markdown-loss` overrides the refusal. It is an acceptance of loss, not a repair.

Whether to delete the frozen `backlog/` directory is your call — forge does not need it in db mode, and `notes.md` stays a per-checkout file in both modes, so keep the directory if you use notes.

## Re-importing after cutover

Re-running `forge backlog import` on a migrated project stays useful (pulling in a branch's Markdown, say), and it is no longer additive-only:

- **Removals propagate.** A ticket, relation, or blocker marker absent from Markdown is deleted from the DB — but only when **no live source still claims it**.
- **A source is one physical checkout.** Its id is minted once and kept in that checkout's git admin dir: never git-tracked, moves with the repo, distinct per linked worktree. So removing a ticket in one worktree while a sibling worktree still has it keeps the ticket.
- **It fails closed.** Rows that predate this bookkeeping are never pruned, and an import that can observe no live source at all refuses rather than reading "observed nothing" as "everything was removed".
- **Diverged rows are skipped, not clobbered** — the same conflict rule `migrate` uses.

When a checkout is permanently gone (a deleted clone, a reaped worktree), its membership would otherwise pin tickets forever. Release it:

```bash
forge backlog forget-source --list          # this project's live sources
forge backlog forget-source --source <id>
```

## What cutover unlocks: the operator queue

Four verbs become available once a project is in db mode, and they are **db-mode only** — before cutover all four refuse by name, because the DB tickets table is a write-only shadow there and queue state written into it is state nothing reads.

```bash
forge backlog rank FG-123 --position 1     # stack rank (--clear to unrank)
forge backlog enqueue FG-123               # select for execution
forge backlog dequeue FG-123               # unselect; the rank is RETAINED
forge backlog reorder FG-123 --to 2        # or: --order FG-9,FG-3,FG-123
```

The executable queue is *queued **and** active **and** ranked*, in rank order. `enqueue` refuses unless the ticket's **current** revision is ready (or exploratory), naming what is missing; re-running it after an edit **is** the recheck. Editing a ticket marks its stored readiness `STALE` until then. Blocked tickets keep their rank and stay in the queue, visibly blocked; done and deferred ones leave the executable queue but keep their rank, membership and full queue history, so reactivating one restores the identical order. The queue's `blocked` flag reads **every** kind of blocker evidence — legacy blocked, plus dependency / campaign / run-derived rows recorded as blocking — while the ticket's own `status` stays legacy-only, so a dependency blocker is visible where you act on it without changing what a container reads.

Queue state is **host-only**: it never reaches a container, never joins `list`/`show` output, and a queue write publishes no snapshot — so ranking a ticket costs nothing to the containers already running. Full operator reference: the [`forge-backlog` skill](../seeds/skills/forge-backlog/SKILL.md); the model is in [concepts](concepts.md#operator-queue).

### Queue claims land in the same db-only bucket

Cutover is also what makes **queue claims** (FG-610) reachable — the durable reservation, lease, fencing generation and launch identity that let a dispatcher say "I am executing this queue entry" and let a recoverer tell a crashed controller from a slow one. There is no operator verb for it yet: FG-610 ships the store primitives, and the dispatcher that consumes them is FG-591. Three things are worth knowing at cutover time anyway:

- **They are db-mode only, for the same reason the four queue verbs are** — a lease, a fencing generation and a launch identity have no Markdown representation, so every claim entry point (reads included) refuses by name on a markdown-mode or unkeyed project rather than reserving rows nothing reads.
- **They are additive and inert until something claims.** The `queue_claims` table appears machine-wide on the next writable open like the rest of the schema, and no CLI verb, API route, dashboard payload or container snapshot exposes it. A project that never opted in sees no behavior change.
- **A claim never touches ticket state.** Claiming, taking over and releasing write the claim row only — no `tickets.status`, no rank, no membership, no readiness row. Dequeue, unrank or defer a *claimed* ticket and the claim is left byte-unchanged: the operator queue and the execution reservation are separate facts, and the claim is the recovery record for a container that may still be running.

The model, including why an expired lease authorizes nothing and why recovery adopts a prior launch instead of duplicating it, is in [concepts](concepts.md#queue-claims); the table is in `docs/SCHEMA-CONTRACT.md` → **queue_claims**.

## Agents and containers after cutover

Containerized agents read tickets through a **read-only, project-scoped, backlog-only** snapshot mounted into the container — `forge backlog list` / `show` inside a container resolve that, not the mounted checkout's frozen Markdown.

- It is **live**: a host-side ticket edit made after the container started is visible to that container's next `forge backlog show`, because the host republishes the snapshot on every authoritative ticket write.
- The full `~/.forge/forge.db` is never mounted. Other projects' tickets and forge's run/task/event tables are not present in the file at all.
- Every mutating verb refuses, and the mount is read-only at the kernel level, so that holds even though agents have root in their own container. Ticket changes happen on the host.
- `show` names both the dispatched and the current revision when the ticket has advanced since dispatch, rather than pretending the task package changed.

**Watch for `warning: … snapshot(s) are STALE`** under the store banner on host `forge backlog` commands. It means a host ticket write did not reach a running container's snapshot after bounded retries — the host store is still correct and authoritative; what failed is the fan-out, and an agent may be reading an older ticket.

**Watch also for `forge: could not resolve the backlog authority for <task> from <dir>`** on the host during dispatch. After cutover this is the shape an identity problem takes: the project declares a `project_key` the registry maps to different repository evidence, so the dispatch proceeds with no ticket authority and the agent's backlog reads refuse. Settle it exactly as at cutover (`forge backlog reidentify --confirm`, step 1 above) and re-run. Note that authority is resolved against the project directory forge recorded for the run, not the workspace the task runs in, so a task workspace can never be the cause.

The same line has a second shape — **`forge: resolved the backlog authority for <task> from <dir> but could not publish its ticket snapshot`** — which is *not* an identity problem: the key resolved correctly and the snapshot publication then failed, so the container is ticket-blind for a different reason (a busy DB under a second forge process, a snapshot that would not build). `reidentify` is the wrong tool for it; re-run once nothing else is contending for the store. Both shapes are recorded durably as a `container.backlog_authority_unresolved` event on **the run and the task**, with `payload.stage` (`"resolve"` or `"publish"`) naming which one — so `forge show <run-id>` is where to look after the fact. A project that has not cut over declares no key, resolves `markdown`, and never emits any of these.

## Migrating the rest of a portfolio

Each project cuts over on its own schedule by running `forge backlog migrate` in it. There is no global flip, and there is deliberately no bulk verb — the refusals above are per project and want an operator present for each one.

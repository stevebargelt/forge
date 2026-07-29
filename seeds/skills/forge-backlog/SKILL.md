---
name: forge-backlog
description: Read and manage structured backlog tickets (list, show, file, close, edit, retitle, move, notes, config, mode, migrate) via `forge backlog`. Use this as the bounded interface for ticket work instead of hand-editing files under backlog/.
---

# forge-backlog

`forge backlog` is the CLI over a project's structured backlog of idea/epic/story tickets. Source of truth for exact flags: `forge backlog --help` and `forge backlog <subcommand> --help`.

Each project has one **authoritative** ticket store, its *storage mode*: `markdown` (the default — one file per ticket under `backlog/`) or `db` (rows in the host `forge.db`, opt-in per project via `forge backlog migrate`). Every verb below behaves the same in either mode; only where the bytes land differs. See **Storage mode** below.

## Non-goal

Host/orchestrator skill only. It documents a CLI command run from the terminal. Containerized agents do not discover or read `.claude/skills` — but they *do* get a read-only `forge backlog list/show` of their own; see **Reading tickets inside an agent container** below.

## Subcommands

```
forge backlog list  [--status active|done|blocked|deferred] [--type idea|epic|story] [--search <text>] [--json] [--project <dir>]
forge backlog show  <id> [--json]
forge backlog file  "<title>" [--body <text>|-] [--type idea|epic|story]
forge backlog close <id> [--commit <sha>]
forge backlog edit  <id> [--body <text>|-]
forge backlog retitle <id> "<new title>"
forge backlog move  <id> <type>
forge backlog import [--project <dir>] [--json]
forge backlog migrate [--dry-run] [--force] [--project <dir>] [--json]
forge backlog mode  [--set markdown|db] [--allow-orphaned-tickets] [--accept-frozen-markdown-loss] [--json]
forge backlog reidentify --confirm [--key <projectKey>] [--json]
forge backlog forget-source [--source <id>] [--list] [--json]
forge backlog config [--show]
forge backlog notes show
forge backlog notes add     [text|-]
forge backlog notes replace [text|-]
```

- `list`/`show` are read-only; use `--json` for machine-readable output when scripting or piping into another step.
- `file` creates a new ticket; `--body -` reads the body from stdin (useful for multi-line bodies piped in).
- `close` marks a ticket done and records the close date; `--commit <sha>` attaches the shipping commit.
- `edit` replaces a ticket's body wholesale — it is not a patch/append operation.
- `retitle` changes a ticket's title (frontmatter + heading) in place — in markdown mode without moving or renaming its file.
- `move` moves a ticket between the idea/epic/story types (in markdown mode, between the type directories).
- `notes` reads/writes the project's `backlog/notes.md` "notes for next session" block — `add` appends a paragraph, `replace` overwrites the whole file. Notes are **not** part of the ticket seam: they stay a file in `backlog/` in both storage modes.
- `import` copies the project's `backlog/*.md` into DB ticket rows. While the project is in `markdown` mode those rows are a **non-authoritative** shadow — Markdown stays the source of truth and nothing reads them for behavior. Import seeds the `(project_key, prefix)` id sequence past the ids the project already uses (which is why `mode --set db` requires one first; `migrate` runs it for you). It is idempotent — re-running upserts rather than duplicating — and on first run it records a durable `project_key` in `.forge/config.yml` so the DB backlog stays single across a project's clones and linked worktrees. It does not require a `backlog/` directory — importing an empty project is how a fresh one claims its `project_key`. If two configs/worktrees present conflicting project identities for one project it **refuses** (exit code 1, structured object under `--json`) rather than splitting the backlog. Two behaviors are worth knowing before you re-import a project that already has DB rows:
  - **Removals propagate** (they no longer accumulate). A ticket, relation, or blocker marker deleted from Markdown is deleted from the DB — but only when **no live source still claims it**. Each physical checkout is a *source*, identified by a random id minted once and kept in that checkout's git admin dir (never git-tracked, moves with the repo), so removing a ticket in one worktree while a sibling worktree still has it keeps the ticket. Rows that predate this bookkeeping are never pruned, and an import that can see no live source at all **refuses** rather than treating "observed nothing" as "everything was removed".
  - **A diverged row is skipped, not clobbered.** If a ticket's DB row was edited since the basis it was last imported from, import leaves it alone and records an `import_conflict` event; Markdown never silently overwrites a newer DB edit. Only `migrate --force` overwrites, and it records before/after evidence in the same event. `--json` reports what happened: `skippedConflicts`, `prunedTickets`, `prunedRelations`, `prunedBlockerEvidence`, and the `sourceId` this checkout imported as.
- `migrate` is **the cutover** — one atomic import → validate → flip to db mode. See **Cutting a project over to db mode** below; the full runbook is `docs/how-to-backlog-db-cutover.md`.
- `mode` shows or sets which store is authoritative — see **Storage mode** below.
- `reidentify --confirm` re-points the registry's *repository evidence* for a `project_key` at this checkout. Needed when the evidence key moved but the project did not — most commonly after `git remote add origin` on a repository that was registered while it had no remote, which otherwise makes every `forge backlog` command refuse. `--confirm` is required because this is an operator assertion about identity, never something forge infers, and there is deliberately no way to do it from a read path or from inside a container.
- `forget-source` releases a source that is permanently gone (a deleted clone, a reaped worktree), so the tickets only it still claimed become prunable on the next import. `--list` shows the project's live sources first; with no `--source` it forgets this checkout's own.

All subcommands accept `--project <dir>` (default: cwd) to target a backlog outside the current directory.

## Storage mode

A project's mode lives in the host DB keyed by `project_key`, **not** in each worktree's `.forge/config.yml` — so two linked worktrees of one project can never disagree about which store owns the tickets. The mode is authoritative: the CLI reads `db` **or** Markdown, never both, and never silently falls back from one to the other.

```
forge backlog mode                  # report: mode + project_key (--json adds staleMarkdown)
forge backlog mode --set db         # opt this project into the DB store
forge backlog mode --set markdown   # back to files (refuses if it would strand tickets)
forge backlog migrate --dry-run     # the cutover, reported without writing anything
forge backlog migrate               # the cutover: import + validate + flip, atomically
```

- **`markdown` is the default and nothing changes until you opt in.** A project that has never run `mode --set db` behaves exactly as it always has.
- **Every verb that touches the store prints which one it read**, as a one-line banner on **stderr** — `store: legacy markdown`, or `store: db (project_key=…)`, with ` — backlog/ present but NOT authoritative` appended when a stale `backlog/` directory is still on disk. Inside an agent container holding a snapshot mount it names the mount instead: `store: db snapshot (project_key=…, published <timestamp>, read-only mount)`. It is on stderr precisely so `--json` stdout stays machine-clean. The verbs that skip it are `config` and `notes` (they never touch the ticket seam) and the identity/cutover paths `import`, `mode`, `migrate`, `reidentify`, and `forget-source` — their own refusals are the output that matters, and a banner resolving first would preempt them with a less precise error.
- **A `warning: … snapshot(s) are STALE` line under the banner is real.** It means a host ticket write did not reach a running container's snapshot after bounded retries, so an agent may be reading an older ticket. The host DB is still authoritative and correct; what failed is the fan-out to that container.
- **In `db` mode a project needs no `backlog/` directory at all.** Full CRUD works without one, `file` reports just `Created <id>: <title>` (there is no path to name), and `close`/`move`/`retitle` write rows rather than moving files — so filing, editing, and closing tickets leave `git status` clean.
- **Both flips refuse rather than lose tickets.** `--set db` refuses if `import` has not seeded the id sequence (allocation would re-mint ids that exist only as Markdown), and refuses from a checkout with no `backlog/` when the project demonstrably has tickets, since that checkout cannot verify the ids it would allocate above. `--set markdown` refuses when DB tickets have no Markdown file — in markdown mode nothing would read them; pass `--allow-orphaned-tickets` to flip anyway and it warns with the ids it stranded (first ten, then a count). Any id sequence a flip advances is reported on stderr, never moved silently.
- **Cutover is one-way, and that is enforced rather than advised.** There is no Markdown export, so once a `db`-mode project takes a DB-only edit its `backlog/*.md` is a frozen snapshot. That first DB-only edit is *recorded*, and `mode --set markdown` refuses afterwards — reverting would silently discard every edit since the flip, including edits to tickets that still have a Markdown file (which the orphaned-ticket check cannot see). Clean rollback exists only before that first edit. If you have reconciled `backlog/*.md` by hand and accept losing anything you missed, `--accept-frozen-markdown-loss` overrides the refusal.

## Cutting a project over to db mode

`forge backlog migrate` is **one atomic operation**: import → validate the DB shadow equals this checkout's Markdown set → flip the host-side mode to `db`. The flip is last, so **any failure leaves Markdown authoritative and the mode unchanged** — there is no half-migrated project. `--dry-run` reports the plan (project_key, current mode, ticket count, what it would flip to) and writes nothing at all, not even the import.

- It **refuses over the target project's own in-flight work** — an active run or a running campaign whose project resolves to this `project_key`. Activity in *other* projects never blocks a migration. The reason is split truth within one run: the mode is read through a short-lived cache and campaign guards re-resolve the store on every drive step, so a mid-run flip would have earlier steps reading Markdown and later steps reading the DB.
- It refuses if the post-import DB shadow does not equal the Markdown set, naming what is missing on each side, and it refuses on import conflicts rather than clobbering them (`--force` overwrites those, recording before/after evidence).
- On success it prints the one-way cutover notice and the forge revision that performed the flip. Nothing in the store stops an *older* forge binary from opening a migrated store — the schema changes are additive, so the forward version gate never fires — and that older forge will keep reading the frozen `backlog/*.md`.
- `reidentify --confirm` is a **precondition**, not a follow-up: migrate is what first commits a `project_key`, which is what makes the identity refusal reachable at all.

Full operator runbook, including the agent-image step and rollback: `docs/how-to-backlog-db-cutover.md`.

## Reading tickets inside an agent container

When the dispatching project has cut over to `db`, a containerized agent gets a **read-only, project-scoped, backlog-only** ticket surface, and `forge backlog list` / `forge backlog show <id>` resolve that — not the mounted checkout's `backlog/*.md`, which for a migrated project is frozen. A task dispatched from a project still in `markdown` mode gets no snapshot and reads the checkout's files exactly as it always has.

- **It is live, not a dispatch-time copy.** A host-side ticket edit made *after* the container started is visible to that container's next `forge backlog show`. The host publishes a fresh snapshot into the container's read-only mount on every authoritative ticket write.
- **What is mounted is a snapshot database containing only this project's tickets, relations, and blocker evidence.** The host `~/.forge/forge.db` is never mounted, so another project's tickets and forge's run/task/event tables are not merely filtered — they are not present.
- **Every mutating verb refuses** against a mounted snapshot — `file`, `edit`, `close`, `retitle`, `move`. The mount is read-only at the kernel level, so that holds even though agents have root in their own container. Report the ticket change you want in your result; ticket mutations happen on the host.
- **The store verbs refuse in *any* container** — `import`, `mode`, `migrate`, `reidentify`, `forget-source`. They write the host store or the project registry, and no container may reach either.
- **`show` reports revision drift.** If the ticket advanced since the task was dispatched, the output names both the dispatched and current revisions rather than pretending the task package changed.
- **A refusal means the dispatch, not the project.** "No ticket authority was mounted for this task" means the container was started without a snapshot — forge deliberately does not fall back to `$HOME/.forge` there, because inside a container that path is a shared named volume belonging to no project. Ask the operator to re-dispatch.

## When to use it

Prefer `forge backlog` over directly reading/writing files under `backlog/` — it enforces ticket ID allocation, serializes creation against concurrent writers, and applies consistent status/type semantics. It is also the only interface that stays correct across both storage modes; a direct file read is wrong the moment a project moves to `db`. Reach for `forge campaign` (see the `forge-campaign` skill) when you need to actually execute a ticket's implementation, not just inspect or file it.

## Discipline

- **Reopen vs. follow-up.** Reopen a ticket to finish its own unmet acceptance criteria (`forge backlog move <id> story` — the move clears the `closed:`/`closed_commit:` frontmatter itself, so there is nothing to hand-strip). File a follow-up ticket only for genuinely *new* scope discovered later — never for the original ticket's own unmet AC.
- **Never close-and-defer.** Do not close a ticket by pushing its own unmet AC into a vague follow-up — that launders incomplete work past the gate. An AC line with no evidence is not met; the ticket stays open until it is.
- **Persist closeout evidence.** Before closing a newly completed ticket, add or update its `## Acceptance Evidence` section with a Markdown grid containing exactly one row per AC and the columns `AC`, `Evidence`, and `Verdict`; preserve the original AC text. Do this after merge so the evidence can cite the shipped commit. This requirement is prospective — do not reopen historical tickets only to backfill it.
- **Real scope change → a named ticket.** If work genuinely changes scope mid-flight, move the affected AC into an explicit ticket (`forge backlog file` / `move`) rather than dropping or hand-waving it.
- **Preserve unrelated changes.** `edit` replaces a ticket's body wholesale — use it (and any other step) only on the ticket's own scope; never revert or clobber user/agent edits outside that ticket's scope.

This is a summary, not a fork: the source of truth is CLAUDE.md's "Before closing a backlog ticket" section. If the two ever disagree, CLAUDE.md wins.

---
name: forge-backlog
description: Read and manage structured backlog tickets (list, show, file, close, edit, retitle, move, notes, config, mode) via `forge backlog`. Use this as the bounded interface for ticket work instead of hand-editing files under backlog/.
---

# forge-backlog

`forge backlog` is the CLI over a project's structured backlog of idea/epic/story tickets. Source of truth for exact flags: `forge backlog --help` and `forge backlog <subcommand> --help`.

Each project has one **authoritative** ticket store, its *storage mode*: `markdown` (the default — one file per ticket under `backlog/`) or `db` (rows in the host `forge.db`, opt-in per project). Every verb below behaves the same in either mode; only where the bytes land differs. See **Storage mode** below.

## Non-goal

Host/orchestrator skill only. It documents a CLI command run from the terminal. Containerized agents do not discover or read `.claude/skills`.

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
forge backlog mode  [--set markdown|db] [--allow-orphaned-tickets] [--json]
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
- `import` copies the project's `backlog/*.md` into DB ticket rows. While the project is in `markdown` mode those rows are a **non-authoritative** shadow — Markdown stays the source of truth and nothing reads them for behavior. Import is also the required precursor to `mode --set db`: it seeds the `(project_key, prefix)` id sequence past the ids the project already uses. It is idempotent-additive (re-running upserts — inserts/updates — rather than duplicating; tickets or relations removed from Markdown are **not** pruned, so removal reconciliation is still owed), and on first run it records a durable `project_key` in `.forge/config.yml` so the DB backlog stays single across a project's clones and linked worktrees. It does not require a `backlog/` directory — importing an empty project is how a fresh one claims its `project_key`. If two configs/worktrees present conflicting project identities for one project it **refuses** (exit code 1, structured object under `--json`) rather than splitting the backlog.
- `mode` shows or sets which store is authoritative — see **Storage mode** below.

All subcommands accept `--project <dir>` (default: cwd) to target a backlog outside the current directory.

## Storage mode

A project's mode lives in the host DB keyed by `project_key`, **not** in each worktree's `.forge/config.yml` — so two linked worktrees of one project can never disagree about which store owns the tickets. The mode is authoritative: the CLI reads `db` **or** Markdown, never both, and never silently falls back from one to the other.

```
forge backlog mode                  # report: mode + project_key (--json adds staleMarkdown)
forge backlog mode --set db         # opt this project into the DB store
forge backlog mode --set markdown   # back to files (refuses if it would strand tickets)
```

- **`markdown` is the default and nothing changes until you opt in.** A project that has never run `mode --set db` behaves exactly as it always has.
- **Every verb that touches the store prints which one it read**, as a one-line banner on **stderr** — `store: legacy markdown`, or `store: db (project_key=…)`, with ` — backlog/ present but NOT authoritative` appended when a stale `backlog/` directory is still on disk. It is on stderr precisely so `--json` stdout stays machine-clean. Four verbs skip it: `config` and `notes` never touch the ticket seam, and `import` and `mode` are the identity *repair* paths — their own refusals are the output that matters, and a banner resolving first would preempt them with a less precise error.
- **In `db` mode a project needs no `backlog/` directory at all.** Full CRUD works without one, `file` reports just `Created <id>: <title>` (there is no path to name), and `close`/`move`/`retitle` write rows rather than moving files — so filing, editing, and closing tickets leave `git status` clean.
- **Both flips refuse rather than lose tickets.** `--set db` refuses if `import` has not seeded the id sequence (allocation would re-mint ids that exist only as Markdown), and refuses from a checkout with no `backlog/` when the project demonstrably has tickets, since that checkout cannot verify the ids it would allocate above. `--set markdown` refuses when DB tickets have no Markdown file — in markdown mode nothing would read them; pass `--allow-orphaned-tickets` to flip anyway and it warns with the ids it stranded (first ten, then a count). Any id sequence a flip advances is reported on stderr, never moved silently.
- **Cutover is effectively one-way.** There is no Markdown export, so once a `db`-mode project takes a DB-only edit its `backlog/*.md` is a frozen snapshot. Clean rollback exists only before that first edit.
- **Containerized agents do not see a `db`-mode backlog.** Agents get `/project` mounted read-only with no `forge.db`, so anything reading `backlog/*.md` inside a container sees only what Markdown still holds. Pass ticket content through the task brief, and treat this as a precondition on migrating a project that runs agent workflows.

## When to use it

Prefer `forge backlog` over directly reading/writing files under `backlog/` — it enforces ticket ID allocation, serializes creation against concurrent writers, and applies consistent status/type semantics. It is also the only interface that stays correct across both storage modes; a direct file read is wrong the moment a project moves to `db`. Reach for `forge campaign` (see the `forge-campaign` skill) when you need to actually execute a ticket's implementation, not just inspect or file it.

## Discipline

- **Reopen vs. follow-up.** Reopen a ticket to finish its own unmet acceptance criteria (`forge backlog move <id> story` — the move clears the `closed:`/`closed_commit:` frontmatter itself, so there is nothing to hand-strip). File a follow-up ticket only for genuinely *new* scope discovered later — never for the original ticket's own unmet AC.
- **Never close-and-defer.** Do not close a ticket by pushing its own unmet AC into a vague follow-up — that launders incomplete work past the gate. An AC line with no evidence is not met; the ticket stays open until it is.
- **Persist closeout evidence.** Before closing a newly completed ticket, add or update its `## Acceptance Evidence` section with a Markdown grid containing exactly one row per AC and the columns `AC`, `Evidence`, and `Verdict`; preserve the original AC text. Do this after merge so the evidence can cite the shipped commit. This requirement is prospective — do not reopen historical tickets only to backfill it.
- **Real scope change → a named ticket.** If work genuinely changes scope mid-flight, move the affected AC into an explicit ticket (`forge backlog file` / `move`) rather than dropping or hand-waving it.
- **Preserve unrelated changes.** `edit` replaces a ticket's body wholesale — use it (and any other step) only on the ticket's own scope; never revert or clobber user/agent edits outside that ticket's scope.

This is a summary, not a fork: the source of truth is CLAUDE.md's "Before closing a backlog ticket" section. If the two ever disagree, CLAUDE.md wins.

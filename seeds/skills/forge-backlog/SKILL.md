---
name: forge-backlog
description: Read and manage structured backlog/ tickets (list, show, file, close, edit, retitle, move, notes, config) via `forge backlog`. Use this as the bounded interface for ticket work instead of hand-editing files under backlog/.
---

# forge-backlog

`forge backlog` is the CLI over the project's structured `backlog/` directory (idea/epic/story tickets, one file per ticket). Source of truth for exact flags: `forge backlog --help` and `forge backlog <subcommand> --help`.

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
forge backlog config [--show]
forge backlog notes show
forge backlog notes add     [text|-]
forge backlog notes replace [text|-]
```

- `list`/`show` are read-only; use `--json` for machine-readable output when scripting or piping into another step.
- `file` creates a new ticket; `--body -` reads the body from stdin (useful for multi-line bodies piped in).
- `close` marks a ticket done and records the close date; `--commit <sha>` attaches the shipping commit.
- `edit` replaces a ticket's body wholesale — it is not a patch/append operation.
- `retitle` changes a ticket's title (frontmatter + heading) in place without moving or renaming its file.
- `move` relocates a ticket between the idea/epic/story type directories.
- `notes` reads/writes the project's `backlog/notes.md` "notes for next session" block — `add` appends a paragraph, `replace` overwrites the whole file.

All subcommands accept `--project <dir>` (default: cwd) to target a backlog outside the current directory.

## When to use it

Prefer `forge backlog` over directly reading/writing files under `backlog/` — it enforces ticket ID allocation, locking on creation, and consistent status/type semantics. Reach for `forge campaign` (see the `forge-campaign` skill) when you need to actually execute a ticket's implementation, not just inspect or file it.

## Discipline

- **Reopen vs. follow-up.** Reopen a ticket to finish its own unmet acceptance criteria (`forge backlog move <id> story`, then strip the stale `closed:`/`closed_commit:` frontmatter the move leaves behind). File a follow-up ticket only for genuinely *new* scope discovered later — never for the original ticket's own unmet AC.
- **Never close-and-defer.** Do not close a ticket by pushing its own unmet AC into a vague follow-up — that launders incomplete work past the gate. An AC line with no evidence is not met; the ticket stays open until it is.
- **Persist closeout evidence.** Before closing a newly completed ticket, add or update its `## Acceptance Evidence` section with a Markdown grid containing exactly one row per AC and the columns `AC`, `Evidence`, and `Verdict`; preserve the original AC text. Do this after merge so the evidence can cite the shipped commit. This requirement is prospective — do not reopen historical tickets only to backfill it.
- **Real scope change → a named ticket.** If work genuinely changes scope mid-flight, move the affected AC into an explicit ticket (`forge backlog file` / `move`) rather than dropping or hand-waving it.
- **Preserve unrelated changes.** `edit` replaces a ticket's body wholesale — use it (and any other step) only on the ticket's own scope; never revert or clobber user/agent edits outside that ticket's scope.

This is a summary, not a fork: the source of truth is CLAUDE.md's "Before closing a backlog ticket" section. If the two ever disagree, CLAUDE.md wins.

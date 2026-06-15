# headroom learn integration

`forge learn` mines failed agent runs using [headroom](https://headroom.ai)'s `learn` command to identify recurring failure patterns and propose improvements to agent seeds (CLAUDE.md files).

## When to use it

Run `forge learn` after a batch of agent failures to understand what's going wrong and get concrete seed corrections. Common scenarios:

- An agent role keeps failing with the same kind of error across multiple runs
- You've shipped several features and want to improve the seeds based on real failure evidence
- A new project integration is generating unexpected failures

## How it works

1. **Detect** — queries the forge SQLite store for failed tasks in the given time window
2. **Analyze** — runs `headroom learn --project <dir>` against each project directory associated with those failures
3. **Propose** — shows the corrections headroom identified (dry-run by default)
4. **Apply** — with `--apply`, writes corrections to the relevant CLAUDE.md / AGENTS.md files

The analysis uses Claude Code's conversation transcripts stored by headroom. It looks for patterns like wrong file paths, missing modules, or stubborn retry loops that indicate gaps in the agent's seed context.

## Usage

```bash
# Dry-run: show what headroom would write (no changes)
forge learn

# Scope to a specific agent role
forge learn --agent-role engineer

# Scope to recent failures only (last 7 days)
forge learn --since 7

# Write the corrections
forge learn --apply

# Use a specific LLM for the analysis
forge learn --model claude-sonnet-4-6

# Analyze a specific project directory
forge learn --project /path/to/project
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--agent-role <role>` | all roles | Filter to a specific agent role |
| `--project <dir>` | cwd | Project directory (fallback if run metadata lacks one) |
| `--since <days>` | 30 | Look back N days for failed runs |
| `--limit <n>` | 50 | Max failed tasks to consider |
| `--apply` | dry-run | Write corrections to seed files |
| `--model <model>` | auto-detect | LLM for headroom's analysis |
| `--json` | human output | Emit structured JSON |

## Safety

- **Read-only by default.** Without `--apply`, no files are modified. Headroom prints what it would write.
- **Review before applying.** Read the proposed corrections and confirm they make sense before running with `--apply`. Headroom can misidentify patterns from a single session.
- **Project-scoped.** Corrections apply to the project's own CLAUDE.md (in `.claude/` or the project root) — not to the installed forge seeds at `~/.forge/agents/`.

## Relationship to forge seeds

Headroom learns from conversation history and writes to the coding agent's memory files. For Claude Code sessions, that's typically `.claude/CLAUDE.md` in the project root. This is distinct from the forge agent seeds at `~/.forge/agents/<role>/CLAUDE.md`, which govern how forge's container agents behave.

If a failure pattern reflects a gap in the forge agent seed itself (e.g. the engineer agent repeatedly misses a project convention), file a backlog ticket rather than relying on `forge learn` alone — the correction should go into `seeds/agents/<role>/CLAUDE.md` and be reviewed like any other seed change.

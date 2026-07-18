# prompt-author templates

Each `.md` file here is a parameterized PROMPT.md that the `prompt-author` agent fills in from interview answers.

## Substitution scheme

Variables are `{{name}}`. The agent does literal string replacement; don't put curly braces in the templates that aren't meant to be substituted.

## Standard variables (across templates)

- `{{brief}}` — the human's brief paragraph
- `{{constraints_section}}` — extra constraints, formatted as a paragraph or "## Constraints" section. Empty string if none.

## ui-design.md variables

- `{{target_pen_file}}` — absolute path to the .pen file (e.g. `/Users/steven.bargelt/code/forge-design/dashboard.pen`)
- `{{target_pen_basename}}` — just the filename (e.g. `dashboard.pen`)
- `{{output_dir}}` — absolute path where PNGs go (e.g. `/Users/steven.bargelt/code/forge-design/designs`)
- `{{output_dir_parent}}` — the parent dir of the .pen file, used for `mkdir -p` (e.g. `/Users/steven.bargelt/code/forge-design`)
- `{{file_naming_list}}` — multi-line bulleted list of PNG names in order, indented 3 spaces:
  ```
     - 01-run-list.png
     - 02-task-list.png
     - 03-task-detail-generic.png
     ...
  ```

## Adding a template

1. Drop a new `.md` here.
2. Add the parameter list to this README.
3. Update `seeds/agents/prompt-author/CLAUDE.md` to mention the new template + when to use it.
4. Add a workflow that uses it (or extend an existing workflow's input schema with `template: "<name>"`).

## Versioning

Templates are checked-in alongside the agent seed; they install to `~/.forge/agents/prompt-author/templates/` via the standard `install-seeds.sh`. These live under `agents/`, which is operator-authored and **create-only** — installed when absent, **retained** when present, even under `FORCE=1` (FG-578). So `FORCE=1 ./scripts/install-seeds.sh` will **not** push a template edit over an already-installed copy; reinstalling over it is a no-op. To re-test a template change, remove its `~/.forge/agents/prompt-author/templates/…` copy first so the installer recreates it, or copy the file in by hand.

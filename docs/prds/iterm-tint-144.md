# SPEC — iTerm2 auto-tint on cd (#144)

**Status:** draft, awaiting confirmation
**Backlog linkage:** closes #144. Composes with #143 (dashboard chip color) — same `.vscode/settings.json` source, different rendering target.

## Objective

Tint the iTerm2 background to the project's identity color whenever the user `cd`s into a project. Combined with the VS Code titlebar (already that color via the user's manual `.vscode/settings.json`) and the dashboard chips (just shipped in #143), this completes the three-surface visual identity: editor + terminal + dashboard all light up the same color for "this is project X."

After this spec lands:

- A small zsh function in `scripts/forge-tint.zsh`. User sources it from `~/.zshrc` (one line).
- A `chpwd` hook fires on every directory change.
- The function reads `$PWD/.vscode/settings.json` for `workbench.colorCustomizations.titleBar.activeBackground`. If found, sends the iTerm2 `SetColors` escape with that hex. If not found, sends the XTerm `OSC 111` reset to return to the iTerm profile's default background.
- No forge Node code involved. Pure shell. No `forge` CLI subcommand.

## Out of scope (deferred)

- **Portability to other terminals** (Ghostty, kitty, Alacritty, plain Terminal.app). iTerm2 escape codes are proprietary; the OSC 111 reset is XTerm-standard so it MIGHT work elsewhere but we don't promise it. If you switch terminals or want broader support, that's a separate ticket.
- **A `forge tint` Node subcommand.** Would add ~50ms Node startup latency on every cd. Shell-only stays fast and forge-independent.
- **Sharing color-resolution code with the dashboard's `project-meta.ts`.** Shell can't import TypeScript. Both implementations independently parse `.vscode/settings.json`; the source-of-truth is the file, not the code. If `.vscode/settings.json` ever moves or its key changes, both need updating — but that's a once-in-forever migration.
- **Caching.** Reading `.vscode/settings.json` on every cd is cheap (it's a tiny file in the filesystem cache). No need.
- **Hash-color fallback** (the FNV-1a hash used by the dashboard chip when no .vscode color exists). For terminal tinting, "no project color → reset to default" is the right behavior — undefined projects shouldn't get arbitrary colors that confuse the user. The dashboard chip uses hash because it MUST show something distinctive; the terminal doesn't.
- **Per-window vs per-tab semantics.** iTerm2 `SetColors` is per-tab; that's fine. New tabs start at the profile default and tint when you cd.

## Commands (no CLI changes)

No new forge CLI surface. The deliverable is a sourced shell function:

```bash
# In ~/.zshrc
source ~/code/forge/scripts/forge-tint.zsh
```

After sourcing, `cd` anywhere triggers the tint automatically. Manual invocation also works: `forge_tint` (the function name) reads `$PWD` and emits the right escape.

## Project structure (files touched)

### Shell script

- `scripts/forge-tint.zsh` — NEW. ~20 lines:
  - `forge_tint()` function: reads `$PWD/.vscode/settings.json`, extracts `titleBar.activeBackground`, emits the iTerm2 tint OR the OSC 111 reset.
  - Uses pure POSIX shell + grep/sed for parsing — no `jq` dependency (forge users shouldn't be forced to install jq).
  - Strips a leading `#` from the hex color before passing to the escape (iTerm2 wants `RRGGBB`, .vscode wants `#RRGGBB`).
  - `chpwd_functions+=(forge_tint)` to wire into zsh's chpwd hook.
  - Idempotent: re-sourcing the file doesn't double-register the hook.
  - Guarded: if `$TERM_PROGRAM` isn't `iTerm.app`, the function no-ops silently (so users in another terminal don't get weird escape sequences printed).
  - Final line: also tint for the CURRENT directory at source time, so opening a new terminal in a project immediately tints (not just after the next cd).

### Docs

- `docs/how-to-iterm-tint.md` — NEW. One page:
  - **What it does** — one paragraph.
  - **Install** — `source ~/code/forge/scripts/forge-tint.zsh` in `.zshrc`, reload shell, done.
  - **How it works** — reads `.vscode/settings.json`, emits the iTerm2 SetColors escape; uses OSC 111 reset when no `.vscode` color exists.
  - **Picking a color for your project** — point to VS Code's command palette → "Workspaces: Configure Workspace Color." Editing the same file is the source of truth.
  - **Disabling** — comment out the `source` line in `.zshrc`, reload shell.
  - **Why iTerm2 only** — explain the proprietary escape, note that the OSC 111 reset is XTerm-standard but the SetColors tint is not.
  - **Troubleshooting** — color doesn't change (terminal isn't iTerm2 — check `$TERM_PROGRAM`); color persists in wrong directory (chpwd hook not loaded — re-source).

- `README.md` — one-line addition to the Docs section.

### Backlog hygiene

- Close #144 with the commit sha.

## Code style

- Pure zsh + POSIX shell utilities (grep, sed, printf). No `jq`, no Python, no Node.
- Function name `forge_tint` — namespaced. Hook registration uses zsh's idiomatic `chpwd_functions+=(...)`.
- Comments at the top of the file explaining the iTerm-only guard and the .vscode parsing approach.
- File mode: 644, not executable — it's meant to be `source`d, not run.

## Testing strategy

Baseline: 285/285 forge tests pass on `main` at `cda29a4`. No new automated tests for this work — it's a shell script with side effects on the terminal; testing automatically would require capturing escape sequences and asserting on them, which is more effort than the script.

### Manual verification (the spec is not done without these)

After landing:

1. `source ~/code/forge/scripts/forge-tint.zsh` in a fresh iTerm2 tab.
2. `cd ~/code/forge` — terminal bg should turn the forge `#6633CC` purple.
3. `cd ~` — terminal bg should reset to your iTerm profile default.
4. `cd /tmp` — same (no `.vscode/settings.json`; reset).
5. `cd ~/code/forge/dashboard` — tint to purple (inherits from parent's `.vscode`? — actually no, the function reads `$PWD/.vscode/settings.json` only, so a project subdirectory without its own `.vscode` would reset. Acceptable behavior, or worth a "walk up" tweak? See open question below.)
6. Open a new iTerm tab, no cd: terminal should tint immediately (the source-time call).
7. Open a non-iTerm terminal (e.g. plain Terminal.app), source the file: should print nothing weird (the `$TERM_PROGRAM` guard kicks in).

### Regression check
- `npm run typecheck` clean (no TS changes).
- `npm test` — 285/285 still pass.

## Boundaries

### Always do
- Read `.vscode/settings.json` from `$PWD` only (don't walk up the directory tree — keeps behavior predictable; if you want subdirs to inherit, see open question).
- Guard with `$TERM_PROGRAM` so the script no-ops in non-iTerm terminals.
- Reset on cd to a directory without a `.vscode` color (OSC 111).
- Strip leading `#` from the hex before sending.

### Ask first about
- Walking up the directory tree to find a `.vscode` (e.g. `~/code/forge/dashboard` should inherit forge's color? See open question below).
- Adding a `forge tint` CLI subcommand. Out of scope this spec.
- Supporting other terminals. Out of scope; separate ticket if needed.
- Caching the parse to avoid disk reads. Premature.

### Never do
- Use `jq` (don't force a dep on forge users).
- Run any Node code from the chpwd hook (cd latency must stay ~0ms).
- Tint outside of iTerm2 (escape sequences printed to non-supporting terminals show as literal text).
- Modify the user's `.zshrc` directly. They source the file themselves.

## Open question (single one, decide before implementing)

**Should the function walk up the directory tree to find a `.vscode/settings.json`?**

- **Yes (walk up):** `cd ~/code/forge/dashboard` inherits forge's color. Matches VS Code's behavior (workspace settings cover subdirs). Slightly more code (~5 LoC for the walk-up loop). Behaves correctly when working in nested subdirs.
- **No (current-dir only):** Simpler. Predictable. Matches what's specified above. Subdirs reset to profile default unless they have their own `.vscode/settings.json`.

My recommendation: **walk up** — matches VS Code's behavior and matches user intuition ("I'm in the forge project, why isn't the terminal purple?"). Costs maybe 5 extra LoC.

## Implementation order

1. **Write `scripts/forge-tint.zsh`** with the chpwd hook + guard + walk-up. Manually test in a fresh iTerm tab.
2. **Test all 7 manual verification cases** (cd to project, cd home, cd to a non-vscode dir, cd to a subdir, new tab, non-iTerm).
3. **Write `docs/how-to-iterm-tint.md`** with install + how it works + troubleshooting.
4. **One-line pointer in README** Docs section.
5. **Commit + close #144 + push.**

Each step is independently testable. If any of the verification cases produce unexpected behavior (e.g. iTerm2 ignores the OSC 111 in your specific config), pause and either tweak the escape or document the caveat.

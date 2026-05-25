# Auto-tinting iTerm2 background to match the current project

Forge ships a small zsh helper that tints your iTerm2 window background to the project's identity color on every `cd`. Combined with VS Code's titlebar color (set in `.vscode/settings.json`) and the dashboard's project chips (#143), this gives you one consistent visual cue for "this is project X" across editor + terminal + dashboard.

iTerm2 only. Other terminals silently no-op (the script guards on `$TERM_PROGRAM`).

## Install

Add one line to `~/.zshrc`:

```bash
source ~/code/forge/scripts/forge-tint.zsh
```

(Adjust the path if your forge checkout lives elsewhere.)

Reload your shell (`source ~/.zshrc` or open a new tab). From now on, every `cd` tints the background.

## How it works

On every `cd`:

1. Walk up from `$PWD` looking for a `.vscode/settings.json` containing `workbench.colorCustomizations["titleBar.activeBackground"]`. First match wins.
2. If found: emit iTerm2's `SetColors` escape (`\033]1337;SetColors=bg=RRGGBB\007`) to change the tab background to that color.
3. If no `.vscode` color is found at any ancestor: emit XTerm's `OSC 111` reset (`\033]111\007`) so the tab returns to your iTerm profile's default.

Walk-up matters: `cd ~/code/forge/dashboard` finds forge's `.vscode/settings.json` at the workspace root and tints to forge's color, even though the `dashboard/` subdir doesn't have its own `.vscode`. Same behavior VS Code itself uses.

The script also tints once at source-time, so opening a new iTerm tab inside a project immediately picks up the right color (not just after the next `cd`).

## Picking a color for your project

Forge doesn't pick the color — VS Code does, and forge follows whatever you set there. From VS Code:

1. Open your project.
2. Command Palette → `Workspaces: Configure Workspace Color`.
3. Pick a color. VS Code writes it to `.vscode/settings.json` under `workbench.colorCustomizations.titleBar.activeBackground`.

The dashboard chip and the iTerm tint both read the same file. Change the color once, all three surfaces update on the next session.

If you'd rather edit by hand:

```json
// .vscode/settings.json
{
  "workbench.colorCustomizations": {
    "titleBar.activeBackground": "#6633CC"
  }
}
```

## Disabling

Comment out the `source` line in `~/.zshrc` and reload the shell. The chpwd hook unregisters when you open a new session.

To temporarily reset the current tab's background without disabling the hook:

```bash
printf '\033]111\007'
```

The next `cd` will re-tint.

## Why iTerm2 only

The tint uses iTerm2's proprietary `1337;SetColors` escape. Other terminals (Ghostty, kitty, Alacritty, Terminal.app) either ignore it (printed as literal garbage) or use entirely different escape codes. The script's `$TERM_PROGRAM == "iTerm.app"` guard means it silently no-ops in other terminals — safe to keep sourced even if you sometimes use a different terminal.

If you switch terminals long-term and want similar tinting there, that's a separate project — the parsing logic in `scripts/forge-tint.zsh` is reusable; only the escape emission would change.

## Troubleshooting

### Nothing happens when I cd

- **Terminal isn't iTerm2.** Check `echo $TERM_PROGRAM` — should print `iTerm.app`. If it prints anything else, you're in a different terminal and the script no-ops by design.
- **Source line not in `.zshrc`** or shell wasn't reloaded. Verify with `which forge_tint` — should print "forge_tint is a shell function".
- **No `.vscode/settings.json` anywhere in the ancestor chain.** Expected behavior: the tab resets to your iTerm profile default. If your default IS already your terminal's color, you won't see any visible change.

### The color in `.vscode/settings.json` isn't being picked up

- **JSON formatting.** The script parses with grep+sed, not a full JSON parser. It expects `"titleBar.activeBackground": "#XXXXXX"` on its own line, with reasonable whitespace. Multi-line JSON values would confuse it.
- **Line-commented (`//`) value with another commented-above.** The script skips lines that start with `//` after optional whitespace. But comments on the SAME line as the value (e.g. `"titleBar.activeBackground": "#6633CC" // forge purple`) are fine.
- **Bad color value.** Must be a hex string (with or without leading `#`). CSS color names and HSL aren't supported.

### My background stays the wrong color after cd

- **You ran the iTerm SetColors manually** (e.g. for a test) and the chpwd hook hasn't fired yet — your most recent `cd` would have reset/retinted. Try `cd .` to force a re-tint.
- **Subshell.** If you're inside a `zsh -c '...'` subshell, the chpwd hook from the parent shell doesn't run there.

### Background reverts to wrong color in new tabs

iTerm2 launches new tabs with the profile default background. The script's source-time tint runs once when `.zshrc` is loaded — if you've configured iTerm2 to NOT run `.zshrc` for new tabs (rare), the first-tint won't happen. Check iTerm2 Preferences → Profiles → General → Command and make sure it's `Login Shell` or your default shell, not a custom command that bypasses `.zshrc`.

## Related

- **Dashboard project chip (#143)** — uses the same `.vscode/settings.json` color source. See `docs/concepts.md` "Fanout" entry and the dashboard codebase.
- **VS Code workspace colors** — Microsoft's reference: https://code.visualstudio.com/docs/getstarted/themes#_customize-a-color-theme

---
id: FG-144
type: story
status: done
title: Auto-tint iTerm2 background to match forge project on cd / forge invocation (research)
---

**Closed:** 2026-05-25. Commit `029a8d357709fba1d2d85d6ec8ffd6bd815a2804`.

Filed 2026-05-25 as a research ticket.

**Idea.** Compose with the dashboard-color ticket (#143 — per-project label + color, sourced from .vscode/settings.json titleBar.activeBackground when present). Same idea, extended to the terminal: when you cd into a project (or run forge there), iTerm2's window background subtly tints to that project's color. Combined with the VS Code titlebar already being that color and the dashboard cards being that color, you get one consistent visual cue for "which project am I in right now?" across editor / terminal / dashboard.

**Research questions:**
1. Does iTerm2 support runtime background color changes via the command line? Likely yes via proprietary escape codes (`\033]1337;SetColors=bg=...\007`) or the iTerm2 Python API. Confirm exact syntax + edge cases (does it persist? per-tab vs per-window? does it survive a new tab? does Ghostty / kitty / other terminals expose anything equivalent for portability?).
2. What's the right trigger? Options:
   - **chpwd hook in zsh** — fires on every cd. Wire a function that reads `<cwd>/.vscode/settings.json` and tints accordingly. Most natural; zero forge involvement.
   - **forge CLI tint-on-invoke** — forge runs a `tintTerminal()` call at startup based on cwd's color. Tighter integration but only fires when forge runs (so terminal stays untinted between commands).
   - **Separate shell helper** — `forge-tint` or similar binary that the user wires into their shell config however they want.
3. How to handle "no color in .vscode/settings.json"? Don't tint? Use a hash-based default like the dashboard does? Reset to the iTerm2 profile default?
4. Subtle vs. obvious? A 5% saturation tint might be readable without being distracting; a 30% tint might be obnoxious. Test in practice.

**Sized as:** small to medium for research; the implementation is small either way (escape codes are stable).

**Composite with #143** (dashboard project color). Same color source, same lookup, same caching opportunity — if both land, factor out a `getProjectColor(projectDir)` helper they share. If just one lands, it's still useful standalone.

**Out of scope until research:** anything beyond iTerm2. Other terminals (Ghostty, kitty, Alacritty, plain Terminal.app) have varying levels of support. Don't try to be portable until iTerm2 is proven.

**Caught:** 2026-05-25 in conversation about dashboard project colors.
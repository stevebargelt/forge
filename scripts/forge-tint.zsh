# forge-tint.zsh — auto-tints iTerm2 background to match the project's
# .vscode color on every cd. Source from ~/.zshrc:
#
#   source ~/code/forge/scripts/forge-tint.zsh
#
# Pure zsh + grep/sed — no jq or Node dependency. Silent no-op outside
# iTerm2. See docs/how-to-iterm-tint.md for setup + troubleshooting.
#
# How it works:
# 1. On every cd, walk up from $PWD looking for a .vscode/settings.json that
#    declares workbench.colorCustomizations."titleBar.activeBackground".
# 2. If found: tint via iTerm2's SetColors escape.
# 3. If not found at any ancestor: reset to the iTerm profile default via
#    XTerm OSC 111. (Confirmed working in iTerm2 2026-05-25.)

# Resolve the project color for the given dir (defaults to $PWD). Walks up
# the directory tree to /. First .vscode/settings.json with a
# titleBar.activeBackground wins. Echoes the hex (no leading #) on success.
_forge_tint_color_for() {
  local dir="${1:-$PWD}"
  while [[ -n "$dir" ]]; do
    local f="$dir/.vscode/settings.json"
    if [[ -f "$f" ]]; then
      # Skip lines that are line-comments (//...) — VS Code's settings.json
      # is jsonc, and users sometimes leave a commented-out color above the
      # active one. Then extract titleBar.activeBackground's value and strip
      # any leading '#' — iTerm wants bare RRGGBB.
      local color
      color=$(grep -vE '^[[:space:]]*//' "$f" 2>/dev/null \
        | grep -E '"titleBar\.activeBackground"' \
        | sed -E 's/.*"titleBar\.activeBackground"[[:space:]]*:[[:space:]]*"#?([0-9A-Fa-f]+)".*/\1/' \
        | head -n 1)
      if [[ -n "$color" && "$color" != *' '* ]]; then
        echo "$color"
        return 0
      fi
    fi
    [[ "$dir" == "/" ]] && break
    dir="${dir:h}"  # zsh dirname
  done
  return 1
}

forge_tint() {
  # iTerm-only. Other terminals would print escape sequences as literal
  # garbage. $TERM_PROGRAM is set by iTerm2 itself; reliable.
  [[ "$TERM_PROGRAM" == "iTerm.app" ]] || return 0
  local color
  if color=$(_forge_tint_color_for); then
    printf '\033]1337;SetColors=bg=%s\007' "$color"
  else
    printf '\033]111\007'
  fi
}

# Register the chpwd hook idempotently. Deregister first so re-sourcing
# the file (e.g. after a forge upgrade) doesn't double-wire.
autoload -Uz add-zsh-hook
add-zsh-hook -d chpwd forge_tint 2>/dev/null
add-zsh-hook chpwd forge_tint

# Tint immediately for the current directory — covers "open a new iTerm tab
# inside a project," which otherwise wouldn't tint until you cd somewhere.
forge_tint

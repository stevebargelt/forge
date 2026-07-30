#!/usr/bin/env bash
# commit-scratch-tree — make a COPIED working tree a clean release candidate.
#
# FG-645 (mechanism half). forge refuses to build a release from a dirty tree
# (FG-569 GAP 2). Harnesses that copy the operator's working tree somewhere else and
# then build a release in it therefore inherit the operator's dirtiness, which made
# them unusable from any checkout with work in progress — and both ways out were
# worthless: skip the release suites (validates nothing) or build HEAD (validates the
# wrong bytes). So the COPY gets its own throwaway git repo and the copied bytes are
# committed into it. The tree the release builder sees is clean, and its HEAD
# describes exactly the source the operator just wrote.
#
# THE REPO MUST BE ONE THIS SCRIPT CREATED. A copied `.git` is not a repo you may
# commit through: on a linked worktree it is a `gitdir:` POINTER into the operator's
# real admin directory, so committing through it would write into the operator's
# repository — the FG-575 defect. The marker file distinguishes "a repo I made" from
# "something that was copied in"; anything without it is REPLACED, not committed into.
#
# Unlike forge-test's inline version this one is FATAL on failure. Its only caller
# builds a real release immediately afterwards, so a tree left dirty here would
# surface as a confusing refusal in a test rather than as the environment fault it is.
#
# Usage: commit-scratch-tree.sh <dir> [--branch <name>]

set -euo pipefail

DIR="${1:-}"
shift || true
BRANCH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) BRANCH="${2:-}"; shift 2 ;;
    *) echo "commit-scratch-tree: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

if [[ -z "$DIR" || ! -d "$DIR" ]]; then
  echo "commit-scratch-tree: usage: commit-scratch-tree.sh <dir> [--branch <name>]" >&2
  exit 2
fi

if ! command -v git >/dev/null 2>&1; then
  echo "commit-scratch-tree: git is not installed — the copy cannot be made a clean release candidate" >&2
  exit 1
fi

SCRATCH_REPO_MARKER=".forge-scratch-repo"

_scratch_git() {
  git -C "$DIR" -c user.email=forge-scratch@local -c user.name=forge-scratch "$@"
}

if [[ ! -f "$DIR/.git/$SCRATCH_REPO_MARKER" ]]; then
  rm -rf "$DIR/.git"
  git -C "$DIR" init -q
  [[ -n "$BRANCH" && "$BRANCH" != "HEAD" ]] || BRANCH="main"
  git -C "$DIR" symbolic-ref HEAD "refs/heads/$BRANCH"
  # node_modules is install OUTPUT, bound to the lockfile separately — never part of
  # a commit's source identity, and by far the biggest thing in the tree.
  printf 'node_modules/\n' > "$DIR/.git/info/exclude"
  : > "$DIR/.git/$SCRATCH_REPO_MARKER"
fi

_scratch_git add -A
if git -C "$DIR" diff --cached --quiet 2>/dev/null; then
  echo "commit-scratch-tree: $DIR already describes the copied source" >&2
  exit 0
fi
_scratch_git commit -q -m "forge: scratch sync"
echo "commit-scratch-tree: committed $DIR into its own git — the release builder sees a CLEAN tree" >&2

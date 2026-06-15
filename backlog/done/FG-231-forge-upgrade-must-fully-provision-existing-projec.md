---
id: FG-231
type: story
status: done
title: forge upgrade must fully provision existing projects (commands+hooks unconditional, repair block) — init is new-project-only
---

**Closed:** 2026-06-01. Commit `2819fe6`.

Design intent (user, confirmed): `forge upgrade` is THE command for existing projects; `forge init` is for NEW projects only. Today upgrade violates this — its step 4 (project init) is gated on the orchestrator block marker, so a project missing/with-unbalanced markers gets ALL of step 4 skipped, including slash-command + hook installation. That left a freshly-`forge upgrade`d machine with no `/orient` command, and the only workaround was `forge init` — which is wrong (init appends a second fenced block on a malformed file -> duplicate).

Also note: `.claude/commands/` and `.claude/settings.local.json` are per-machine (gitignored), so even a git-synced project with a committed, well-fenced CLAUDE.md needs upgrade to (re)create the command symlinks + hooks on each new machine. Step 4 must do that.

Required behavior for `forge upgrade` on an existing project:
- ALWAYS install/refresh slash commands (orient.md, handoff.md symlinks) + Claude hooks + .gitignore entries — these are machine-local provisioning, independent of the CLAUDE.md block state. Never gate them on the block marker.
- Block handling: replace in place when fenced; REPAIR when unbalanced (lone end/start marker — folds in #230); APPEND when a `# forge orchestrator` heading exists but no markers; do nothing only when there's genuinely no block AND no heading. Never silently skip the whole step.
- `forge init` stays the new-project bootstrap (no CLAUDE.md / first run); it should also stop blindly appending when an unfenced block already exists (dedup with upgrade's repair path).

Acceptance: on a machine where a project's CLAUDE.md is committed+fenced but `.claude/` is fresh, a single `forge upgrade` from the project dir makes `/orient` available. A project with a dangling end-marker is repaired by upgrade, not skipped, and never duplicated.

Supersedes/絶includes #230 (unbalanced-marker detection is one case here).
---
id: FG-28
type: story
status: done
title: "Per-run constraint scoping (forge new --tag, tags: in constraint frontmatter)"
closed: 2026-06-21
---

**Why:** The `atlas-stack-rn` constraint fires on every `feature-ui-design-needed` run regardless of project. Today the workaround is renaming the constraint file to `.disabled`, which is global. Real fix is per-run scoping.
**How to apply:** Add `--tag <tag>` to `forge new`. Add `tags: [...]` to constraint frontmatter. Constraints fire only when the run's tag matches one of the constraint's tags (or the constraint has no tags = global, current behavior).
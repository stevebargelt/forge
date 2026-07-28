---
id: FG-379
type: story
status: done
title: "docs: document worktree-mode operator env vars (FORGE_WORKTREES / FORGE_NO_WORKTREES / FORGE_WORKTREE_IGNORE_DIRTY / FORGE_WORKTREES_EPHEMERAL) when worktree mode is production-ready"
created: 2026-06-23
closed: 2026-07-28
closed_commit: 3ce0385
---

**Precondition met 2026-07-28:** FG-345 flipped workspace isolation default-on, which is the
"production-ready" trigger this ticket was waiting on. Documented as part of that change.

## Acceptance Evidence

Shipped in `3ce0385` (PR #170).

| AC | Evidence | Verdict |
|---|---|---|
| Document `FORGE_WORKTREES` | `docs/concepts.md` — resolution order and its explicit-off spelling, which is what lets the test suite pin a host-independent value. | met |
| Document `FORGE_NO_WORKTREES` | `docs/concepts.md` + `docs/quick-start.md` — now the headline var: the supported escape back to legacy shared-checkout behavior, and the highest-precedence kill switch. Its precedence over an explicit `FORGE_WORKTREES=1` is proven at dispatch level by `fg345 (escape-2)`, not merely asserted in prose. | met |
| Document `FORGE_WORKTREE_IGNORE_DIRTY` | `docs/concepts.md` + the `quick-start.md` first-dispatch callout — the dirty-tree preflight bypass. Default-on means more operators meet that gate, so it is stated where a first dispatch will hit it. | met |
| Document `FORGE_WORKTREES_EPHEMERAL` | `docs/concepts.md` consolidated table — affects **cleanup only**: a workspace may be removed without proof of capture and its branch force-deleted. Explicitly marked never-on-a-run-whose-output-matters, since it is the one warrant that disposes of an unmerged workspace. | met |
| Precedence stated, not just the vars | The consolidated table gives the resolution order; `docs/quick-start.md` gives the operator-facing version. | met |

**Note:** `docs/how-to-use-forge-across-projects.md` additionally documents the self-host refusal
(`f50e383`) and states plainly that `FORGE_WORKTREES=1` is **not** a remedy for the invoke path — the
one place where reaching for these vars would actively mislead.

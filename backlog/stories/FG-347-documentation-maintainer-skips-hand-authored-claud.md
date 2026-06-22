---
id: FG-347
type: story
status: active
title: documentation-maintainer skips hand-authored CLAUDE.md regions (File layout etc.) — no owner for non-marker CLAUDE.md prose
created: 2026-06-22
---

**Found:** 2026-06-22, during the src/ layout doc reconciliation (run-reconcile-stale-src-layout-in-live-docs-d510d1).

**Symptom:** The documentation-maintainer agent was invoked twice with an explicit, line-numbered task to fix the stale "## File layout" ASCII tree in the repo-root `CLAUDE.md` (listing the dead `spine/` and `workflows/` dirs). Both times it returned `status: complete`, edited README + how-tos + the tech-lead seed + several ADRs, and silently left CLAUDE.md untouched (never appeared in `docs_updated`). The orchestrator fixed the tree via the documented direct-edit fallback.

**Root cause (hypothesis):** The maintainer seed treats `CLAUDE.md` as off-limits, consistent with forge's rule that "re-rendering CLAUDE.md via forge upgrade and marker-repair are deterministic, not authoring." But that rule is about the RENDERED orchestrator block (between the forge markers). The repo-root CLAUDE.md ALSO contains hand-authored, forge-repo-specific prose ABOVE the marker block — the "## File layout" tree, conventions, auth-mode notes, etc. That hand-authored region has NO owner:
- the documentation-maintainer declines the whole file, and
- `forge upgrade` only re-renders the marker block, never the hand-authored top.

So hand-authored CLAUDE.md prose drifts with no routed path to fix it — every correction falls to the orchestrator's manual fallback, which is exactly the drift the route-to-maintainer discipline exists to prevent.

**Decision needed (pick one):**
1. Teach the maintainer seed to edit the hand-authored (pre-marker) region of CLAUDE.md while still refusing the rendered block — give the orphaned prose an owner.
2. Codify the split explicitly: hand-authored CLAUDE.md prose is an orchestrator-direct exception (like backlog/notes), and document that in the routing allowlist so it's a deliberate choice, not a silent gap.
3. Move volatile content like the File layout tree OUT of CLAUDE.md into a maintainer-owned doc (e.g. docs/architecture.md) that CLAUDE.md links to, so it lives where the maintainer already operates.

**Scope:** small. Mostly a seed-prose + routing-allowlist decision, plus possibly relocating one section. Relates to the docs-ownership split in CLAUDE.md ("ephemeral → orchestrator-direct; durable prose → documentation-maintainer").

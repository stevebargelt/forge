---
id: FG-362
type: story
status: active
title: "Forge Invariants: document the small set of rules that make the system understandable"
epic: FG-291
created: 2026-06-22
---

## Problem

Forge has accumulated enough control-plane concepts that humans and agents need a small shared set of invariants to reason from. Today those rules are spread across README, CLAUDE.md, docs, seeds, and implementation comments.

Without a compact invariants document, every discussion risks re-deriving basic rules like what is source vs derived, how project overrides work, what SQLite owns, and where trust boundaries live.

## Goal

Create a short durable `docs/invariants.md` document that names the small set of rules that make Forge understandable.

The document should be a compression layer for humans, orchestrators, and future agents.

## Scope

- Add `docs/invariants.md`.
- Keep it short: roughly 10-15 invariants.
- Use the SOURCE / DERIVED / EFFECTIVE / RECORDED vocabulary.
- Cover run/task truth, config precedence, seeds, model policy, workflow YAML, runtime YAML, red isolation, dashboard/CLI boundaries, and agent trust boundaries.
- Link or reference the doc from appropriate orientation surfaces in a follow-up if needed.

## Candidate Invariants

- SQLite is the source of run/task lifecycle truth.
- Task artifacts are evidence, but task rows define lifecycle state.
- Project config overrides fully replace host config.
- Host-installed config is active runtime config; repo seeds are templates/install sources.
- RACI Markdown is SOURCE; routing-policy.yml is DERIVED; resolved routes are EFFECTIVE.
- Recorded receipts describe what actually happened at dispatch time.
- Model policy chooses who runs; workflow YAML describes work.
- Runtime YAML describes how a provider/model is executed.
- Reds are read-only at the OS/container boundary.
- Mutations go through the Forge control plane; dashboard is primarily the human visibility surface.
- Agents are fallible workers; gates, reds, tests, and receipts are the trust boundary.
- Runs can complete even when tasks failed; task status carries success/failure detail.
- Durable docs are maintained deliberately, not as casual side effects.

## Non-Goals

- No implementation behavior changes.
- No large concepts rewrite.
- No exhaustive architecture document.
- No duplicate of every existing how-to.

## Acceptance Criteria

- `docs/invariants.md` exists and is concise.
- It defines SOURCE, DERIVED, EFFECTIVE, and RECORDED.
- It states the core invariants in direct language.
- It avoids implementation minutiae that would drift quickly.
- It is suitable for humans and orchestrator/agent orientation.

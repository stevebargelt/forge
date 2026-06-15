---
id: FG-220
type: story
status: done
title: "AWN-7 provider-runtime: extract Claude execution behind a provider interface (supersedes #106)"
---

**Closed:** 2026-06-01. Commit `8a4773e`.

docs/agentic-workflow-next-steps.md §7. Make Claude/Codex/future agents interchangeable behind one forge lifecycle.

SUPERSEDES #106 (provider abstraction — "NEEDS ARCHITECTURE WORK"). AWN-7 is the same work with a concrete interface spec.

Scope — runtime/provider interface covering:
- prompt composition, process launch, streaming output, result parsing, usage/cost capture, cancellation, error classification.
- Move Claude-specific assumptions behind a Claude provider.
- Add a Codex provider only AFTER the interface is explicit enough to preserve lifecycle semantics.
- Workflow YAML + task contracts stay provider-neutral.

Acceptance:
- Existing Claude behavior passes through the interface with no regression.
- Provider output streams into the same container logs + lifecycle events.
- Provider failures map into the same failure_kind taxonomy.
- A smoke task runs through a second provider without changing workflow definitions.

Note: runtime YAMLs already exist (seeds/runtimes/claude-*.yml) + loader; this formalizes the execution interface, not just config. Largest/most architectural item — sequence last per the doc. Second of the broadening trio.
---
id: FG-239
type: story
status: done
title: "Docs drift — Crawl 4: L1 parity tests for config/examples/runtime seeds"
---

**Closed:** 2026-06-02. Commit `bd26b2b`.

Deterministic tests (no LLM) that seed examples + configs PARSE and MATCH the current schema/vocabulary:
- seeds/model-policy.example.yml (parses under ModelPolicySchema; uses current vocab e.g. activity: not model:)
- seeds/workflows/* (parse under WorkflowSchema)
- seeds/runtimes/* (parse under RuntimeSchema; e.g. codex-subscription.yml)

Cheapest drift layer (L1). Would have caught this session's model:->activity: example drift mechanically. Runs in the normal test suite. Catches the config/example class only; prose drift is Crawl 3/5.
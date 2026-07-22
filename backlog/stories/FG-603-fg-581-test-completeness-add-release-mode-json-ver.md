---
id: FG-603
type: story
status: active
title: "FG-581 test completeness: add release-mode --json + verbatim-construct assertions to the promoted-release acceptance test"
created: 2026-07-22
---

Source: FG-581 final delta review (red-wide, needs_fix — dispositioned by the operator as duplicative coverage, not a blocker; AC proven in dev mode on the mode-agnostic Step-3 path).

The promoted-release acceptance test (upgrade.integration.test.ts, the 'FG-581 (release-mode acceptance)' case) proves the release path refuses, neutralizes the stale routing-policy.yml on disk, names the resolved FORGE_HOME paths, leaves nothing silently authoritative, and touches no host install — but checks the in-memory return + the generic INVALIDATED message. It does NOT also drive json:true in release mode nor assert routingPolicyError carries the VERBATIM compiler-rejected construct in release mode.

These are already proven mode-agnostically by the dev-mode json:true parse test (routingPolicyError == verbatim error; unresolved names the construct) and the configurable-FORGE_HOME construct-naming test — the --json serialization and routingPolicyError threading are the same Step-3 code regardless of mode. This ticket duplicates those assertions into release mode for matrix completeness.

Test-only, no production change. Add: a release-mode json:true invocation parsing stdout asserting routingPolicyError contains the verbatim construct-specific compiler error, plus the human warning (non-JSON release invocation) naming the construct, using a construct-specific invalid RACI.

Parent: FG-572 · Epic: FG-561.
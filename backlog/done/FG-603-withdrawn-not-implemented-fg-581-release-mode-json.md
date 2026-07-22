---
id: FG-603
type: story
status: done
title: "WITHDRAWN (not implemented): FG-581 release-mode --json/construct assertion coverage — operator declined a follow-up for duplicated, compositionally-complete evidence"
created: 2026-07-22
closed: 2026-07-22
---

> **WITHDRAWN (2026-07-22) — NOT IMPLEMENTED.**
> The operator explicitly decided NOT to file a follow-up solely for the duplicated release-mode
> `--json` / verbatim-construct assertions. The FG-581 evidence was accepted as **compositionally
> complete**: the `--json` serialization and `routingPolicyError` verbatim-construct threading are the
> same mode-agnostic Step-3 code, already proven by the dev-mode `json:true` parse test and the
> configurable-`FORGE_HOME` construct-naming test, and the promoted-`mode:"release"` acceptance test
> proves the release path reaches the refusal + on-disk neutralization. Carrying this as active work
> was backlog noise contradicting that decision. Filed in error during FG-581 closeout; withdrawn.

Original rationale (for the record):

Source: FG-581 final delta review (red-wide, needs_fix — dispositioned by the operator as duplicative coverage, not a blocker; AC proven in dev mode on the mode-agnostic Step-3 path).

The promoted-release acceptance test (`upgrade.integration.test.ts`, the `FG-581 (release-mode acceptance)` case) proves the release path refuses, neutralizes the stale `routing-policy.yml` on disk, names the resolved `FORGE_HOME` paths, leaves nothing silently authoritative, and touches no host install — but checks the in-memory return + the generic INVALIDATED message rather than also driving `json:true` and asserting `routingPolicyError` carries the verbatim construct in release mode.

Parent: FG-572 · Epic: FG-561.

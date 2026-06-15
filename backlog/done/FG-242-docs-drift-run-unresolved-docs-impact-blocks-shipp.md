---
id: FG-242
type: story
status: done
title: "Docs drift — Run: unresolved docs impact blocks 'shipped'"
---

**Closed:** 2026-06-02. Commit `53f680c`.

Acceptance gate (final slice). A feature cannot be "shipped"/complete if operator_behavior_changed is true and docs impact is unresolved. Depends on Walk + the detection layers (Crawl 3/4/5).

- Gate on the drift VERDICT (mechanical L1/L2 clean + semantic L3 clean, OR stale-found-and-resolved) — NOT a "docs task ran" checkbox (that's the present-but-wrong rubber-stamp failure).
- Allow deferred-with-reason (docs_not_updated_reason) so it doesn't block when docs genuinely aren't needed.
- Fire on operator_behavior_changed, not "a doc-ish file was touched" — over-firing erodes the gate into ceremony.
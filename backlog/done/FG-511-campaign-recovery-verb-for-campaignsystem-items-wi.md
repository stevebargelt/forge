---
id: FG-511
type: story
status: done
title: campaign recovery verb for campaign_system items with durable transient auth/infrastructure evidence (audit N-B)
created: 2026-07-10
closed: 2026-07-10
closed_commit: e9c981b
---

Source: notes/forge-engineering-review-2026-07-09.md finding N-B (MEDIUM). Deliberately separate from FG-507 (operator constraint 2026-07-09: do NOT broaden FG-507 to cover campaign retry).

Evidence: executor.ts:400-408 lands any non-complete run on blockerKind campaign_system; the existing retryCampaignItem kind filter (executor.ts:1867) accepts auth/infrastructure only; reconcile requires out-of-band ship evidence a never-finished run cannot have. Net: an overnight transient blip (e.g. idle-timeout) on a full_feature item is campaign-terminal — only abandon or re-plan.

Scope (operator-stated): add a recovery verb for campaign_system ONLY when durable underlying task/run evidence proves a transient auth/infrastructure failure. Evidence-gated, fail-closed: no durable proof means refusal.

Acceptance:
- [ ] campaign retry (or an explicit reset verb) accepts a campaign_system item when the underlying run/task durable failure evidence classifies as transient auth/infrastructure
- [ ] campaign_system items WITHOUT such durable evidence are refused with a reason naming the missing/non-transient evidence — negative tests for at least: no linked run, run failed for non-infra cause, evidence ambiguous
- [ ] full-path test: transient-infra campaign_system item, recovery verb, resume, item re-drives through the real executor path
- [ ] recovery writes are CAS-guarded consistent with existing trust-gate writes and record a distinct audit event
- [ ] test and test-extended green on the exact PR head; review-loop closeable before merge
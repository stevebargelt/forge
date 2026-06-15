---
id: FG-110
type: story
status: done
title: Require rationale when advancing over a failed specialist red
---

**Closed:** 2026-05-12 on branch `rationale-on-red-fail-110` → merged to main. Test suite 338/338 (+5 gate tests). Two-layer fix:
- **Spine (`src/spine/gate.ts`):** specialist-fail-rationale check now applies to ANY gate type, not just verdict-gated phases. Previously a `gate: "human"` task with a failed specialist red could be advanced with no rationale at all — zero audit trail of the override. Authoritative-red protection (via the `blocked_by_red` status path) was already correct for all gate types and is unchanged.
- **Dashboard (`src/dashboard/html.ts`):** gateActionsSection computes `advanceRequiresRationale` from the verdict list. When true: specialist red verdict cards are surfaced (same `redVerdictCard` used for `blocked_by_red`); helper text + textarea placeholder shift to "required to advance over the specialist red(s) above"; the Advance button becomes `⚠ Advance over red(s)` in btn-warning styling and passes `requireRationale: true`, triggering doGate's existing client-side toast on empty submission.
- 5 new gate tests cover both gate types (human, verdict), happy/empty/forced paths.
**Live-verified** by flipping `task-build-aa57f1` (the #91 build with a real red-backend specialist fail at 0.85) back to `awaiting_gate`, opening the dashboard, confirming the rendering + the empty-rationale toast + the non-empty-rationale path.
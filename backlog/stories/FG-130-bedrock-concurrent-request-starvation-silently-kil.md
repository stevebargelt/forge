---
id: FG-130
type: story
status: active
title: Bedrock concurrent-request starvation silently kills a parallel red
---

**Why:** Caught 2026-05-13 during the #127 forge run's build phase. 5 reds dispatched in parallel (red-wide, red-narrow, red-frontend, red-backend, red-security) at 18:11. Four produced their first stdout within 30s of start. **red-security produced zero stdout for 5 full minutes**, hit forge's idle-watchdog kill at 18:16, container terminated. DB recorded the verdict as default-`inconclusive` (0.5 confidence, empty findings) because gate.ts handles "task failed without writing result.json" by inferring an inconclusive verdict.

**Likely root cause:** Bedrock concurrent-request quotas at the account tier. claude-code retries silently on 429/throttling within its stream-json output mode — no client-visible signal that the first request never went through. Other 4 reds got their slot; red-security got starved. The starved request kept retrying internally but produced no token output, so forge's idle watchdog (no-stdout-for-300s) killed the container before retries succeeded.

**Why this matters:** The gate semantics treat `inconclusive` as informational + advanceable-with-rationale. That's correct for legitimate inconclusive verdicts, but here it papers over an infra failure as if it were a content judgment. From the human's perspective, "one red went inconclusive" reads as "the red found something ambiguous"; the truth is "the red never actually ran."

**How to apply — three layers worth considering:**
1. **Detect zero-stdout idle-timeout kills + surface them differently from "agent reported inconclusive."** The reconcile / dispatch tail in spawn.ts knows the difference (idle-timeout exit code `137`, empty stdout, no result.json). Today it gets folded into `status='failed'` for the task and the gate aggregates it as default-inconclusive. Adding a `task.failed.reason='infra'` distinction would let the gate UI surface "this red didn't run; verdict not meaningful" instead of "this red was inconclusive."
2. **Stagger or limit parallel red dispatch.** Today gate.ts dispatches all reds simultaneously. A semaphore (max 3-4 concurrent) would avoid the rate-limit edge while still being parallel. Adds latency to the build phase but stops the starvation. Probably wrong if the issue is account-tier quota — the 5th still hits the limit when it eventually fires.
3. **Bedrock-side: request a quota increase** or move to a higher-tier model. Outside forge's control, but worth knowing as the architectural workaround.

Lean (1) first — surfacing the failure mode honestly is cheap and the right shape regardless of how the root cause is mitigated. (2) is a tactical fix; (3) is the actual root cause.

**Composite with #74** (reconcile + watchdog can't catch zero-stdout orphans). #74 caught the same shape of failure from a different angle — this is the same dataclass of bug.

**Caught:** 2026-05-13 — during the build phase of the #127 forge run.
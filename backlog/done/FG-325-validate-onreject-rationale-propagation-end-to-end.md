---
id: FG-325
type: story
status: done
title: Validate onReject rationale-propagation end-to-end
---

**Closed:** 2026-05-12. Legacy entry from 2026-05-07. The original onReject implementation (#25 in archive — `d075f9f`) shipped years ago; this validation follow-up never got prioritized and the world has moved on. Three reasons to close rather than carry:
1. ui-design's review-phase reject path has been exercised in real runs since 2026-05-08 (the `#54`-era prompt-author iterations). If it were broken end-to-end we'd have seen it.
2. The `inputs.rejectedRationale` + `inputs.rejectedTaskId` propagation is unit-tested in `src/spine/gate.test.ts` ("gate reject on a review task triggers onReject and creates a brief task with rejectedRationale").
3. The bigger reject-UX question — letting the human pick WHICH phase to loop back to — is captured by #93, which is the live ticket. #25's validation framing is subsumed there.
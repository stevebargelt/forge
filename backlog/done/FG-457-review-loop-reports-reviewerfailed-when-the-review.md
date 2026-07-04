---
id: FG-457
type: story
status: done
title: review-loop reports reviewer_failed when the reviewer actually returned a valid fail verdict
created: 2026-07-04
closed: 2026-07-04
closed_commit: ab94c97
---

During FG-455 p2/p3 review (run-review-loop-fg-455-e1a926), `forge review-loop` stopped with stop_reason=reviewer_failed and a self-contradictory round note: 'verification: ok (typecheck=ok, test=ok)' AND 'reviewer: skipped (verification failed)' on the same round. But the red-wide task (task-red-wide-cd4268) actually completed cleanly with a well-formed result.json: status=complete, verdict=fail, confidence 0.78, 4 findings, invariants_verified populated.

So a genuine reviewer FAIL verdict (which should surface as blocked_by_reviewer / needs_fix and drive a fixer round) was instead misclassified as a structural reviewer_failed, and the loop reported the findings nowhere in its own summary (they were only recoverable by reading the task result.json directly). The round note's 'reviewer: skipped (verification failed)' contradicts its own 'verification: ok' line, pointing at a bug in how review-loop reads the verification outcome and/or the reviewer's result.

Impact: an orchestrator trusting review-loop's stop_reason would treat a real fail-with-findings as an infra failure and either hand-loop or drop the findings. Repro: run review-loop over a range where the reviewer returns verdict=fail.

Fix direction: reconcile review-loop's verification-outcome read with the reviewer-dispatch gate; a well-formed reviewer result.json with verdict=fail must map to a fail/needs-fix stop reason (surfacing the findings), never reviewer_failed. reviewer_failed should be reserved for a genuinely malformed/absent reviewer result.
---
id: FG-514
type: story
status: done
title: "review-loop: reviewed-tip trust must require equality with the remote head, not ancestry — a remote-ahead tip currently reads trusted"
created: 2026-07-10
closed: 2026-07-10
closed_commit: f135f95
---

Review finding N-C (queued 2026-07-10, item 1 of 4 in the sequential reliability queue).

Today resolveReviewedTipTrust (src/cli/commands/review-loop.ts:330-341) returns trusted on a ONE-DIRECTIONAL ancestry check — isAncestor(reviewedTipSha, remoteRef) — against a remote-tracking ref that is never fetched. Two consequences:

1. An upstream STRICTLY AHEAD of the reviewed tip still reads trusted: the reviewed tip is an ancestor of the remote head, so the loop prints "✓ closeable" even though the remote branch carries commits the reviewer never saw. Merge authorization can therefore cover never-reviewed commits.
2. The check runs against a stale locally-cached @{u} (deliberately no implicit fetch under FG-502), so the "remote head" compared against may not be the real remote head at all.

Fix: trusted must mean EQUALITY with the real remote head, not one-directional ancestry.

Acceptance:
- [ ] trusted requires BOTH directions empty: remoteRef..reviewedTip AND reviewedTip..remoteRef have no commits (equivalently: bidirectional is-ancestor / same commit after resolution)
- [ ] a new remote_ahead outcome names the unreviewed commits (the reviewedTip..remoteRef list) and withholds closeable exactly like local_only does — CLI output and run note both carry it
- [ ] the trust resolution compares against the REAL remote head via a bounded fetch (fetch the single tracking ref, bounded/quiet), not a stale cached @{u}; when the fetch or ref resolution fails, fail closed (remote_unavailable / not closeable), never silently trusted
- [ ] tests: upstream-ahead withholds closeable; equal tips pass; local-only still refused; remote-unavailable still refused

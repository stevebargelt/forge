---
id: FG-543
type: story
status: active
title: "release check: agent-image STALE is a false positive after a fully-cached rebuild (mtime-vs-image-ctime comparison)"
created: 2026-07-12
---

## Problem

`forge upgrade` / `forge doctor` flag `agent-dev-worker:latest` as STALE by comparing build-input mtimes (Dockerfile + COPYed scripts) against the image's creation timestamp. Two failure modes observed live 2026-07-12:

1. A fully-cached `docker/build.sh` rebuild exits 0 and produces a new image ID, but docker keeps the image *created* timestamp from the original (cached) build — so the STALE flag never clears, no matter how many times the operator rebuilds.
2. Git operations (pull/checkout) refresh file mtimes without changing content, so inputs read "newer" than the image even when nothing about them changed.

Combined effect: a perpetual STALE warning the recommended remediation cannot clear. Operator ran `forge upgrade --rebuild-image` (clean, no errors), orchestrator re-ran `docker/build.sh` (exit 0, new image ID `56234953f83c`), and `forge doctor` still reports STALE because the image creation time still reads ~21h old.

## Evidence (2026-07-12)

- launch-image-rebuild-zuupw6: `./docker/build.sh` exited 0, log shows all layers `CACHED`, new manifest exported
- `docker images agent-dev-worker` → `latest  21 hours ago  56234953f83c` (ID moved, CreatedSince didn't)
- `forge doctor` → `! image agent-dev-worker:latest  STALE — a build input ... is newer than the built image`

## Direction

Replace the mtime-vs-ctime heuristic with a content-based comparison: hash the build inputs (Dockerfile + every COPYed file) and compare against a digest recorded at build time (e.g. an image LABEL set by docker/build.sh, or a sidecar record keyed by image ID). Staleness = input digest differs from the recorded digest. This survives cached rebuilds and is immune to mtime churn from git.

## Acceptance Criteria

- [ ] A fully-cached rebuild clears the STALE flag (flag derives from content digest, not timestamps)
- [ ] Touching a build input WITHOUT changing content does not flag STALE
- [ ] Changing build-input content (e.g. editing forge-test.sh) DOES flag STALE until the next rebuild
- [ ] docker/build.sh records the input digest at build time; the check fails toward STALE when the digest record is absent (old images stay flagged until rebuilt once)
- [ ] `forge doctor` / `forge upgrade` release-check output explains the digest basis when flagging
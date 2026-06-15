---
id: FG-260
type: story
status: done
title: "pi: add pi to the agent-dev-worker Docker image"
---

**Closed:** 2026-06-05.

**Phase:** Crawl. Part of #258.
Install pi in `docker/agent-dev-worker.Dockerfile` (`npm i -g --ignore-scripts @earendil-works/pi-coding-agent`, or `pi.dev/install.sh`).
**Acceptance:** image builds; `pi --version` runs as the agent UID (1000); image-size delta noted. Flag that `forge upgrade` does not auto-rebuild the image (#229), so rollout needs a manual rebuild.
**Depends on:** #292 for runtime metadata shape.
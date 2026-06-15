---
id: FG-98
type: story
status: done
title: Fanout-collapsed node polish (progress bar + tags) — superseded by System Map
---

**Closed:** 2026-05-13. The System Map (#105) has no collapsed-vs-expanded mode — every task renders as a peer node always. The "fanout-collapsed-node atom" concept was a v0 graph-view artifact; the new view's running-fanout progress bar is wired through `_fanoutTotal` / `_fanoutComplete` on individual running tasks. Anything left here is genuinely obsolete.
---
id: FG-265
type: story
status: done
title: "pi: model-policy integration + alias mapping"
---

**Closed:** 2026-06-06.

**Phase:** Walk. Part of #258.
Wire Pi into `model-policy.yml` resolution by separating runtime selection from upstream provider/model selection. Model policy should resolve capability/profile -> runtime (`pi-*`) + upstream provider (`groq`, `anthropic`, `ollama`, etc.) + concrete model, with alias translation where Pi provider/model names differ from Forge capability aliases.
**Acceptance:** a profile resolving to a Pi runtime plus upstream provider routes correctly; an unknown runtime/provider/model alias fails loud, not silently.
**Depends on:** end-to-end story.
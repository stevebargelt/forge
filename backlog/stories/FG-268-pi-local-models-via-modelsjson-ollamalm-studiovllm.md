---
id: FG-268
type: story
status: active
title: "pi: local models via models.json (Ollama/LM Studio/vLLM)"
---

**Phase:** Run. Part of #258.
Enable local/custom models through `~/.pi/agent/models.json` (any OpenAI/Anthropic/Google-compatible endpoint). Target cheap/free reds and triage on local hardware.
**Acceptance:** a forge red/triage task runs against a local Ollama model via pi; recorded cost ~0.
**Depends on:** end-to-end story, model-policy mapping.
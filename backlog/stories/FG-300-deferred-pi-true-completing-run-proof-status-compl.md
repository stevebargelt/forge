---
id: FG-300
type: story
status: active
title: "[DEFERRED] pi: TRUE completing-run proof — status complete + usage row from a live pi task"
---

**Status: DEFERRED — requires paid extra credits or an alternate free provider. Not scheduled.** This is the real end-to-end Crawl exit that #296 did NOT achieve. Until this is satisfied, do not describe the Pi Crawl as having a proven completing run.

**What's already proven (so this is narrow):** subscription OAuth auth, dispatch, and #264 provider-refusal attribution are all live (#296). The pi usage parser (#262) is unit-tested AND fed a live-captured non-zero pi stream (`src/store/__fixtures__/pi-usage-stream.jsonl`, via a streaming mock); result contract (#264) and dispatch (#261) are tested. The ONLY unobserved thing is a successfully-completing live pi call.

**What's still unobserved end-to-end:** status `complete` + a real agent-written `result.json` + a non-zero `model_calls` row from a live pi run, and that #264's attribution does NOT misfire on a healthy run.

**To satisfy (a no-cost path is preferred):**
- a free-tier provider key (Gemini / Groq / Cerebras) on a pi-apikey-style runtime — no spend; OR
- paid extra-usage credit at claude.ai/settings/usage, then re-run the #296 invoke on `pi-oauth`.
- Capture: run id, `result.json` status complete, and `forge usage` showing the pi row.

Relations: #296 (closed — auth/attribution only), #266, #262, #264, #261, seeds/runtimes/pi-oauth.yml.
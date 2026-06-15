---
id: FG-296
type: story
status: done
title: "pi: subscription OAuth live auth + provider-refusal attribution (NOT the completing-run exit)"
---

**Closed:** 2026-06-06.

**Correction — do NOT call this "the Crawl exit."** What actually landed and is proven LIVE: `forge invoke --runtime pi-oauth` authenticated via the subscription OAuth seam (#266), dispatched, reached the provider (api.anthropic.com), and the #264 failure attribution correctly surfaced a real `400 "out of extra usage"` (account pay-as-you-go balance was $0) — not a bare `no_result_json`. That is valuable and real. But the ORIGINAL acceptance below (a COMPLETING run: status `complete` + `result.json` + a usage row) was **NOT met** — the call was refused pre-generation, so nothing completed and no usage row was written. Renamed/reframed to match what shipped; the true completing-run proof is **deferred to #300** and intentionally unfunded for now.

**Original framing (the live half of #264 — superseded by the correction above).** #264 landed the deterministic result/completion contract (status + attributed failures) WITHOUT a live provider call. This ticket was the remaining end-to-end proof: route one real role through the pi runtime against a live credential and confirm a full forge task lifecycle.

**Why separate:** #264 was scoped to result-contract parity (deterministic, no live call). The "usage captured" + "gate" half needs (a) the pi-jsonl usage parser (#262) and (b) a real provider API key — neither available when #264 landed.

**Depends on:**
- #262 — pi-jsonl usage parser (so usage is captured, not failing loud as unsupported).
- a live provider credential for the pi runtime (a cheap provider — Groq/Cerebras/Gemini — or anthropic via ANTHROPIC_API_KEY).

**Acceptance:**
- A real `forge invoke --runtime pi-apikey <role> --task ...` (or a policy-bound pi profile once #265 lands) completes a genuine task end-to-end:
  - status `complete` with a real agent-written `result.json` (output-schema parity with claude/codex).
  - usage captured in `model_calls` (rows with input/output/cache tokens; pi pre-computes cost).
  - if the role is gated, the gate advances on the real result.
- Captured as a documented run (run id + result.json + `forge usage` showing the pi rows).
- Confirms the #264 attribution paths don't fire on a healthy run (no false "agent did not honor the contract").

**Already done (don't redo):** dispatch (#261), prompt-injection exactly-once (#263), result-contract + attributed failures (#264). This is purely the live e2e + usage capture wiring proof.

Relations: #258 (Pi epic), #262, #265, #261, #263, #264, seeds/runtimes/pi-apikey.yml.
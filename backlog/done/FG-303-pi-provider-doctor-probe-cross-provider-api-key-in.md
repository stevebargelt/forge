---
id: FG-303
type: story
status: done
title: "pi: provider-doctor probe + cross-provider API-key injection (Walk auth-seam)"
---

**Closed:** 2026-06-07.

**Phase:** Walk. Part of #258. PRD Walk item #3 ("Provider API-key availability is visible in provider doctor").
#265 added explicit-runtime profiles (`runtime: pi-apikey` + an upstream `provider:` like groq). That path SKIPS the `(provider,auth)->runtime` binding table, so it lost the old bindRuntime fail-loud for unknown providers — an unprobeable provider (groq) now resolves silently. Two concrete gaps:
1. `provider-doctor.ts` `PROBEABLE_AUTH_BY_PROVIDER` only knows anthropic/openai; `forge providers doctor` can't surface whether a Groq (or other upstream) key is present. `checkResolvedAvailability` treats `unknown` as ok, so a pi-groq profile passes with no credential.
2. `pi-apikey.yml` `auth.mode: apikey` injects only `ANTHROPIC_API_KEY`; there is no cross-provider key injection (e.g. `GROQ_API_KEY`), so even with a host key + green doctor the container wouldn't receive it.
**Acceptance:** `forge providers doctor` reports availability for a pi upstream provider (e.g. groq/api → ✓ when its key is present, ✗ when absent); a pi-groq profile fails loud at dispatch when its provider key is unavailable; the resolved provider's API key is injected into the container so a real run can authenticate. Until then the `pi-groq` example in `seeds/model-policy.example.yml` is illustrative-only.
**Depends on:** #265 (landed).
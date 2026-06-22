---
id: FG-366
type: story
status: active
title: "manifest runtime.name: outer execution-metadata field records the requested sentinel while controlPlane.runtime.name records the resolved concrete name (intra-manifest inconsistency)"
created: 2026-06-22
---

**Found:** 2026-06-22, red-wide review of the FG-350 receipt-accuracy fixes.

**Issue:** After FG-350, a task manifest has TWO runtime-name fields with potentially different values:
- `manifest.runtime.name` (pre-FG-350 execution-metadata block) = the REQUESTED sentinel (e.g. `claude`).
- `manifest.controlPlane.runtime.name` (FG-350 receipt) = the RESOLVED concrete runtime (e.g. `claude-apikey`).

Before FG-350 there was only the one (imprecise) field, so no inconsistency was possible. FG-350 added a precise field; now the two diverge for sentinel-resolved runtimes (`claude` → claude-oauth/apikey/bedrock). This is a footgun for the eventual FG-348 Explain view (which `runtime.name` is "true"?).

**Why NOT fixed in FG-350:** the architect phase drew an explicit boundary — the pre-existing runtime/model execution block must stay as-is because `forge show` and usage attribution read it (changing it risks those consumers). Aligning the legacy field is a separate decision with consumer-impact analysis, deliberately not bundled into FG-350.

**Options:**
1. Make the outer `manifest.runtime.name` also record the resolved concrete name (audit consumers: forge show, usage attribution — confirm they don't key on the sentinel).
2. Keep both but rename/clarify so they obviously mean requested-vs-resolved (e.g. outer `requested`, receipt `resolved`), and have FG-348 surface the distinction explicitly.
3. Document the distinction and accept it.

**Also (low):** Fix 2's sentinel-resolution test covers only the invoke path; add a runNext/pipeline test asserting the concrete declared name is recorded there too.

**Scope:** small, but option 1 requires a consumer audit first. Relates to FG-350, FG-348.

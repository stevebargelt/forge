---
id: FG-366
type: story
status: active
title: "manifest runtime.name: outer execution-metadata field records the requested sentinel while controlPlane.runtime.name records the resolved concrete name (intra-manifest inconsistency)"
created: 2026-06-22
---

**Found:** 2026-06-22, red-wide review of the FG-350 receipt-accuracy fixes.

## Problem

After FG-350, a task manifest has TWO runtime-name fields with potentially different values:
- `manifest.runtime.name` (pre-FG-350 execution-metadata block) = the REQUESTED sentinel (e.g. `claude`).
- `manifest.controlPlane.runtime.name` (FG-350 receipt) = the RESOLVED concrete runtime (e.g. `claude-apikey`).

Before FG-350 there was only the one (imprecise) field, so no inconsistency was possible. FG-350 added a precise field; now the two diverge for sentinel-resolved runtimes (`claude` → claude-oauth/apikey/bedrock). This is a footgun for the eventual FG-348 Explain view (which `runtime.name` is "true"?).

**Why NOT fixed in FG-350:** the architect phase drew an explicit boundary — the pre-existing runtime/model execution block must stay as-is because `forge show` and usage attribution read it (changing it risks those consumers). Aligning the legacy field is a separate decision with consumer-impact analysis, deliberately not bundled into FG-350.

## Goal

The manifest's two runtime-name fields cannot silently disagree: either the outer execution-metadata `runtime.name` records the resolved concrete runtime (matching `controlPlane.runtime.name`), or the requested-vs-resolved distinction is explicitly documented so FG-348 has one unambiguous answer.

## Options

1. Make the outer `manifest.runtime.name` also record the resolved concrete name (audit consumers: forge show, usage attribution — confirm they don't key on the sentinel).
2. Keep both but rename/clarify so they obviously mean requested-vs-resolved (e.g. outer `requested`, receipt `resolved`), and have FG-348 surface the distinction explicitly.
3. Document the distinction and accept it.

**Orchestrator decision (2026-07-09, autonomous session):** option 1 if the consumer audit clears; else option 3 (option 2's field rename has worse consumer blast radius than a value fix).

## Acceptance Criteria

- [ ] Consumer audit recorded (in the PR or ticket): every reader of the outer manifest `runtime.name` identified (forge show, usage attribution, plus grep sweep), noting whether any keys on the sentinel value.
- [ ] If the audit clears: the outer `manifest.runtime.name` records the resolved concrete runtime; existing forge show / usage-attribution tests still pass.
- [ ] If a consumer keys on the sentinel: the requested-vs-resolved distinction is documented in the manifest/concepts docs and this ticket records why option 1 was rejected — no silently-ambiguous pair remains.
- [ ] A runNext/pipeline-path test asserts the concrete resolved name is recorded there too (closing the invoke-only coverage gap from FG-350 Fix 2).

**Scope:** small; option 1 gated on the consumer audit. Relates to FG-350, FG-348.

---
id: FG-271
type: story
status: done
title: "frontend-specialist seed: Playwright/E2E fallback when browser-tools unavailable (stop failing correct code)"
---

**Closed:** 2026-06-04. Commit `ef51999`.

**From a forge-site run (Issue 3a).** task-build-0-caa1ac returned `status: failed, error: "visual-verification-blocked: Chrome not available"` on code that was actually correct. The container's browser-tools is broken (browser-start.js targets the macOS Chrome path; :9222 refused; browser-tools npm install fails on the read-only fs), and the frontend seed treats "no browser" as a HARD failure (CLAUDE.md line ~100) with no fallback — so correct UI work is reported failed. Meanwhile Playwright (`test:e2e`) DID run in-container against the built dist.

**Fix (seed prose):** add a visual-validation fallback chain to the frontend-specialist seed:
1. Primary: browser-tools (:9222) as today.
2. Fallback: if browser-tools/:9222 is genuinely unavailable, use the project's Playwright/E2E suite (real headless chromium in-container) and capture its artifacts in `screenshots`.
3. Only `status: failed` when NEITHER path is available.
When browser-tools is down but Playwright validated AND code/tests pass: return `status: complete` with an explicit caveat (browser-tools infra gap, see #187) — do NOT fail correct work. Preserve the anti-skip intent: must still attempt visual validation; never substitute type-check alone.

**Related infra (tracked, not this ticket):** #187 (point browser-tools at the baked Playwright arm64 chromium — fixes browser-tools in-container), #245 (container-local node_modules shadow volume — fixes the arch mismatch / Issue 3b). This seed change is the immediate stop-bleeding fix; #187/#245 fix the underlying container.
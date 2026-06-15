---
id: FG-187
type: story
status: done
title: Native arm64 (multi-arch) agent image — drop the amd64 Rosetta tax on Apple Silicon
---

**Closed:** 2026-06-04. Commit `ad1126c`.

**Broad perf win.** docker/build.sh pins `--platform linux/amd64`, so on Apple Silicon EVERY agent container runs under Rosetta/qemu emulation (2-4x slower CPU). This taxes every run — builds, tests, browser work, the review panel that triggered this investigation (red-wide blew past a 10-min ceiling largely due to emulation + contention).

**Sole root cause:** the headless Chrome baked for the browser-tools skill (`:9222`) comes from `@puppeteer/browsers install chrome` (Chrome for Testing), which Google publishes for linux64 only — no official Linux/arm64 binary. build.sh pins amd64 for that one dependency; everything else pays the tax as collateral.

**Why it's achievable now (and the codebase contradicts itself):** build.sh claims Chromium-for-Testing has no arm64; the Dockerfile comment (lines 43-44) claims it "ships both arm64 and amd64" and that we "need multi-arch long-term." Chrome FOR TESTING is genuinely amd64-only on Linux, BUT:
- #180 already bakes Playwright's chromium into the image (project E2E). Playwright's chromium DOES ship linux-arm64.
- browser-tools uses puppeteer-core, which can drive any chromium via `executablePath`.
So: point browser-tools at Playwright's (already-present, arm64-capable) chromium, drop the @puppeteer/browsers Chrome-for-Testing dependency, and the amd64 pin's only justification is gone. The thing build.sh was avoiding ("dragging Playwright's arm64 chromium back in") is already done by #180.

**Proposed:**
- Repoint browser-tools' `:9222` Chrome to Playwright's chromium (executablePath), removing the @puppeteer/browsers chrome install. Verify browser-start/nav/screenshot + auth-inject all work against it.
- Build the image native arm64 on Apple Silicon; multi-arch (buildx) so amd64 hosts (CI/Linux servers) still get amd64.
- Reconcile/remove the contradictory amd64-vs-arm64 comments in build.sh + Dockerfile; update the #128 decision record.

**Verify:** agent-entrypoint.sh launches the right chromium binary on :9222; better-sqlite3/sharp/Go toolchain build native arm64 (all arch-agnostic or arm64-available); the browser-tools skill is host-mounted (pi-skills) so it's arch-neutral — only the in-container chromium binary path matters.

**Caveat:** quantify the actual win per step before committing effort — pure-reasoning agents are network-bound (Claude API) and gain less; CPU/browser/build/test-heavy steps gain most. But the review panel evidence suggests it's material.

Relates to #128 (container Chrome + retire Playwright MCP), #180 (Playwright chromium baked in).
---
id: FG-180
type: story
status: done
title: "Bake Playwright (chromium) into the agent-dev-worker image for E2E — resolves #177 infra question"
---

**Closed:** 2026-05-29.

**Decision (2026-05-29):** E2E testing (#177) requires Playwright + a browser available *inside* the agent container. Bake it into the `agent-dev-worker` image (docker/). This resolves #177's infra question in favor of "bake," not `connectOverCDP`.

**Bring Playwright's OWN chromium — do not reuse #128's CDP Chrome.** Rationale: keeps the project-E2E layer (b) independent of the agent-verification layer (a) — the same separation #177 draws — and preserves real Playwright isolation: per-test browser contexts, `storageState`-per-context (this is the seam #176 auth plugs into), and parallel workers. A shared `connectOverCDP` session to the browser-tools Chrome can't give that. #128's Chrome stays dedicated to browser-tools; Playwright drives its own. Two browsers, two layers — intentional.

**Specifics:**
- `npx playwright install --with-deps chromium` — chromium-only (~300MB) to limit image bloat; skip firefox/webkit unless a project needs them.
- Pin the baked `@playwright/test` version and its matching browser build (Playwright browser binaries are version-locked to the package).
- Set `PLAYWRIGHT_BROWSERS_PATH` to a shared baked location so a project's `npm install` finds the pre-downloaded browser instead of re-fetching it per run.
- **Version-mismatch wrinkle:** if a project pins a `@playwright/test` whose browser build differs from the baked one, Playwright re-downloads at run time (slower but works). Mitigation: bake a recent version + document a supported range; revisit only if it bites.

**Verification:** the container can run `npx playwright test` against a trivial spec headlessly and produce a result + trace with no network browser download.

**Ties:** resolves the infra question in #177 (E2E authoring + anti-downgrade gate); independent of #176 (auth) — this unblocks the auth-independent E2E-mechanics spike, so it can proceed in parallel; follows the image-baking pattern from #128 (which baked Chrome for browser-tools). Sequencing: this + #176 are the two prerequisites that make #177's E2E backfill real.
---
id: FG-131
type: story
status: done
title: Dashboard CLIENT_JS bundle is stale until process restart; live diffs don't show
---

**Closed:** 2026-05-23. Commit `post-v2-dashboard-split`.

**Why:** Caught 2026-05-13 during the #127 forge run. Verifier-phase agent navigated to `http://host.docker.internal:8022` (the running host dashboard), found the System Map view still rendering the *pre-diff* red-edge style (solid magenta arrow, opacity 0.7), and correctly noted in its findings: *"the host server process was started before the changes; server restart would pick up the changes, but the code in /project/src/dashboard/html.ts is correct."* It then pivoted to a self-contained synthetic cytoscape render to validate the styles directly.

**Root cause:** The dashboard runs via `tsx` which hot-reloads server-side TypeScript on file change, BUT the dashboard's client-side bundle (`CLIENT_JS` inside `src/dashboard/html.ts` — a giant template literal that gets shipped to the browser) only gets re-evaluated when the server process restarts. Editing `html.ts` updates the file but the running dashboard keeps serving its captured-at-startup version of CLIENT_JS to the browser.

**Why it matters:** This is friction for two distinct workflows:
1. **Pair-coding iteration on the dashboard** — Steven + Claude editing `html.ts`, refreshing the browser, seeing no change, getting confused.
2. **Forge verify-phase visual verification (#128)** — the verifier expects `host.docker.internal:8022` to reflect the diff so it can screenshot the actual rendered result. Today it can't; the verifier has to pivot to synthetic renders (as in the #127 run) or know to restart the dashboard (it can't — different process scope).

**How to apply — options worth weighing:**
1. **File-watcher restart loop.** A small `chokidar`-style watcher in dev that re-imports `html.ts` and restarts the server on `src/dashboard/**.ts` change. Probably 30 lines. Caveat: in-flight HTTP connections drop; for a dev surface that's fine.
2. **Move CLIENT_JS out of the template literal into a separate served-on-each-request file.** The handler reads the file (or imports a fresh module) per request. Slower per request but always-fresh. Probably the cleaner refactor but bigger change.
3. **Document the restart-needed gotcha.** Cheapest. Doesn't help the verify-phase case at all.
4. **Verifier seed update: explicit guidance to use synthetic renders OR restart instruction.** This run's verifier pivoted naturally; codifying it lets future verifiers do it deliberately.

Lean (1) for the dev surface + (4) for the verify-phase case in the short term. (2) is the right long-term shape but it's a real refactor and might be unnecessary if Preact migration (#77) reshapes how the client-side ships.

**Composite with #77 (Preact migration), #128 (verifier render-check).** #77 likely reshapes how the client bundle ships; this might evaporate naturally. #128's verifier seed could note the workaround.

**Caught:** 2026-05-13 — during the verify phase of the #127 forge run.
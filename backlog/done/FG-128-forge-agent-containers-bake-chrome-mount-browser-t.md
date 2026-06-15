---
id: FG-128
type: story
status: done
title: "Forge agent containers: bake Chrome, mount browser-tools skill, retire Playwright MCP"
---

**Closed:** 2026-05-13. All five steps shipped + Playwright MCP fully torn down. Container side now uses pi-skills/browser-tools same as host side (#126).

**What landed (forge repo):**
- `docker/agent-dev-worker.Dockerfile` — replaced Playwright Chromium with Chromium-for-Testing via `npx @puppeteer/browsers install chrome@stable`. Added Chromium system deps (`libnss3`, `libgbm1`, etc.). `chmod` and ENTRYPOINT lines for the new entrypoint script. Pre-creates `/home/agent/.claude/skills/` for the bind mount.
- `docker/agent-entrypoint.sh` (new) — starts headless Chromium on `127.0.0.1:9222` in the background, then `exec`s the agent command. `--headless=new --no-sandbox --disable-dev-shm-usage`. `FORGE_NO_BROWSER=1` skips Chrome startup (test escape hatch).
- `docker/build.sh` — pinned image to `--platform linux/amd64`. Chrome doesn't ship Linux/arm64; image runs under Rosetta on Apple Silicon. Trade-off accepted: avoids dragging Playwright back in just for its arm64 bundle.
- `docker/.dockerignore` — allow `agent-entrypoint.sh` into build context.
- `src/spine/spawn.ts` — added `browserToolsDir` to `DockerArgsInput`, `resolveBrowserToolsDir()` resolver (env override via `FORGE_BROWSER_TOOLS_DIR`, default `~/pi-skills/browser-tools`, returns `undefined` when the source doesn't exist). Mount is `-v <dir>:/home/agent/.claude/skills/browser-tools:ro`. Mount is RO regardless of `readOnlyProject` — same invariant as `/design`.
- `src/spine/spawn.test.ts` — 5 new tests covering mount-absent, mount-present, RO-for-blue-agents, resolver-with-bad-path, resolver-with-good-path.
- `seeds/agents/verifier/CLAUDE.md` — new "Visual verification (UI changes)" section telling the verifier to use `browser-tools` when the plan touches UI. Cites the #105 lesson (tests-green ≠ render-correct) directly.

**What did NOT need touching:**
- `red-frontend` seed — reds declare `tools: ["read"]` only. Invoking browser-tools needs bash. Right role boundary: verifier opens the page; reds audit the artifact the implementer produced. Considered, rejected.
- `frontend-implementer` / `red-wide` / `red-narrow` — builder roles or read-only reds, neither needs the render-check invariant.

**Step 5 teardown (host-side, separate from forge repo):**
- Stopped + removed launchd service `com.sgws.playwright-mcp` (plist renamed to `.bak-before-128` in `~/Library/LaunchAgents/`).
- Removed Playwright from 5 project scopes in `~/.claude.json` (forge, forge-design, three OneDrive/obsidian projects). Backup at `~/.claude.json.bak-before-128`.
- Removed `playwright: ref: ""` stub from `~/.docker/mcp/registry.yaml`. Backup at `~/.docker/mcp/registry.yaml.bak-before-128`.
- Memory `reference_playwright_mcp_launchd.md` rewritten as "RETIRED 2026-05-13" with full restore instructions in case revival is ever needed.

**Validation:**
- 354/354 tests pass (5 new for #128).
- Live container test: `docker run` with skill bind mount, watched Chromium start in ~1.5s under Rosetta, ran `browser-screenshot.js` inside container, `docker cp`'d the PNG out, verified it's a valid screenshot (about:blank, 1906 bytes).
- The "still connecting" notice on this session's playwright MCP confirmed teardown took effect; future sessions will not see the playwright tools at all.

**Image size impact:** ~280MB for Chromium-for-Testing + system libs, roughly comparable to the Playwright Chromium that came out. Net wash.

**Open follow-up (lower priority, low scope):**
- **Upstream PR to pi-skills.** `browser-start.js` is Mac-hardcoded; a Linux-aware version (detect Chrome binary from env or PATH) would close the gap. Composes with #129.

**Composite with #116 (forge v2):** v2's runtime YAML inherits a working browser-tools surface to declare per-runtime. The `resolveBrowserToolsDir` + `browserToolsDir` mount pattern is a candidate for "declare this in the runtime YAML, runner translates to docker args."

**Caught:** 2026-05-13 (spun out of #126). **Closed:** 2026-05-13.
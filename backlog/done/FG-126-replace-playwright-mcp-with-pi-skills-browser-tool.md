---
id: FG-126
type: story
status: done
title: Replace Playwright MCP with pi-skills browser-tools (host side)
---

**Closed:** 2026-05-13. **No forge code change** — pure host-side install. Pair-coding surface migrated; forge container side spun out to #128.

**What landed (host side only):**
- Cloned `badlogic/pi-skills` (MIT, https://github.com/badlogic/pi-skills) to `~/pi-skills`.
- `npm install` inside `~/pi-skills/browser-tools/` (puppeteer-core + helpers).
- Symlinked `~/pi-skills/browser-tools` → `~/.claude/skills/browser-tools`.
- Verified end-to-end on the running forge dashboard: `browser-start.js` → `browser-nav.js http://localhost:8022/` → `browser-screenshot.js` → Read returned path. ~3 seconds. No MCP, no transport, no wedge.

**Validations along the way:**
- Skills discovery works in headless `claude --print` mode — the mode forge uses (init message includes `skills:[...]`; bodies load only on invocation). `--add-dir` does NOT install skills; well-known paths only.
- Validated inside `agent-dev-worker:latest` container with the exact docker invocation pattern forge uses today; bedrock auth; skill mounted read-only at `/home/agent/.claude/skills/<name>` discovered and fired correctly. (This is the proof point #128 builds on.)
- Mario's evolution traced: `badlogic/browser-tools` → `badlogic/agent-tools` → **`badlogic/pi-skills`** (current). He migrated from PATH-alias + README to the Anthropic Skills format because it's cross-agent (Claude Code, Codex CLI, Amp, Droid all consume `SKILL.md`).
- Token cost win measured: Playwright MCP = 13.7k tokens per spawn; Chrome DevTools MCP = 18k; Skills format = ~225 tokens (description in init, body loaded only on invoke). Two orders of magnitude.

**Memory updates:**
- New: `reference_pi_skills_browser_tools.md` — install state + pattern shape + iteration loop.
- Updated: `reference_playwright_mcp_launchd.md` — flagged "still live, slated for teardown by #126/#128."

**Spun out:**
- **#128** — container-side migration (bake Linux Chrome, entrypoint, `spawn.ts` mount, seed updates, Playwright MCP teardown). Architecture locked here; that's the build.
- **#129** — shareable pattern future feature ("use Mario's tools from this repo, with a small install dance"); placeholder for when a second consumer appears.

**Caught:** 2026-05-13 during Playwright MCP wedge mid-#105 renderer iteration.
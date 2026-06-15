---
id: FG-129
type: story
status: active
title: Shareable agent-skills pattern (future feature)
---

**Why:** While doing #126 (pair-coding side) on 2026-05-13, the pattern surfaced as something with reach beyond forge. The combination of Mario's Skills-format choice + the symlink-on-host / bind-mount-in-container duality is generally useful — any tool the human and an agent both want (screenshot, eval, search, transcript, calendar) wants both surfaces. The natural product is something like "use Mario's tools from this repo, with a small install dance for both surfaces."

**Not designed yet — this is a placeholder.** Open shape questions:
- Is the deliverable a new repo (`forge-skills`, `agent-browser-stack`), a documented section in forge README pointing at pi-skills, or something else?
- Provisioning model: `install.sh` that takes a list of skills + lays down host symlinks + npm-installs + emits a container mount manifest? A YAML config that forge v2's runtime YAML (#116) consumes? Both?
- What's forge-specific vs. general: `spawn.ts` mount injection and v2 runtime YAML wiring are forge-specific. The Skills-format choice, host-symlink/container-mount duality, and pi-skills install dance are general.

**Don't extract prematurely.** Ship #128 (forge container-side use) first. When a second consumer appears (another project, another team, someone else hitting the same Playwright-MCP token-tax pain), revisit and extract.

**Composes with #116 (forge v2):** runtime YAML may be the natural home for "this runtime gets these skills mounted." That's where to design provisioning if the answer becomes "config-driven."

**Caught:** 2026-05-13.
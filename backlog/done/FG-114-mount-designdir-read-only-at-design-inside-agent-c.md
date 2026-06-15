---
id: FG-114
type: story
status: done
title: Mount designDir read-only at /design inside agent containers
---

**Closed:** 2026-05-12. Caught preparing the System Map (#105) PRD run: the architect agent in `feature-ui-design-needed` / `feature-ui-design-provided` was being told to "read upstream design artifacts" pointing at host paths that the container had no way to reach. `--design-dir` set `run.metadata.designDir` and `inputs.designDir`, both as host paths — but `spawn.ts` only mounted `/project` and `/task`. The seed instruction to "Read them" was a lie; the architect would have bluffed past it. This was the root cause behind shaping the PRD differently — fixed at the spine layer instead.

**What shipped:**
- `SpawnOptions.designDir` (optional, host path). When set, spawn adds `-v <designDir>:/design:ro`. **Always read-only**, even for blue agents whose `/project` is rw — the design corpus is human-curated via Pencil on the host; agents never write into it.
- `dispatch.ts` reads `run.metadata.designDir` via new `designDirFor(run)` helper and passes through to both `spawn()` (blue) and `spawnRed()` (red).
- `spawnRed.ts` propagates `designDir` to `runOneRed` → `spawn()` so reds reviewing design-adjacent artifacts (frontend, UI architecture) can read the same canonical PNGs/HTML the human approved.
- `seeds/agents/architect/CLAUDE.md` — explicit instruction: design corpus is at `/design` inside the container; translate host paths from `inputs.upstream[*].result.{html,png}Files` and `inputs.designDir` to `/design/<relative>` before reading.
- `seeds/agents/prompt-author/CLAUDE.md` — `inputs.designDir` clarified as **host path**: use it for paths *in the PROMPT.md you produce* (human-on-host Pencil runs that), but for in-container reads (e.g. inspecting existing PNGs per #80) use `/design`.
- Three new buildDockerArgs tests covering: no mount when unset, mount with `:ro` when set, mount stays `:ro` even when `readOnlyProject: false`.

**Forward-only.** Existing seeds had been *telling* agents to read host paths; if any actually tried, the failure was silent (file not found, agent improvises around it). Now the seeds give an honest container path. No DB migration; runs created before #114 simply don't get a `/design` mount (their architects never tried to read from it anyway).

**Out of scope:** rewriting `inputs.designDir` itself to be the container path. That would diverge from `run.metadata.designDir` (which submit and dashboard use as host paths) and force a translation layer for prompt-author (which generates PROMPT.md with host paths for human-on-host execution). Two paths to know about is the right shape: one for human-environment context, one for in-container reads.

349/349 tests passing (was 346, +3). Typecheck green.

### #102, #101 — minimap + side panel closed: not in the designs
**Closed:** 2026-05-12 during System Map design review. The new designs (system-map.png, system-map-fanout.png, system-map-reds-detail.png) don't include either a minimap or a side panel. The designer's call is one view, draggable, no secondary surfaces. If real-run density makes a "where am I" affordance necessary later, file fresh — the old `ycyNE` (minimap) and `UTf00` (side panel) components in the .pen library are stale-but-not-deleted.
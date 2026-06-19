---
id: FG-335
type: story
status: active
title: install-seeds cp -n leaves ~/.forge runtimes/seeds drifting from repo after first install
created: 2026-06-19
---

**Found:** debugging a pi-groq invoke on 2026-06-19. `forge invoke --profile pi-groq` resolved provider=groq correctly (manifest confirmed), but pi was dispatched with `--provider anthropic` and the GROQ key was ignored. Root cause: the INSTALLED `~/.forge/runtimes/pi-apikey.yml` was the pre-#265 version that hardcodes `--provider anthropic`; the repo seed had been updated to `${UPSTREAM_PROVIDER:-anthropic}` but `install-seeds.sh` uses `cp -n` (no-clobber), so the installed copy was never refreshed. Source (#265/#303) was correct; the stale installed YAML defeated it.

**Systemic, not one-off:** every seed updated after a host's first install silently drifts — runtimes, agents, constraints, forge-raci.md. `loadRuntime` reads `~/.forge/runtimes/`, not repo `seeds/`, so the running behavior can lag committed source indefinitely with no signal.

**Proposed:** `forge upgrade` (and/or `forge doctor`) should detect seed-newer-than-installed drift and refresh `~/.forge/runtimes/` (+ warn for agents/constraints/raci, which may carry user edits). A blanket `FORCE=1 install-seeds` is unsafe — it clobbers user-customized `~/.forge/model-policy.yml` etc. Needs selective, drift-aware refresh.

**Workaround used:** `cp seeds/runtimes/pi-apikey.yml ~/.forge/runtimes/`.

Relates: #258 (pi runtime), #265, #303, #306 (doctor/upgrade follow-ups).

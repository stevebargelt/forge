---
id: FG-229
type: story
status: done
title: forge upgrade doesn't rebuild the agent image or check provider auth — Codex upgrades silently incomplete
---

**Closed:** 2026-06-07.

**Shipped (commits 8ba7c8b, 7c3e318, 96b7605, b613fe8, 018d407, 3c40661):** `forge doctor` — read-only release-readiness check (agent image present/stale/missing, in-image runtime CLIs claude/codex/pi from workspace+project+policy-named runtimes, per-profile host auth, model-policy + routing-policy validity) backed by a pure, fixture-tested `buildReleaseReport`. `forge upgrade` gains `--rebuild-image` (runs `bash docker/build.sh`) and an automatic read-only release-check tail. Docker-flake handling (transient inspect retry; daemon-unreachable → skip, not a false missing-image fail); default-reachable profiles block on missing creds, opt-in profiles warn; project-local `.forge/model-policy.yml` respected. 28 tests; full suite green; verified live (this host reports OK with image+CLIs+codex auth green).

**Closed by explicit human override of the review-loop's non-closeable verdict.** All acceptance criteria are met and tested, the full suite is green, and the loop's remaining findings are adjacent polish, not release blockers — the Codex reviewer (with the #305 adjacent-surface rubric) surfaced one new adjacent finding per round and never converged within the bound. Residual items filed as **#306** (quick-start.md docs + RUNTIME_BINDING CLI-expectation row).

Surfaced while documenting the AWN-7 Walk upgrade path. `forge upgrade` does: git pull, npm install, FORCE=1 install-seeds, re-init CLAUDE.md. It does NOT rebuild the agent-dev-worker image or check provider auth.

The bite: install-seeds now ships seeds/runtimes/codex-subscription.yml, so after `forge upgrade` an openai/subscription profile RESOLVES fine — but the agent image still lacks the `codex` CLI until `docker/build.sh` runs. The container then fails at exec (codex: not found) with no hint that the image is stale. Same class of gap the first pipeline smoke hit (runtime seed present, but not wired).

Proposals (any subset):
- `forge upgrade` detects image staleness (e.g. compare a Dockerfile hash / label against the installed image) and warns, or runs docker/build.sh behind a --rebuild-image flag.
- `forge providers doctor` (or a new `forge doctor`) checks that each runtime referenced by RUNTIME_BINDING has its CLI present in the image, not just that host auth exists.
- Document the image-rebuild + `codex login` steps in how-to-upgrade.md (currently silent on both).

Low-risk, operability-only. Tie-in: AWN-7 Walk (#224, codex runtime), how-to-upgrade.md.
**Last session ended 2026-06-19** (second session that day).

**Where we left off:** Fixed the 3 long-standing BACKLOG-parser test failures, then did the Node/sqlite unification the prior notes flagged as loose-end #2 — and it cascaded further than expected. 5 commits, all pushed to origin/main (fdf6410..65c8a36). Three tickets closed: FG-333, FG-334, and (bonus) FG-300.

**Picked up next:**
1. No forced direction. The pi Crawl exit is now genuinely proven (FG-300 closed via a live completing run), so **FG-258** (provider-agnostic runtime epic) could advance to its Walk items if you want to push that thread.
2. Housekeeping when confident: `docker image prune` to reclaim the old Node-20 agent image (untagged `66f741f50a15`), and reinstall/rebuild native modules in any OTHER host repo next time you work in it (nvm default is now Node 24).
3. Otherwise pick from `forge backlog list --status active` (FG-291 baseline epic, etc.).

**External state to remember:**
- **nvm default is now Node 24** (v24.17.0). The forge CLI REQUIRES Node 24 — better-sqlite3 is now v12 (binding NODE_MODULE_VERSION 137). Login/interactive shells resolve 24 correctly; but non-login/automation shells on this host may land on Node 20, which makes the binding fail to load (`NODE_MODULE_VERSION 137 vs 115`). In scripts, `nvm use 24` explicitly before any forge/node command.
- Repo is now real npm workspaces (root + dashboard) with a SINGLE hoisted better-sqlite3@12.11.1. The old Node-20-CLI / Node-22-dashboard split is gone. `.nvmrc`=24, root `engines`>=22.
- Live agent image `agent-dev-worker:latest` = Node 24 + pi 0.79.8 (+ codex 0.135.0, tsx 4.22.4, claude 2.1.183). Side tag `agent-dev-worker:fg334` is the same image. Old `66f741f50a15` is untagged rollback.
- pi OAuth credential minted at `~/.forge/pi-agent/auth.json` (via `forge pi login`). pi-oauth runtime works end-to-end.
- `docker/build.sh` now builds Node 24 + pi 0.79.8 to the live tag — a plain rebuild reproduces the current image.

**Decisions worth not relitigating:**
- better-sqlite3 was unified UP to v12 (supports Node 20–26), NOT pinned down to v11. Reason: v12 ships no Node-20 prebuilt, so v12-on-Node-20 forces a from-source build that hits the macOS Xcode-clang/SDK gotcha; Node 24 HAS a v12 prebuilt, so moving forward was the clean path, not back.
- Node target is 24 LTS — deliberately not the newer non-LTS lines (25/26-current). Revisit when 26 goes LTS (Oct 2026) if desired.
- The legacy single-file BACKLOG.md parser is still LIVE (forge backlog / review-loop read it for legacy-format projects); its tests now use a committed fixture (`src/backlog/__fixtures__/legacy-backlog.md`) instead of this repo's deleted root BACKLOG.md.

**Shipped (for reference):**
- 8c3b500: parser roundtrip tests → committed fixture (fixes the 3 ENOENT failures)
- ab3f071: FG-333 — unify repo on Node 24 LTS + better-sqlite3 v12 (closed)
- 37027ca: FG-334 — agent image → Node 24, pi → 0.79.8 (closed)
- 65c8a36: close FG-334 + FG-300 — live pi 0.79.8 run verified (run-…-58c294 / task-engineer-3a8c1f: status complete, 7 non-zero model_calls rows, no #264 misfire)

---
id: FG-146
type: story
status: done
title: Engineer container missing pnpm (and likely yarn) on PATH — forces per-run workarounds
---

**Closed:** 2026-05-25. Commit `5913c1b5a7b26ec0e39b8c9f42f1da0eecb36ca0`.

Filed 2026-05-25. Recurring per-session friction on pnpm-based projects.

**Problem.** The agent-dev-worker container ships with Node 20 + npm but not pnpm. Any project using pnpm as its package manager (e.g. harebrained-apps, modern Next.js projects) hits this — the engineer cannot run the project's test commands until they self-install pnpm, OR they substitute a different validation path and leave a gap.

**Evidence.** Two engineer runs in one orchestration session against harebrained-apps (2026-05-25) both reported the issue:
- Run \`run-remove-dead-output-standalone-from-next-config-ts-cd2093\`: engineer worked around by running \`npm install -g pnpm\` into /home/agent/.npm-global/bin mid-task. Tests subsequently passed.
- Run \`run-backlog-6-resolve-pre-existing-eslint-errors-61116c\`: engineer skipped \`pnpm test:e2e\` entirely and substituted \`node_modules/.bin/eslint src/\` + \`tsc --noEmit\` for validation, noting "pnpm is unavailable in this container."

**Impact.** Lose-lose decision per engineer run on pnpm projects:
1. Accept the substitute validation (lint + tsc only) → partial seed compliance; orchestrator must judge whether the change touches the e2e surface and possibly run e2e on the host.
2. Reject and re-run → token waste for what was a reasonable substitution.

**Fix.** Add pnpm to docker/agent-dev-worker.Dockerfile via \`npm install -g pnpm@<pin>\`. One-line addition + image rebuild. Pin a specific major version for reproducibility (pnpm 10 is current at filing time).

Also worth adding: \`yarn\` (Yarn 1 / classic). Many older projects still use it; same one-line install pattern. Skip \`bun\` for now — it's a separate runtime, conflicts more, can add later if a project actually needs it.

**Sizing.** Tiny. One Dockerfile edit, one image rebuild (5-10 min), one smoke test that \`pnpm -v\` works in a fresh container, commit.

**Caught:** 2026-05-25 during back-to-back harebrained-apps runs.
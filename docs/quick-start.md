# Quick start

End-to-end: install → first run → gate → result. Uses `run-litellm-eval` throughout.

## 1. Install

```bash
cd ~/code/forge
npm install
./scripts/install-seeds.sh
./docker/build.sh           # one-time, ~5–10 min
```

`install-seeds.sh` copies the default agent role directories and example constraints into `~/.forge/`. `docker/build.sh` builds the `agent-dev-worker` image (Ubuntu 22.04 + Node 20 + Claude Code CLI + git/jq/playwright + agent UID 1000).

## 2. Set up credentials

Three modes (FORGE-DEC-007). Forge auto-selects based on environment:

### Personal Mac (Anthropic Pro, includes Opus 4.7)

```bash
./bin/forge auth login
```

This launches an interactive `claude` inside an agent container. Run `/login` at the prompt, follow the browser flow, then `/exit`. Credentials persist in docker volume `forge-claude-oauth` and are reused on every subsequent agent spawn.

Verify with `forge auth status`. To switch accounts, `forge auth logout` then `forge auth login` again.

### Work machine (Bedrock — Sonnet/Haiku, no Opus)

```bash
aws sso login --profile adx-dev
. ./scripts/use-bedrock.sh         # exports AWS_* and CLAUDE_CODE_USE_BEDROCK=1
```

Sourcing (not running) the script is required so the env vars stay set in your shell. Re-source after `aws sso login` whenever your SSO session expires.

For runs longer than ~1h, set `FORGE_SSO_WATCHDOG=/path/to/run-sso-watchdog.sh` and forge starts it as a child process when a run begins.

### API key (escape hatch)

```bash
export ANTHROPIC_API_KEY=sk-...
```

## 3. Create a run

```bash
./bin/forge new investigation "litellm-evaluation" \
  --question "Does LiteLLM solve provider routing and aggregate cost tracking for our harness?"
```

Output:
```
Created run run-litellm-evaluation-96a1da
Workflow: investigation
Title:    litellm-evaluation
First phase: frame (1 task(s) seeded)

Next: forge next run-litellm-evaluation-96a1da
```

Note your run id — you'll use it for every subsequent command.

## 4. Dispatch the first phase

```bash
./bin/forge next run-litellm-evaluation-96a1da
```

Forge picks up the pending `frame` task, launches an agent container, captures the result. The framer produces the claims and experiments that drive the investigation.

While running:
```
Run run-litellm-evaluation-96a1da: 1 task(s) running.
  ⟳ task-frame-f68eb8 (frame/framer)
```

When done:
```
Run run-litellm-evaluation-96a1da: 1 task(s) awaiting gate.
  ⚠ task-frame-f68eb8 (frame)  →  forge gate task-frame-f68eb8 advance | reject | request-changes
```

## 5. Review and gate

```bash
./bin/forge show task-frame-f68eb8
```

Shows the framer's claims and experiments. If the framing is good:
```bash
./bin/forge gate task-frame-f68eb8 advance
```

Forge creates one investigator task per claim under the next phase.

## 6. Continue

```bash
./bin/forge next run-litellm-evaluation-96a1da
```

The investigators fan out (default `maxConcurrency: 4`). Each gets its claim as input. Reds run after each investigator (wide + narrow, parallel, specialist authority — they inform the gate but don't block).

After all investigators complete:
```
Run run-litellm-evaluation-96a1da: 5 task(s) awaiting gate.
  ⚠ task-investigate-... (investigate)  →  forge gate ...
  ...
```

Gate each one with `advance`, `reject`, or `request-changes --rationale "..."`. The run can't move to the next phase until every sibling is gated.

## 7. End of run

The synthesize and recommend phases run the same way. After `recommend` completes (auto-gate), the run is marked `complete`.

```bash
./bin/forge status run-litellm-evaluation-96a1da
```

shows the full task graph with verdicts. Output documents live at `~/.forge/runs/run-litellm-evaluation-96a1da/<task-id>/result.json`.

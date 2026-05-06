# How-to: start an investigation workflow

Use this for structured multi-phase research with verdicts and an audit trail. For a lightweight one-shot investigation, use the host-side `/research` skill instead.

## Example

```bash
./bin/forge new investigation "litellm-evaluation" \
  --question "Does LiteLLM solve provider routing and aggregate cost tracking for our harness?"
./bin/forge next run-litellm-evaluation-<suffix>
```

No `--project` is required — investigation agents don't need a project mount.

## Phase walkthrough

### 1. `frame`

Single task: the framer reads your question and produces structured claims + experiments.

Output: `{claims: string[], experiments: string[]}`.

Gate: `human`. Review with `forge show`, then advance:

```bash
./bin/forge gate task-frame-<suffix> advance
```

On advance, forge fans out one investigator task per claim under the next phase.

### 2. `investigate`

One task per claim, up to 4 parallel by default. Each investigator validates its claim against concrete evidence (read code, run shell commands inside the container).

Output: `{claim, evidence, conclusion: "supported"|"refuted"|"inconclusive", notes}`.

Reds: wide + narrow, specialist authority — they probe each finding for "did the investigator actually validate this, or just read docs?" Verdicts inform the gate but don't block.

Gate: `human` per task. Each investigator must be gated independently. Forge will not advance to `synthesize` until all five investigate tasks are gated.

```bash
./bin/forge gate task-investigate-001 advance
./bin/forge gate task-investigate-003 advance --rationale "narrow red flagged thin evidence; accepting"
./bin/forge gate task-investigate-004 reject --rationale "cost tracking work_id incomplete"
# ... etc
./bin/forge next run-litellm-evaluation-<suffix>
```

### 3. `synthesize`

Single task: the synthesizer reads all five investigate outputs and the original question, produces an integrated synthesis.

Output: `{architecturalImplications, antiFindings, openQuestions}`.

Reds: wide + narrow, specialist authority. Gate: `human`.

### 4. `recommend`

Single task: the recommender produces the final markdown verdict document.

Output: `{recommendation: "<full markdown>"}`.

Gate: `auto`. The run completes automatically.

## Where output lands

`~/.forge/runs/run-litellm-evaluation-<suffix>/<task-id>/result.json` for each task. The recommender's markdown is in the `recommendation` field of its result.

To rebuild a final document on the host:

```bash
jq -r '.recommendation' ~/.forge/runs/run-litellm-evaluation-<suffix>/task-recommend-<suffix>/result.json > litellm-verdict.md
```

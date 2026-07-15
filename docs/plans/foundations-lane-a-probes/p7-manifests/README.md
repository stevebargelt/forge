# P7 raw runtime-identity evidence — for strict-reviewer inspection

These are the DURABLE artifacts backing `p7-red-runtime-capability.out` SECTION 1. They are materialized here
because a containerized reviewer mounts only `/project` and cannot read host `~/.forge/runs/`. A reviewer MUST
verify runtime identity from these raw files, NOT from the probe summary. **Any expected/actual mismatch is an
automatic finding.**

## What to verify per arm

| File | Expected `runtime.name` | Expected `runtime.kind` | Expected `model.resolvedBy` | Expected `logFormat` |
|------|-------------------------|-------------------------|-----------------------------|----------------------|
| `codex-subscription.manifest.json` | `codex-subscription` | `codex` | `cli.--profile` | `codex-jsonl` |
| `claude-oauth.manifest.json` | `claude-oauth` | `claude-code` | `cli.--profile` | `claude-stream-json` |

For each manifest, confirm ALL of: `runtime.name`, `runtime.kind`, `runtime.logFormat`, `model.profile`,
`model.runtime`, `model.resolvedBy`, and `controlPlane.runtime.{name,source,path}`. The two `path` values MUST be
different runtime YAMLs (`.../codex-subscription.yml` vs `.../claude-oauth.yml`).

Then confirm the stdout-head logs carry DISTINCT, runtime-specific first-line signatures (proof the two are not
the same runtime twice):
- `codex-subscription.stdout-head.log` → line 1 begins `{"type":"thread.started",...}` (codex-jsonl)
- `claude-oauth.stdout-head.log`       → line 1 begins `{"type":"system","subtype":"init",...}` (claude-stream-json)

## Pi

`pi-groq.FAILURE.txt` — Pi is NOT dispatchable as a red on this host (tool-capability gate; no container, no
manifest). Confirm there is no Pi manifest and no Pi execution is claimed anywhere.

## The original failure this correction fixes (audit trail)

`ORIGINAL-FAKE-claude-label.manifest.json` and `ORIGINAL-FAKE-pi-label.manifest.json` are the manifests of the
FIRST probe's runs that were LABELLED claude / pi but actually resolved to codex-subscription. Confirm both show
`runtime.name = codex-subscription` and `model.resolvedBy = overrides.agents.red-wide` — i.e. `--runtime` was
overridden by the policy pin, which is exactly why the original three-runtime conclusion was invalid. This is the
concrete artifact-identity failure the fresh review exists to catch; these files let the reviewer see it directly.

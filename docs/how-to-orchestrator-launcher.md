# How-to: the interactive orchestrator launcher

Forge launches your interactive orchestrator session — the one that drives everything else — from the same
effective host/project model policy that already selects models for containerized task agents. Two commands
share one launcher:

| Command | What it does |
| --- | --- |
| `forge orchestrator` | Launches whichever interactive runtime **policy** selects. |
| `forge claude` | The explicit **Claude Code** shortcut. Same resolution, same receipt — but it launches Claude Code or nothing. |

They are not two implementations. Both resolve the orchestrator profile through the same stack, write the same
durable launch receipt before spawning, open the same liveness record after spawning, and close the same receipt
on exit. A fix to one is a fix to both.

> This page covers the launcher's operator surface as of FG-576 step 6. The full capability/parity matrix, the
> Codex recipe, and the per-provider resume semantics are documented alongside the Codex adapter.

## Inspect the choice before you launch

```bash
forge orchestrator --explain     # or: forge claude --explain
```

Prints the seven recorded fields — `profile`, `runtime`, `provider`, `model`, `auth`, `adapter`, `resolved_by` —
and **exits without spawning anything**. Nothing is recorded; `--explain` is an inspection surface, so a receipt
here would itself be a false record. `forge model resolve --agent orchestrator` answers the same question from
the policy side.

## How the profile is selected

Exactly today's precedence, with no new policy vocabulary:

```
CLI --profile  →  overrides.agents.orchestrator  →  defaults.activity.default  →  defaults.profile
                                                                              →  then that profile's map.default
```

`allowed_profiles` remains the autonomy ceiling and is enforced at the launch boundary. With no
`model-policy.yml` in effect at all, Forge still records a concrete provider and adapter for the launch — it just
records **no model**, because there is no policy to select one from, and inventing one would be a fabricated
selection.

## Flags Forge owns

These belong to Forge on both commands. Each reaches the child exactly once and is recorded with its own
`resolved_by`:

| Flag | Meaning |
| --- | --- |
| `--profile <name>` | A **model-policy profile**. Highest profile-selection precedence. |
| `--model <model>` | A concrete model override, validated against the selected adapter's vocabulary and recorded verbatim. Claude aliases (`opus`, `sonnet`, `haiku`, …) are accepted. |
| `--continue` / `-c` | Continue the provider's most recent session in this project. |
| `--resume <id>` | Resume a specific session by identifier. |
| `--explain` | Print the resolved choice and exit without launching. |
| `-n` / `--name <name>` | Override the project display identity for this session. |

`forge claude` additionally owns two Bedrock flags, which are extracted by Forge and never forwarded to `claude`:

| Flag | Meaning |
| --- | --- |
| `--bedrock` | Assert that this is a Bedrock launch. |
| `--aws-profile <p>` | The AWS profile a Bedrock launch uses. Precedence: `--aws-profile` > `.forge/project.json` `awsProfile` > `AWS_PROFILE` > `default`. |

### Passthrough, and what it may not do

Anything Forge does not own still reaches the provider CLI verbatim:

```bash
forge claude --add-dir ../shared-lib --permission-mode plan
forge orchestrator -- --add-dir ../shared-lib
```

Passthrough is **not** a second way to change the launch. A token that would set the provider, model, auth,
project root, instruction surface or session identity is refused before spawn, naming the flag and the Forge-owned
flag that owns that dimension. For Claude Code that means `--model`/`-m`, `--session-id`, `--resume`/`-r`,
`--continue`/`-c`, `--name`/`-n`, `--append-system-prompt[-file]`, `--system-prompt[-file]`, `--settings`, and
`--print`/`-p`.

The reason is receipt truthfulness: if passthrough could change the model, the recorded receipt would describe a
session other than the one running. `--print` is refused for the mirror-image reason — a non-interactive print run
under a receipt claiming a live interactive orchestrator is a false receipt.

## What `forge claude` refuses, and what to do about it

`forge claude` is a **provider shortcut**. It launches Claude Code, and it never silently launches something else
because policy changed — that is the point of having a shortcut at all. So when the orchestrator resolution is not
Claude-compatible, it exits non-zero **before spawning anything**, records nothing, and names what it found:

```
$ forge claude
forge claude: forge claude launches Claude Code only, but model policy resolves the orchestrator to
Codex CLI (provider 'openai') via profile 'codex-default'. Refusing rather than launching a provider
you did not select, or re-resolving to a Claude Code profile you did not choose.
Fix:
  - run `forge orchestrator` to launch what policy selected
  - or select a Claude Code-compatible profile for this launch: `forge claude --profile <profile>`
  - or set `overrides.agents.orchestrator` in the effective model-policy.yml to a Claude Code profile
```

Three remedies, in the order most operators want them:

1. **Launch what policy actually selected** — `forge orchestrator`. This is the right answer when the policy
   change was deliberate.
2. **Override for this launch only** — `forge claude --profile claude-subscription`. Nothing on disk changes.
3. **Change the selection** — set `overrides.agents.orchestrator` in the effective `model-policy.yml` to a Claude
   profile. This is the right answer when the policy change was not what you wanted.

Forge deliberately does **not** pick a Claude profile for you here. Re-resolving to "some Claude profile" would
launch a model and an auth mode you never chose, which is the failure this refusal exists to prevent.

`forge claude` refuses the same way, and with the same shape of message, when the resolved runtime has no
interactive adapter at all (for example a `pi-*` runtime), when an explicit `--model` is not in the adapter's
vocabulary, or when the selected provider's credentials are unavailable. Every refusal happens before spawn and
carries at least one concrete remedy.

### `--bedrock` against a non-Bedrock profile

`--bedrock` (and `.forge/project.json` `auth: bedrock`) is an **assertion** about the launch, not a hint. If the
resolved profile declares a different auth mode, `forge claude` refuses rather than launching one credential mode
under a receipt recording another. Select a Bedrock profile (`--profile`), point
`overrides.agents.orchestrator` at one, or drop the assertion and launch what policy selected.

The SSO/STS preflight findings for a Bedrock launch remain **advisory only**: they are printed, and the launch
proceeds. An interactive session handles its own auth failure natively, so Forge never exits non-zero for them
(FG-499).

## What gets recorded

Before anything is spawned, Forge persists a launch receipt in the `pending` state carrying the resolved profile,
runtime, provider, concrete model, auth mode, adapter, `resolved_by`, project directory and display identity, the
requested session operation, the session-identity strength, the instruction-carrier provenance, and any recorded
capability limitation.

- If the receipt **cannot be written**, Forge refuses and spawns nothing. The message names the write target and
  the retry. An orchestrator Forge cannot record is not launched.
- The receipt becomes `running` only after a **confirmed** spawn, at which point the launcher-owned liveness
  record appears.
- Child exit, a signal, and a spawn failure all close the same receipt honestly.
- A launcher that dies mid-session writes nothing — its record is then classified `orphaned` by process identity.
  `orphaned` asserts that **launcher ownership was lost**; it does not claim the interactive session ended.

## Upgrading from the old `forge claude`

Before FG-576, `forge claude` passed its whole tail to `claude` verbatim, never resolved a model, and recorded
nothing. Three things change:

- **A model is always selected explicitly** from policy (or from `--model`). Claude Code's ambient default is
  never inherited.
- **The command can now refuse** — under a non-Claude-resolving policy, and for a passthrough token that sets a
  dimension Forge owns. Both refusals name their remedies.
- **`--model`, `--continue`, `--resume`, `-n`, `--profile` are parsed by Forge** rather than forwarded blindly.
  Existing aliases such as `forge claude --model opus --continue` keep working unchanged; they are simply recorded
  now.

## See also

- `docs/how-to-model-policy.md` — the profile/precedence model these commands resolve through.
- `docs/how-to-project-auth.md` — per-project auth configuration.

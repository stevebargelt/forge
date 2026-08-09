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

Both Claude Code and Codex CLI ship as interactive adapters. Which one runs is a **policy decision**, not a
per-command choice — see [Make Codex your interactive orchestrator](#make-codex-your-interactive-orchestrator)
below for the one-line recipe, and [The capability/parity matrix](#the-capabilityparity-matrix) for exactly what
Codex does and does not do relative to Claude.

## Inspect the choice before you launch

```bash
forge orchestrator --explain     # or: forge claude --explain
```

Prints the seven recorded fields — `profile`, `runtime`, `provider`, `model`, `auth`, `adapter`, `resolved_by` —
and **exits without spawning anything**. Nothing is recorded; `--explain` is an inspection surface, so a receipt
here would itself be a false record. `forge model resolve orchestrator` answers the same question from the
policy side (the agent role is a positional argument, not a flag), and additionally reports whether the resolved
model is `dispatchable` from this host.

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

## Make Codex your interactive orchestrator

Add one line to the effective `model-policy.yml` (host `~/.forge/model-policy.yml`, or project
`<project>/.forge/model-policy.yml` — project wins):

```yaml
overrides:
  agents:
    orchestrator: codex-subscription
```

That's the whole change. No Forge source edit, no shell alias, no per-project repetition — every project on this
host that does not set its own `overrides.agents.orchestrator` now gets Codex from `forge orchestrator`. The
profile named must map runtime `codex-subscription` (provider `openai`, ChatGPT-subscription auth); Forge ships
that runtime binding closed, so a profile naming any other runtime for this role is refused as
`unsupported-runtime` (see [Failure behavior before spawn](#failure-behavior-before-spawn)).

`forge claude` does **not** follow this change — it is the explicit Claude Code shortcut, and a shortcut that
silently started launching a different provider because policy changed would defeat the point of having a
shortcut at all. See [What `forge claude` refuses, and what to do about it](#what-forge-claude-refuses-and-what-to-do-about-it).

Confirm the selection before you launch anything:

```bash
forge orchestrator --explain
#   ...
#   adapter      codex
#   provider     openai
```

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

### Credential environment variables are isolated per adapter

The child's environment is composed from the parent one entry at a time, not inherited wholesale — each adapter
withholds the variables that could move the session onto credentials its own receipt does not describe:

- **Claude Code.** `CLAUDE_CODE_USE_BEDROCK`, `AWS_PROFILE`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are each
  withheld unless the resolved auth mode actually calls for them — a shell with `CLAUDE_CODE_USE_BEDROCK=1` armed
  for something else does not move a policy-selected `subscription` or `api` launch onto Bedrock.
  `CLAUDE_CODE_USE_VERTEX` is withheld unconditionally, because Forge resolves no Vertex auth mode a receipt could
  truthfully describe. When the shell disagrees with the resolved auth this way, `forge claude` prints an advisory
  naming the mismatch and that the variable was withheld — never a silent override of what the receipt records.
- **Codex CLI.** The entire `CLAUDE_`, `ANTHROPIC_` and `AWS_` families are withheld unconditionally, by prefix —
  an operator's shell primed for `forge claude` (Bedrock profile, API key, …) cannot leak a Claude credential into
  a Codex session that has no use for it.

Everything else in the parent environment — the operator's own toolchain, unrelated tool state — passes through
unchanged; this is a credential-selection denylist, not an allowlist that would strip tools Forge knows nothing
about.

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

## New, continue and resume — per provider

`--continue`/`-c` and `--resume <id>` mean the same thing on both commands; how strongly Forge can bind the
resulting session's identity is a property of the provider, not of the command:

| Operation | Claude Code | Codex CLI |
| --- | --- | --- |
| **New** (default) | Forge mints a session id and asserts it via `--session-id` **before** spawn — the receipt owns the identity from the start. | Codex has no `--session-id` equivalent, so nothing is asserted before spawn. Forge correlates the identity **after** spawn from the session Codex itself records; two Codex sessions started in the same project inside the correlation window record identity strength `ambiguous` rather than a guess. |
| **`--continue`** | Maps to Claude's own `--continue`, which picks the conversation. No new session appears to correlate, so this launch's provider identity is not recorded. | Maps to `codex resume --last`. Same limitation: Codex chose the session, so nothing new exists to correlate. |
| **`--resume <id>`** | Maps to `--resume <id>`, refused first if `<id>` is not a safe identifier (`unsafe-session-identifier`). | Maps to `codex resume <id>`, same identifier-safety refusal. |

**Cross-provider resume is always refused.** The identifier is looked up in the **durable receipt that minted
it**, never guessed from its shape — both providers mint bare UUIDs, so a format check could not tell them apart
even if Forge wanted it to:

```
$ forge orchestrator --resume 6f2c...
forge orchestrator: session '6f2c...' was launched by Forge under the claude-code adapter (provider
'anthropic', runtime 'claude-oauth'), so it cannot be resumed in Codex CLI. Resume is provider-bound...
Fix:
  - resume it with its own provider: `forge orchestrator --resume 6f2c...` under a policy that resolves
    the orchestrator to 'claude-oauth'
  - or start a fresh Codex session with `forge orchestrator`
```

An identifier Forge has no receipt for is not refused — the resume proceeds "on the operator's word," and the
new receipt records that Forge did not mint the identifier.

**Policy drift on resume is real, and only sometimes refused.** Every launch — including a resume — resolves the
profile from **today's** effective policy, exactly like any other dispatch (see
[how-to-model-policy.md](how-to-model-policy.md)). If policy changed since the session you're resuming started:

- a resume that would now land on a **different provider** than the one the session was minted under is refused
  with the cross-provider message above, never silently redirected;
- a resume that stays on the **same provider** but a different profile or model proceeds — you get today's
  policy's model, not the model the original session ran under. `forge orchestrator --explain --resume <id>` shows
  what a resume would resolve to before you commit to it.

## The capability/parity matrix

Claude Code and Codex do not supply the same capabilities. Forge names every gap rather than smoothing it over —
constructing an argument is never treated as evidence a capability was honored.

| Capability | Claude Code | Codex CLI |
| --- | --- | --- |
| **Instruction source** | Forge's orchestrator policy is **appended** to Claude's own base instructions via `--append-system-prompt-file`; your `CLAUDE.md` is never spliced. | **Evidence-gated.** A Forge-owned carrier is bound per launch via a Codex config override, **substituting** (not appending to) the base instruction surface — and only after a positive pre-spawn probe proves the installed `codex` build honors it (AC8). Constructing the flag is not evidence it worked; see `adapter-not-ready` below. |
| **Skills and slash commands** | Forge-installed skills and slash commands are available (`forge init` publishes them). | **Partial.** The same provider-neutral `/orient` / `/handoff` definition is rendered into repository-scoped Codex skills (`forge-orient`, `forge-handoff`) under the project's own `.agents/skills/`, installed and refreshed by `forge init` / `forge upgrade`; the Codex instruction carrier advertises them from that same definition. But writing the file is not evidence the running Codex build loaded it — repository-scoped skill discovery is version-coupled, and an older build ignores the directory silently, the same failure shape as a `-c` override that is accepted and then ignored. Forge has no positive probe for skill discovery, so activation is **unverified, never claimed**; a session that cannot activate the skill runs the workflow through the `forge` CLI directly, which is the interface either way. |
| **Permission / approval mode** | Operator-owned. Claude's own permission mode / `.claude/settings*.json` decide; Forge reads but never overwrites them. | Operator-owned the same way. Codex's own approval/sandbox mode decides; Forge never writes into the operator's Codex config root. |
| **Authentication** | `anthropic` only — OAuth subscription, API key, or Bedrock, each with its own preflight. | `openai` only — the ChatGPT-subscription credential. **Partial:** an API-key Codex profile has no availability probe and resolves as `unknown` rather than `available`. A Codex credential is never evidence Claude may launch, and the inverse also holds. |
| **New / continue / resume** | **Supported** — session identity is **asserted** pre-spawn via `--session-id`. | **Partial** — session identity is **correlated** after spawn (or `ambiguous` when two sessions overlap), because Codex cannot be told its session id before spawn. |
| **Heartbeat / liveness** | **Supported** — launcher-owned process liveness, plus Claude's own Stop hook supplies interaction evidence on top of it. | **Partial** — the same launcher-owned process liveness, but Codex supplies **no hook**, so interaction evidence is absent and reads as `unknown`. Absence of a provider hook is never reported as healthy liveness. |
| **Post-session usage capture** | **Supported** — usage rows are read from the transcript identified by the receipt's asserted session id. | **Unsupported.** Codex exposes no equivalent authoritative usage evidence. The limitation is a recorded value on the receipt; no token counts or costs are fabricated. |
| **Remote-control link** | **Evidence-gated** — captured only when the live adapter exposes a URL, held against the receipt for the life of the session, served only on a loopback bind (never durable, never cross-project). | **Unsupported.** No remote-control link is captured, offered, or implied for a Codex orchestrator, even though the installed `codex` build may ship its own experimental remote-control surface — FG-576 claims none, because no independently supported evidence exists here. |
| **Shutdown / close-out** | **Supported** — child exit, signal and spawn failure each close the same receipt honestly; a lost launcher records `orphaned` (launcher-ownership loss only, never "session ended"). | **Supported** — identical launcher-owned close-out through the same shared primitive; neither adapter owns its own lifecycle, so the two cannot drift apart. |

`forge orchestrator --explain` and the receipt itself carry the same limitations, in the operator's own terms, for
whichever adapter is selected.

### Orientation/handoff adapters, and the generation-split advisory

`/orient` and `/handoff` are defined once, provider-neutrally, in `src/v2/operator-workflows.ts` and rendered onto
each provider surface — Claude Code slash commands under `.claude/commands/`, Codex repository-scoped skills under
`.agents/skills/forge-orient/` and `.agents/skills/forge-handoff/`. See
[Operator adapters](concepts.md#operator-adapters-orient-handoff) in `docs/concepts.md` for the full
rendering/ownership model, and `docs/quick-start.md` §3 for what `forge init` installs.

Forge owns `$FORGE_HOME`; it does not own the project repo, so the sha-pinned generation a launch resolves and the
adapter files installed in the project can go out of agreement — a clone, a promoted release, or a moved checkout
can each happen without forge being run in between, and nothing makes the two writes atomic. What Forge can do is
refuse to be silent about it: every launch (whether started as `forge claude` or as `forge orchestrator` resolving
to either adapter) checks whether the project's installed adapters agree with the generation this session resolved
and records the disagreement — a different stamp, a file the surface advertises but doesn't find, a file with no
forge ownership marker at all — as a capability limitation on the launch receipt, so `forge show` can still answer
the question after the session ends. A **Claude Code** launch additionally prints it as a console advisory before
the banner, naming exactly how the two disagree; a Codex launch today only records it on the receipt. Either way
it is **always advisory**: the session launches regardless, no exit code moves, and stale orientation prose is
misleading guidance, not a mis-run. Every line of this advisory also repeats that installed bytes are not evidence
a provider loaded them — see [The capability/parity matrix](#the-capabilityparity-matrix) above.

**FG-347 is deferred by this ticket (FG-253), not answered.** FG-253 renders and installs `/orient` and `/handoff`
as described above; it does not introduce marker-based ownership anywhere else. Operator-owned regions stay
byte-untouched — no marker discipline is introduced into `AGENTS.md`, `CLAUDE.md` prose outside the fenced
orchestrator block is never read or spliced, and the documentation-maintainer's correction path over prose outside
generated regions is unchanged. Whether `AGENTS.md` or other operator-owned surfaces should ever gain the same
generated/marked-region treatment these two files have is FG-347's question, not this one's.

## Failure behavior before spawn

Every failure mode below happens **before the interactive session is represented as a live Forge orchestrator** —
Forge never substitutes another provider, another model, or an ambient CLI default. Two boundaries account for
every refusal:

**Resolution refusals** (nothing is recorded at all — the failure is in the policy/CLI-override decision itself):

| Code | Fires when |
| --- | --- |
| `policy-error` | `model-policy.yml` exists but cannot be parsed/loaded. |
| `unknown-profile` | `--profile <name>` names a profile not defined under `model_profiles`. |
| `no-capability-mapping` | The selected profile has no `default` entry in its `map`, so no concrete model can be chosen. |
| `profile-not-allowed` | The selected profile is not in `allowed_profiles` (the autonomy ceiling). |
| `unsupported-runtime` | The resolved runtime has no interactive adapter — a `pi-*` runtime, or anything outside `claude-oauth` / `claude-apikey` / `claude-bedrock` / `codex-subscription`. |
| `provider-pin-mismatch` | A provider shortcut (`forge claude`) resolved to a different, incompatible provider — this is D16's `forge claude` refusal. |
| `model-not-accepted` | An explicit `--model` is not in the selected adapter's vocabulary (a Claude alias sent to Codex, or vice versa; an empty value; whitespace; an operand-shaped string). |
| `auth-unavailable` | The selected provider/auth combination has no working credential in this environment (`forge providers doctor` shows the same probe). This is a hard pre-spawn refusal — distinct from the advisory-only Bedrock SSO/STS staleness warnings above, which never block. |
| `invalid-session-operation` | `--resume` was passed with an empty session id. |

**Launch-boundary refusals** (the decision resolved cleanly; the launch itself cannot proceed):

| Code | Fires when |
| --- | --- |
| `adapter-unavailable` | The resolved runtime names an adapter this build of forge ships no implementation for. |
| `adapter-not-ready` | A provider-specific readiness probe found a positive reason not to launch — for Codex, an installed build below `0.144.0` (AC8's evidence gate: that build would silently ignore the Forge-owned instruction carrier); for `forge claude`, an explicit `--bedrock` assertion that disagrees with the resolved profile's auth. |
| `passthrough-not-permitted` | A token after `--` targets a flag Forge owns (model, auth, project root, instruction surface, session identity) — D6's guard. |
| `unsafe-session-identifier` | `--resume <id>` is not a safe identifier (must start with a letter/digit; only letters, digits, `.`, `_`, `-`). |
| `conflicting-session-operation` | Both `--continue` and `--resume <id>` were passed. |
| `cross-provider-resume` | `--resume <id>` names a session the durable receipt shows was launched under the *other* adapter. |
| `receipt-unwritable` | The launch receipt itself could not be persisted (D11) — the message names the store and the retry. Nothing is recorded and nothing is spawned. |
| `liveness-unwritable` | The liveness namespace could not be prepared before spawn. The just-created pending receipt is closed `spawn_failed`; still nothing is spawned. |
| `carrier-unwritable` | The Forge-owned instruction file could not be written to disk. Same closure as above. |

**An unavailable CLI binary** (e.g. `codex` or `claude` not on `PATH`) is not caught by either table above — the
receipt is already `pending` by that point. The spawn attempt itself fails, node's `error` event fires instead of
`spawn`, and the receipt closes `spawn_failed` with the real OS error (never registered as `running`). The
operator sees `failed to spawn <executable> — <error>` and a reminder to check `PATH`.

Every refusal above prints at least one concrete remedy — never a bare "incompatible" report — and `forge
orchestrator --explain` (or `forge model resolve orchestrator`) lets you see the effective choice before you hit
any of them.

## What gets recorded

Before anything is spawned, Forge persists a launch receipt in the `pending` state carrying the resolved profile,
runtime, provider, concrete model, auth mode, adapter, `resolved_by`, project directory and display identity, the
requested session operation, the session-identity strength, the instruction-carrier provenance, and any recorded
capability limitation.

- If the receipt **cannot be written**, Forge refuses and spawns nothing. The message names the write target and
  the retry. An orchestrator Forge cannot record is not launched.
- The receipt becomes `running` only after a **confirmed** spawn, at which point the launcher-owned liveness
  record appears. If that write itself fails, refusing is no longer available — the child is already up — so
  Forge holds it and retries at close-out instead: the operator sees an advisory that the session is running
  ahead of its receipt, and the receipt still closes honestly (rather than being stranded `pending` forever) once
  the session ends.
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

## Manual live smoke (optional — not a CI gate)

Every automated test for this launcher runs against a **fake** `claude`/`codex` executable and a disposable
`FORGE_HOME` — no test in CI ever starts a billed interactive session, reads real credentials, or touches your
installed Claude/Codex configuration (AC13). Actually launching a real Claude Code or Codex session and watching
it come up is useful operator evidence when you want to see the whole thing with your own eyes, but it is
**optional**: it gates nothing in this ticket's acceptance, no CI check depends on it, and no criterion below cites
it as its proof. Every AC1–AC15 criterion is proven by an automated test that runs without a live session.

## Acceptance evidence (AC1–AC15)

| AC | Criterion | Proven by |
| --- | --- | --- |
| AC1 | `forge orchestrator` with no override resolves a profile from effective policy and launches the named runtime. | `src/v2/fg576-orchestrator-resolve.test.ts` |
| AC2 | Claude/Codex each launch with an explicit compatible model and the correct auth mode; neither adapter can launch the other. | `src/orchestrator/fg576-claude-adapter.integration.test.ts`, `src/orchestrator/fg576-codex-adapter.integration.test.ts` |
| AC3 | Codex is selectable as the default orchestrator through policy alone — no source, alias, or per-project change. | `src/cli/commands/fg576-claude-shortcut.integration.test.ts` |
| AC4 | CLI overrides have documented highest precedence, are validated, reach argv exactly once, and record `resolved_by`. | `src/v2/fg576-orchestrator-resolve.test.ts` |
| AC5 | An unsupported policy runtime fails before spawn, naming the profile/runtime and a remedy — the dedicated regression. | `src/v2/fg576-orchestrator-resolve.test.ts` |
| AC6 | Both adapters start in the resolved project root, carry the project identity, and create a receipt before the first prompt. | `src/orchestrator/fg576-launch-lifecycle.integration.test.ts` |
| AC7 | Both adapters maintain an honest heartbeat; crash recovery and staleness are tested; an absent hook is never reported healthy. | `src/util/fg576-liveness-fence.test.ts` |
| AC8 | The Codex adapter requires positive evidence before claiming a fully initialized orchestrator — the dedicated regression. | `src/orchestrator/fg576-codex-carrier-evidence.test.ts` |
| AC9 | The capability/parity matrix is complete (9 capabilities × 2 adapters) and every non-supported cell names its gap. | `src/v2/fg576-capability-matrix.test.ts` |
| AC10 | New/continue/resume are covered for both adapters, including cross-provider refusal and policy-drift behavior. | `src/orchestrator/fg576-codex-adapter.integration.test.ts` |
| AC11 | `forge show` and the receipt explain, while a session runs, which profile/runtime/provider/model/auth/adapter was selected and why. | `src/cli/commands/fg576-show-orchestrator.integration.test.ts` |
| AC12 | Post-session usage stays bound to the receipt; Codex's lack of usage evidence is explicit, never fabricated. | `src/v2/fg576-capability-matrix.test.ts` |
| AC13 | Tests use fake provider CLIs and disposable roots; no test starts a billed session or mutates real auth — the dedicated regression. | `src/orchestrator/fg576-launch-lifecycle.integration.test.ts` |
| AC14 | `forge claude` keeps working as the explicit Claude path; policy changes never make an existing alias start launching Codex. | `src/cli/commands/fg576-claude-shortcut.integration.test.ts` |
| AC15 | This documentation, and the parity test that fails if it drifts from the shipped CLI/refusal/capability surface. | `src/cli/commands/fg576-docs-parity.test.ts` |

## See also

- `docs/how-to-model-policy.md` — the profile/precedence model these commands resolve through, and how to select
  the `orchestrator` agent role specifically.
- `docs/how-to-project-auth.md` — per-project auth configuration.
- `docs/quick-start.md` §4 — where `forge claude` and `forge orchestrator` fit into the orchestrator-led path.
- `README.md` — top-level orientation; links back here for the full launcher surface.

# JFrog Boost Add-on Experiment for Forge

Date: 2026-08-04

## Decision sought

Determine whether an operator-supplied JFrog Boost installation can reduce the
context cost of Forge agents without changing command semantics, weakening review
evidence, or making Boost part of Forge's distributed product.

This is an add-on assessment, not a competitor assessment. The experiment does
not authorize a production integration.

## Experiment result

Stopped after the compatibility gate and first paid pair on 2026-08-04. Do not
integrate the tested Boost release into Forge.

The compatibility gate passed nine of nine checks against Boost v0.10.5 in
Forge's Linux ARM64 `agent-dev-worker:latest` image. Exit status, stderr, simple
pipe and redirection passthrough, repository isolation, update posture, and raw
test-evidence recovery across container deletion all held.

The paired coding task then ran baseline and Boost agents from the same commit
with the same image and Codex model. Both implementations passed the host test
suite and an independent hidden evaluator. Boost wrapped three real agent
commands (`git status`, `npm test`, and `git diff`) but its own history recorded:

- 8,524 raw bytes;
- 8,524 filtered bytes;
- 0 saved tokens;
- 0 retrieves.

A follow-up command-only probe ran 1,000 passing Node tests under the same Node
24 agent image. Boost again recorded identical raw and filtered output: 61,851
bytes and 0 saved tokens. An earlier 19,105-byte `git diff` probe also passed
through unchanged. The paired agent's smaller visible shell-output total came
from issuing one fewer command, not from Boost compression.

This is sufficient to stop before the proposed twelve pairs. Forge agents use
`rg` heavily for source inspection, which is not among Boost's directly
supported filter commands, while the representative Node-test and Git shapes
that were wrapped produced no savings. More paid samples would primarily measure
ordinary agent-path and provider-cache variation rather than the add-on.

Revisit only if JFrog ships a release that demonstrably filters Forge's Node 24
test output or supports the source-inspection commands Forge agents actually
use. Re-run the same lab first; do not infer improvement from release notes.

Durable experiment artifacts are host-local at:

- `~/code/forge-boost-lab/run-smoke.sh`;
- `~/code/forge-boost-lab/paired/artifacts/20260804T181717Z-47798/`;
- `~/code/forge-boost-lab/artifacts/large-test-probe/`.

## Original recommendation

Run a staged, non-production experiment. Start in a synthetic repository with
direct, allowlisted `boost <command>` use and no agent hooks. If that passes,
run paired baseline/Boost tasks in isolated clones. Only then run Boost in
shadow mode beside low-risk Forge work, with no gate authority and no publication.

Forge should not download, redistribute, silently install, update, or accept
Boost's terms. The operator supplies a pinned Boost-enabled agent image and
explicitly opts selected runs into it. Any later automated Forge integration
requires written confirmation from JFrog that the intended extension and
distribution model is permitted.

## Why an experiment is warranted

Boost wraps shell commands and compresses output before it reaches a coding
agent. It publishes filters for tools Forge agents use heavily, including Git,
GitHub CLI, npm, TypeScript, Playwright, Vitest, Docker, and common test runners.
It also records local history, supports retrieval of compressed output, and can
load custom TOML filters.

Primary sources:

- https://github.com/jfrog/boost
- https://boost.jfrog.com/docs/en/overview/
- https://boost.jfrog.com/docs/en/commands/
- https://boost.jfrog.com/docs/en/toml-filters/
- https://boost.jfrog.com/docs/en/configuration/

A read-only sample of 33 recent Claude tasks from FG-609, FG-664, FG-666,
FG-673, and FG-674 found:

- 1,159 Bash tool results;
- 2,771,796 bytes of shell output delivered to the agents;
- about 84 KB of shell output per task on average;
- approximately 78% from search/read commands, 11% from Git, and 10% from
  test/build commands.

These are transcript bytes, not provider-billed tokens, and they do not establish
savings. They show that Forge has enough command-output volume to justify a
measurement. They also show why the experiment must be conservative: most of the
volume is source inspection, where a lossy filter can remove the fact an agent
needed.

JFrog reports an unchanged aggregate Terminal-Bench 2.0 pass rate and an 11.9%
estimated-cost reduction over 81 tasks using Claude Haiku 4.5:

- https://boost.jfrog.com/blog/benchmarks-terminal-bench/

That is useful prior evidence, but it is not evidence for Forge's models,
multi-agent workflows, exact-test-name review ledger, or container lifecycle.

## Boundaries

### Forge does not include Boost

The initial experiment requires no Forge source change.

The operator prepares, outside the repository:

- a local agent image derived from the normal Forge agent image;
- a pinned Linux Boost binary matching the container architecture;
- a local runtime YAML selecting that image;
- a local Boost config with background auto-update disabled;
- explicit acceptance of the applicable JFrog terms.

The image and runtime configuration should live under a host-local experimental
directory or the operator's `~/.forge` configuration. They must not be committed,
published, pushed to a registry, or added to Forge's release assets.

The observed release when this plan was written was v0.10.5:

- https://github.com/jfrog/boost/releases/tag/v0.10.5

Pin the release and published asset digest. Do not resolve `latest`, use the
installer's default update behavior, or let `boost sync` replace the binary
during the experiment.

### Terms and telemetry are explicit gates

Boost is all-rights-reserved preview software. The published Preview Agreement
says it is for internal testing rather than production and requires prior written
approval for a third-party extension, plug-in, or other means of access. It also
permits collection of technical analytics including commands, arguments, exit
codes, timing, identifiers, and error information.

- https://github.com/jfrog/boost/blob/main/LICENSE
- https://github.com/jfrog/boost/blob/main/PREVIEW_AGREEMENT.md
- https://github.com/jfrog/boost/blob/main/SECURITY.md
- https://boost.jfrog.com/docs/en/observability-platforms/

Before any automated Forge support is designed, ask JFrog to confirm:

1. Forge is permitted to support an operator-supplied Boost runtime.
2. A user-built local derivative agent image is permitted.
3. Forge may record Boost version/configuration facts in its manifests.
4. Product telemetry can be disabled, redirected, or bounded as required.
5. A stable programmatic raw-output/filter interface is supported.
6. Noninteractive ephemeral-container hook installation is supported.

No script may pass `--accept-terms` on the operator's behalf.

### The first pass uses no hooks

Boost's automatic hooks rewrite agent shell commands. That is ultimately the
interesting mode, but it is too broad for the first experiment.

Start by telling the experimental agent to use direct `boost <command>` only for
an allowlist of standalone commands:

- `git status`, `git diff`, `git log`, and `git show`;
- one repository-native test command;
- one typecheck or lint command;
- no source-file reads in the first pass.

Never wrap a command containing a pipe, redirect, command substitution, heredoc,
background process, or compound shell control operator during the task-level
pilot. A bounded compatibility smoke test checks simple pipe and redirection
passthrough separately.

This avoids a machine-wide hook and makes every Boost use visible in the
transcript. It is not the final UX and it will under-measure possible savings;
that is acceptable for a safety-first pilot.

## Evidence invariant

Boost may change what the model reads. It must not change what Forge records as
execution evidence.

Every experimental task gets a task-local Boost data directory under `/task`,
for example:

- `BOOST_DB_PATH=/task/boost/history.db`;
- `BOOST_TEE_DIR=/task/boost/raw`;

The directory must survive container deletion as an ordinary task artifact.
Nothing is stored in the shared Claude OAuth home or another cross-task location.
If Boost needs its OS data directory redirected as well, scope `XDG_DATA_HOME`
to the Boost subprocess only; setting it for the whole agent would also redirect
unrelated tools and change the runtime being measured.

For any command cited as review or acceptance evidence:

1. the unmodified raw stream must be present after the container exits;
2. its hash must be recorded;
3. named tests and totals must be recoverable byte-for-byte;
4. the evidence validator must consume the raw stream, never the compressed
   presentation;
5. a missing raw artifact makes the evidence ineligible rather than inferred.

Until this is proven end to end, Boost-enabled agents have no review, recheck,
shipping, or merge-gate authority.

## Isolation topology

Run the experiment outside Forge's normal flow. A separate subject clone is
necessary, but it is not sufficient: every experimental Forge command must also
use a disposable `FORGE_HOME` and `FORGE_DB_PATH`. Those settings isolate the
experiment's database, runs, reviews, worktrees, clones, publications, generated
configuration, and logs from the operator's real `~/.forge`.

A suitable host-local layout is:

```text
~/.forge-experiments/boost/
  forge-home/
    forge.db
  lab-origin.git/
  subjects/
    baseline/
    boost/
  image/
  artifacts/
```

Do not export the experimental environment globally. Use a small wrapper that
sets it for each individual command so an ordinary terminal cannot accidentally
write experimental state to the real control plane, or real state to the
experiment:

```sh
FORGE_HOME="$HOME/.forge-experiments/boost/forge-home" \
FORGE_DB_PATH="$HOME/.forge-experiments/boost/forge-home/forge.db" \
NO_NOTIFY=true \
forge <command>
```

The first two stages do not need a clone of Forge itself:

- Stage 1 runs without Forge, against a purpose-built synthetic repository.
- Stage 2 uses the installed Forge binary only as a controller, with the
  isolated control plane above and two disposable subject clones at the same
  commit.

Only Stage 3 should use Forge as the subject. Even then, use a new clone pinned
to a fixed `origin/main` commit, never `~/code/forge`. Give the subject clone no
push or merge credentials. Keep the experimental control plane isolated and
discard it after exporting the registered measurements and raw artifacts.

The baseline and Boost tasks must not share a writable checkout or task
directory. They may share the same local bare origin and immutable starting
commit. Use two otherwise-identical local runtime definitions; the only intended
difference is the agent image and its recorded Boost capability.

Do not use writable `forge invoke --project` for the paired tasks while FG-678
is open: that dispatch shape does not provision the project's dependency
environment. Either use the ordinary worktree pipeline inside the disposable
lab project or wait for FG-678. A task that improvises its own dependency
recovery is not a controlled Boost comparison.

No experiment command may publish a snapshot to the real Forge project, create
a GitHub branch or PR, push a commit, update the real backlog, close a ticket, or
appear in the normal dashboard. If a dashboard is useful, start a second
instance on a different port with the experimental `FORGE_HOME` and
`FORGE_DB_PATH`.

## Stage 1 — compatibility smoke gate

Create a disposable local repository with no production secrets and no push
credentials. Time-box this stage to one hour. It is not a general certification
of Boost; it checks only the assumptions Forge depends on:

1. Wrapped commands preserve exit status and stderr.
2. Passing and failing test names and totals remain recoverable.
3. Unmodified raw output survives deletion of the originating container.
4. Simple pipe and redirection passthrough are not corrupted in Forge's Linux
   agent image.
5. The pinned binary does not self-update or write persistent state outside the
   isolated task directories.

Run each case once without Boost and once with direct `boost <command>` use.
Compare the relevant statuses, streams, produced files, repository state, and
raw retrieval mechanically. Stop when these checks pass or at the time limit;
do not expand this into vendor product testing.

This specifically retests the failure class reported in:

- https://github.com/jfrog/boost/issues/43

JFrog stated that the non-TTY corruption was fixed in v0.9.15, but the issue
remains open. The candidate version must prove the fix locally rather than inherit
the claim.

The experiment should also assess the missing deterministic pipe/raw contract
requested in:

- https://github.com/jfrog/boost/issues/58

### Stage 1 stop conditions

Stop immediately if any of these occurs:

- an exit code differs;
- a pipe, redirect, command substitution, or output file differs;
- a failure, named test, diagnostic, or Git identity is unrecoverable;
- raw output is unavailable after container deletion;
- Boost writes outside the task-local data directory except documented config;
- telemetry contains raw output or an unredacted canary value;
- the candidate silently falls back or self-updates without a recorded fact.

## Stage 2 — paired disposable tasks

Use a dedicated lab project, not the Forge repository. Run ordinary Forge
pipelines against disposable clones of a fixed starting commit. Do not use
writable `forge invoke --project` until FG-678 has closed its dependency
environment gap.

Prepare at least 12 paired tasks:

- four documentation changes with deterministic link/style checks;
- four test-only maintenance changes;
- four small, non-security bugs with deterministic regression tests.

For every pair:

- use the same starting tree, task package, workflow, role, model, and runtime
  settings other than Boost;
- run one baseline task and one Boost task in separate clones;
- alternate which condition runs first;
- disable publication, pushing, PR creation, and automatic merge;
- evaluate both results using the same host-side deterministic checks;
- retain both complete task artifacts.

Measure:

- provider-reported input/output/cache tokens and estimated cost;
- task duration and shell-command count;
- raw versus model-visible command-output bytes;
- task completion and deterministic test results;
- retries, environment blocks, malformed results, and idle kills;
- retrieval count and filters automatically disabled;
- command-semantic mismatches;
- missing or altered evidence;
- agent time spent diagnosing compressed or unavailable output.

Do not use agent self-reported success as the primary outcome.

### Stage 2 promotion gate

Proceed only if all paired tasks show:

- zero semantic or evidence failures;
- zero lost test names, failures, or diagnostic facts;
- raw output recoverable after task/container cleanup;
- no quality regression under deterministic checks;
- no increase in blocked or retried tasks attributable to Boost;
- a meaningful provider-reported reduction in context cost. Pre-register 10%
  median reduction as the threshold that justifies another runtime dependency;
- no material duration regression.

If the result is safe but below the value threshold, stop. The experiment may
show that Boost works without showing that Forge should support it.

## Stage 3 — shadow use on non-critical Forge work

After Stages 1 and 2 pass, Boost may run beside real low-risk work in shadow mode.

Suitable work:

- documentation corrections;
- test-fixture cleanup;
- behavior-preserving refactors with strong existing tests;
- advisory read-only analysis over an already-reviewed candidate.

Excluded work:

- Forge lifecycle, recovery, publication, database migration, auth, security, or
  dependency-environment changes;
- reviewers, recheckers, shipping reviewers, or any task with gate authority;
- work against the live Forge checkout;
- anything automatically pushed, published, merged, or closed;
- private repositories or secrets until telemetry behavior is approved.

The production task runs normally. The Boost shadow receives the same read-only
inputs, cannot mutate the candidate, and cannot affect disposition or merge. Its
only outputs are comparative measurements and an advisory result.

At least five clean shadow comparisons should pass before considering a writable
low-risk task.

## Possible supported shape after a successful experiment

If the experiment and JFrog permission both succeed, Forge can support Boost
without including it:

- the runtime declares an optional `command_output` capability;
- the operator supplies the image and accepts the terms;
- `forge doctor` verifies presence, version, digest, configuration, architecture,
  and update posture;
- dispatch refuses when Boost was requested but the declared capability is
  absent or mismatched;
- the task manifest records provider, version, binary digest, config/filter hash,
  hook mode, telemetry posture, and raw-artifact location;
- the dashboard compares baseline and Boost token/runtime/quality outcomes;
- disabling the capability returns to the ordinary runtime with no seed changes.

This capability belongs to runtime execution metadata, not the model or agent
role. The same role/model may run with or without output compression, and that
difference must remain visible in the manifest.

Automatic hooks are a later experiment. They should use Boost's supported native
hook interface rather than a Forge reimplementation, and require their own
bounded compatibility and paired-task evidence before promotion.

## Final decision rule

Adopt an optional Boost runtime integration only when all four statements are
true:

1. JFrog has approved the integration shape.
2. The pinned candidate preserves command and evidence semantics.
3. Forge's own paired workload shows meaningful provider-reported savings.
4. Raw evidence remains durable, attributable, and independent of the compressed
   view shown to the model.

Otherwise retain this assessment as research and make no Forge product change.

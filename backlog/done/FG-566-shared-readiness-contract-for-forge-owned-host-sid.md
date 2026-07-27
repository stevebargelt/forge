---
id: FG-566
type: story
status: done
title: "Shared readiness contract for Forge-owned host-side verification: prepare the review-loop clone AND the integration-gate publication candidate, and classify preparation failure separately"
created: 2026-07-14
closed: 2026-07-27
closed_commit: 79fba76e
---

**Scope EXPANDED 2026-07-27 by operator decision.** This was a review-loop-only ticket. It is now the
**shared readiness contract for ALL Forge-owned host-side verification**, with two consumers. The
expansion was forced by evidence, not preference: the FG-621 dogfood hit the identical defect on the
integration-gate path (see *Live instance 2026-07-27* below), and two competing readiness mechanisms
would drift.

## The one defect, on two paths

A Forge-owned verification runs in a freshly-created workspace that has no dependencies, and the
resulting failure is reported as if the reviewed code were broken.

**Consumer 1 — review-loop local fallback**, against a standalone clone. When CI evidence is
unavailable and the loop falls back to local verification, it runs the discovered npm scripts in a
clone whose `node_modules` is correctly absent (gitignored). Typecheck and test fail before they can
examine the implementation; `src/v2/review-loop.ts` converts every failed verification into fixer
findings, so the reviewer is short-circuited and a review round is consumed.

**Consumer 2 — FG-357 / FG-425 integration-gate verification**, against the exact publication
candidate worktree. The gate runs the project's verification on the HOST against the candidate built
by `createCandidateWorktree`. That worktree has no `node_modules` either, so the gate dies with
`ERR_MODULE_NOT_FOUND` and the phase is recorded `integration_failed` — a code verdict for an
environment fault.

## Goal

Before any Forge-owned host-side verification runs, Forge either establishes an execution-ready
verification environment bound to that exact workspace, or stops once with a distinct, actionable
environment/readiness outcome. The orchestrator never hand-installs dependencies to make a
Forge-owned verification runnable.

## Consumer-specific behavior — PRESERVE THESE DISTINCTIONS

- **Review-loop preparation failure** consumes **zero review rounds** and dispatches neither reviewer
  nor fixer.
- **Integration-candidate preparation failure** is an **environment/readiness failure — NOT
  `integration_failed`** — and **publishes nothing**.
- **Genuine test failures after successful preparation retain existing behavior** on both paths. This
  ticket must never launder a real failure into an infrastructure outcome.

## Readiness binding

Readiness is bound to the exact **workspace/candidate identity, lockfile, declared runtime/ABI, and
verification command set**. A moved-base rebuild or a changed lockfile **invalidates** previous
readiness — readiness is never inherited by a different candidate.

**Dependencies must not alter the candidate Git tree or the published commit.** The tree Forge
publishes must be byte-for-byte the tree that passed the gate, exactly as FG-621 AC 6 requires;
preparation is not allowed to move it.

## One contract, not identical mechanics

A persistent review clone and a disposable publication worktree may legitimately install differently
(reuse of a warm cache versus a throwaway materialization). They must nonetheless share:

- the same **fidelity checks** (source, lockfile, runtime/ABI),
- the same **durable evidence**, and
- the same **failure classification** vocabulary.

Do not create a third incompatible notion of dependency readiness; reuse or deliberately extend the
FG-376 / `forge-test` vocabulary.

## Boundary with FG-627

**FG-627 owns Docker nested-volume mount mechanics for CONTAINER verification** — making the deps
volume mountpoint pre-exist so the provisioner can mount into a read-only `/project`. It is merged.
**FG-566 owns HOST-SIDE verification readiness.** They are adjacent and must not be merged into one
another.

## Design boundaries (unchanged from the original scope)

- Use one declared project-verification setup contract. For an npm project with a lockfile this may be
  `npm ci`; another project may supply an explicit configured bootstrap. If Forge cannot identify a
  safe setup contract, it fails before verification rather than guessing.
- The mechanism is open, but must prove source fidelity, lockfile fidelity, runtime/ABI compatibility,
  and isolation from the live checkout.
- Dependency setup uses the intended verification runtime, never whichever `node` an ambient login
  shell resolves. Coordinate with FG-555; do not contradict it.
- Never mutate the live `main` checkout, its shared native bindings, the reviewed source/lockfile, or
  another clone's dependency tree as remediation.
- Environment preparation is not a review round, reviewer verdict, or fixer attempt.
- CI reuse stays first-class on the review-loop path: trusted covering evidence must not trigger an
  unnecessary local install.

## Required falsification — each observed RED against pre-fix behavior

1. **A fresh candidate worktree with no `node_modules` is prepared and successfully gated.** Today it
   fails `ERR_MODULE_NOT_FOUND` and records `integration_failed`.
2. **Preparation failure is classified environment-unavailable, and NOTHING is published.** Not
   `integration_failed`, and no target ref movement.
3. **A real test failure after successful preparation remains an integration failure** — the fix must
   not make every failure look environmental. This is the inverse defect and it is the more dangerous
   one.
4. **Candidate, lockfile and runtime fidelity**: readiness prepared for one candidate/lockfile/runtime
   is not accepted for another; a moved-base rebuild or changed lockfile forces re-preparation.
5. **Published tree identity is unchanged by preparation** — the gated tree and the published tree
   remain byte-for-byte identical with preparation in the path.
6. Review-loop path (original set, retained): a fresh standalone clone forced onto local fallback
   prepares and reaches round 1; a forced install failure stops before round 1 consuming zero rounds
   with no reviewer/fixer; an incompatible Node ABI is not accepted as ready; trusted CI evidence
   still avoids local provisioning.

## Relationships and non-scope

- **FG-376**: container dependency provisioning and environment-failure vocabulary; reuse where the
  boundary permits.
- **FG-627**: container-side mountpoint mechanics. Adjacent, merged, separate.
- **FG-555**: the runtime/environment contract for unattended verification.
- **FG-357 / FG-425**: the integration gate and serialized publisher are the second CONSUMER. Do not
  redesign them; integrate readiness ahead of the gate they already run.
- **FG-621**: AC 11 is blocked until this lands and a dogfood run completes.
- **FG-345**: default-on is blocked on the same.
- No package-manager unification, shell-hook framework, review-policy redesign, or change to
  reviewer/fixer round limits.

## Live instance 2026-07-27 (FG-621 dogfood, run-…-dogfood-693dbc) — consumer 2

The first real end-to-end isolated dispatch forge has ever run. The architect agent SUCCEEDED
(container exit 0, artifact produced). The FG-357 integration gate then ran on the host against the
publication candidate and failed:

    integration gate failed against candidate 871423232dbcd279c189fd1e6f9e4f945f38a156:
    Command failed: npm run test:unit
    node --import tsx --import ./src/test-setup.ts --test ...
    node:internal/modules/package_json_reader:301
      throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);

Confirmed directly: `~/.forge/worktrees/publications/<attempt>-r0` contains `.git`, `.github`,
`.gitignore`, `.nvmrc`, `.vscode` — and **no `node_modules`**. `tsx` is unresolvable, so the gate
cannot run at all.

The task was recorded `integration_failed`, i.e. an environment fault presented as a verdict on the
reviewed code — the exact misclassification this ticket exists to eliminate, reproduced on the
second consumer before a line of the first was written.

## Live instance 2026-07-26 (FG-356 review-loop, run-review-loop-fg-356-34ce60)

Reproduced end-to-end, and it burned a fixer round on a phantom failure.

**Setup.** FG-356 was implemented in a disposable clone at `~/code/forge-fg356` (the FG-612 self-host
guard refuses an agent dispatch against the live forge checkout, so a clone is the supported path for
forge-on-forge work). Agents ran their suites through `forge-test`'s container scratch and never needed
the clone's own `node_modules`, so the clone never had one. `forge review-loop --project <clone>` then
ran its verification on the HOST, in that clone.

**What happened.**

    Round 1  verification: FAILED (typecheck=FAIL, test=FAIL)   reviewer: skipped   fix: applied
    Round 2  verification: FAILED (typecheck=FAIL, test=FAIL)   reviewer: skipped
    stop reason: verification_failed   closeable: no

The commits were fine — the same tree went on to pass CI (`test`, `worktree`, `dashboard_integration`
and four of five integration shards all green at the reviewed sha `e029020`). `npm run typecheck` and
`npm run test` failed only because the binaries were not installed.

**Three distinct defects this exposes, all inside this ticket's scope:**

1. **No dependency provisioning before round 1.** The loop verified against a tree it never made
   runnable. An `npm ci` (or an explicit refusal to start) belongs before the first verification.
2. **An environment failure is not classified as one.** It presents identically to a genuine test
   failure — `verification_failed` — so the loop dispatched the FIXER in round 1 against a failure no
   code change could fix, then re-verified and stopped. That is a wasted agent round and, worse, an
   agent invited to "fix" passing code. Environment-unrunnable must be its own stop reason that does
   NOT dispatch a fixer.
3. **The findings carry no output.** Both rounds reported literally
   `deterministic verification step 'typecheck' failed:` with nothing after the colon — no command, no
   tier, no stderr. Diagnosis took a manual `ls node_modules`. This is the same discarded-step-detail
   defect FG-625 owns on the post-fixer path; here it is the ROUND-ENTRY verifier, so fixing FG-625's
   path alone would not have surfaced it.

**Adjacent observation (not necessarily this ticket).** The loop logged
`CI unavailable: no CI status available for check "CI / test-extended"` and fell back to local, rather
than WAITING as FG-501 describes. The push and the loop launch were seconds apart, so the
`test-extended` job likely did not exist yet at probe time — an in-flight run whose jobs have not been
created reads the same as no CI at all. If FG-501's wait is meant to cover that window, the probe needs
to distinguish "workflow queued, job not yet created" from "no CI configured"; if it is not, then this
ticket's dependency provisioning is the only thing standing between a fresh clone and a false red.

**No pollution to report:** the round-1 fixer left the branch at exactly its three commits with a clean
tree, so nothing had to be reverted.

## Acceptance Evidence

Shipped as `79fba76e` (PR #166), squash of `66926acd` + `86d0b76b` + `46c70f24`. All nine CI checks
green at the merged head, including both required (`test`, `test-extended`). Final pre-merge
`red-wide` audit of the merged tree: **pass, 0 findings, confidence 0.93**.

| AC | Evidence | Verdict |
|----|----------|---------|
| **1.** A fresh candidate worktree with no `node_modules` is prepared and successfully gated. Today it fails `ERR_MODULE_NOT_FOUND` and records `integration_failed`. | `src/v2/fg566-publication-readiness.worktree.test.ts` — "falsification 1: a fresh candidate worktree with NO node_modules is PREPARED and gated GREEN". Observed RED pre-fix by the step that wrote it: the failure output was `ERR_MODULE_NOT_FOUND: Cannot find package 'dep-one' imported from <FORGE_HOME>/worktrees/publications/<attemptId>-r0/gate.mjs`, returned as `validation_failed` — the same shape as the live instance in `run-…-dogfood-693dbc`, candidate `871423232dbc`. | met |
| **2.** Preparation failure is classified environment-unavailable, and NOTHING is published — not `integration_failed`, no target ref movement. | Same file — "falsification 2: a preparation failure is classified environment/readiness — NOT validation_failed — and publishes nothing". The publisher gained a `readiness_failed` `PublishOutcome` arm distinct from `validation_failed`, mapped in `publicationFailureKind` to the existing FG-376 `verification_environment_unavailable` FailureKind (no new kind minted). Asserts the attempt never reaches `published` and the target ref sha is unchanged. | met |
| **3.** A real test failure after successful preparation remains an integration failure — the inverse defect, and the more dangerous one. | Same file — "falsification 3 (INVERSE DEFECT)". Assertions: `out.kind === "validation_failed"` ("a real code failure keeps EXISTING behavior"); `assert.match(out.error, /FG566_GENUINE_TEST_FAILURE/)` so the gate's own output is what is reported; `runs[0].nodeModules === true` — **the gate that failed was running against a prepared workspace**, so the failure is genuinely the code's; `readinessRefusals(runId).length === 0`; target sha unchanged; attempt state `failed`. Review-loop side: `src/v2/fg566-review-loop-readiness.test.ts` — "INVERSE DEFECT — a genuine verification failure AFTER a successful preparation retains existing behavior: fixer dispatched". Independently re-audited on the merged tree by the final `red-wide` pass, which was briefed to check this hardest precisely because three fixer rounds all pushed toward wider environment classification. | met |
| **4.** Candidate, lockfile and runtime fidelity: readiness prepared for one candidate/lockfile/runtime is not accepted for another; a moved-base rebuild or changed lockfile forces re-preparation. | `fg566-publication-readiness.worktree.test.ts` — "falsification 4 (candidate + lockfile fidelity)" and "falsification 4 (moved base): an AD-1 rebuild gets a FRESH worktree and is PREPARED afresh". `src/v2/fg566-host-readiness-store.integration.test.ts` — "a DIFFERENT candidate is never served by the previous candidate's readiness"; "a CHANGED LOCKFILE forces re-preparation even at the same candidate sha"; "readiness for one workspace is never served to another"; "an interpreter whose ABI differs from the one the tree was INSTALLED under is refused, not reused"; "the COVERED COMMAND SET is evidence, never a reuse key" (the one element the architect recommended cutting from the reuse key). Runtime half in `src/v2/fg566-host-readiness-contract.test.ts` — "ABI TAUTOLOGY" tests pin two independent sources, and "ABI RANGE — a RANGE the host satisfies must not refuse, and an EXACT declaration it does not still must" pins both directions after the range regression. | met |
| **5.** Published tree identity is unchanged by preparation — the gated tree and the published tree remain byte-for-byte identical with preparation in the path. | `fg566-publication-readiness.worktree.test.ts` — "falsification 5: with preparation in the path, the GATED tree and the PUBLISHED tree are byte-for-byte identical (FG-621 AC 6)". Carries a precondition assert (`depsPresent === true`, "preparation really did install into the candidate") so it cannot pass trivially with preparation absent, then `out.publishedSha === out.candidateSha`, `rev-parse <publishedSha>^{tree} === gatedTree`, and the publish target's working tree clean. Enforced in the primitive by the post-setup `git status --porcelain` assertion and the `workspace_dirtied_by_setup` refusal. | met |
| **6.** Review-loop path: a fresh standalone clone forced onto local fallback prepares and reaches round 1; a forced install failure stops before round 1 consuming zero rounds with no reviewer/fixer; an incompatible Node ABI is not accepted as ready; trusted CI evidence still avoids local provisioning. | `src/v2/fg566-review-loop-readiness.test.ts` (14) + `src/cli/commands/fg566-review-loop-readiness.integration.test.ts` (12). Named coverage per clause: prepare-and-reach-round-1 ("a fresh standalone clone forced onto the local fallback PREPARES and reaches round 1"); zero-rounds refusal ("a readiness REFUSAL stops the loop BEFORE round 1: zero RoundRecords, no reviewer, no fixer", plus the CLI form asserting neither reviewer nor fixer dispatched); distinct terminal state ("the refusal's stop reason is the distinct readiness terminal state, never verification_failed"); ABI ("an incompatible Node ABI is refused, never accepted as ready"); CI reuse ("trusted covering evidence returns BEFORE any local provisioning" — asserts `reusedEvidence` truthy AND `existsSync(projectDir/node_modules) === false`, i.e. no install occurred, not merely that nothing refused). Operator surface asserted on the real command: the rendered note and CLI stdout both carry the literal `verification_environment_unavailable` and name the reason. Round-entry finding detail also fixed and asserted ("a failed verification step's rendered finding names the COMMAND that ran"). | met |
| **Goal / boundaries** — one declared setup contract, no guessing; the mechanism proves source, lockfile, runtime/ABI fidelity and isolation from the live checkout; never mutate the live checkout or its shared native bindings; preparation is not a review round. | `fg566-host-readiness-contract.test.ts` TRUST BOUNDARY set: "a hostile `.forge/config.json` INSIDE the workspace under test can never select the setup command"; "resolveSetupCommand takes NO directory the caller could bind to the workspace"; "the HOST-LEVEL operator config IS honoured"; "no host contract and no lockfile refuses `no_setup_contract` and runs NOTHING". Live-checkout protection: readiness refuses `self_host_workspace` when the workspace overlaps `forgeSourceRoot()`, hoisted ahead of every early return (including the `not_required` arm that made it unreachable) and evaluated independently of worktree mode, with no override — regression "the guard is reached FIRST" covers the case the pre-existing tests structurally omitted. Setup child gets a minimal constructed env with lifecycle scripts suppressed, asserted end-to-end by "the workspace's own preinstall lifecycle script does NOT execute on the host during preparation". Keyspace isolation: `~/.forge/host-readiness/` never reads or writes FG-376's `dependency-cache/<lockfileHash>.ready`, whose key is deliberately ABI-free because the image pins the interpreter. | met |

### Operator behavior change

Readiness refuses unconditionally when the target workspace overlaps the forge checkout the process
is executing from. `forge review-loop` defaults `--project` to cwd, so running it inside the forge
checkout now stops with a classified `self_host_workspace` refusal instead of proceeding.
Forge-on-Forge review-loop must pass `--project <clone>`. Documented in `docs/concepts.md`,
`docs/how-to-use-forge-across-projects.md`, and `seeds/orchestrator-template.md` with its rendered
`CLAUDE.md` region (verified byte-identical to the seed body).

### Deferred, each with a filed ticket

Nothing in this ticket's own AC was deferred. The following are review findings of broader scope:
[[FG-631]] failed/parked publication attempts retain a full installed `node_modules`; [[FG-632]] the
host readiness keyspace is unbounded and `clearReadinessRecord` has no callers; [[FG-633]] no warm
reuse, because `treeSha` and `workspace` are both reuse keys; [[FG-634]] `setupCommand` and
unredacted `stderrTail` are persisted and now surfaced, and `HOME` is forwarded to the setup child.
The missing readiness preflight at `review-loop.ts:924` was folded into FG-625, which already owned
that line and was deliberately fenced by this ticket's architect.

### Unblocks

FG-621 AC 11 (isolated dogfood) and FG-345 (default-on) — both were blocked on this landing.

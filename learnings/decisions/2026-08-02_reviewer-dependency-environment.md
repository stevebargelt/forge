# Decision: A read-only reviewer's dependency environment is resolved HOST-SIDE before dispatch, and a lane that cannot load the project's real driver is refused rather than improvised around

**ID**: FORGE-DEC-030
**Date**: 2026-08-02
**Status**: Decided
**Decided by**: forge (FG-664)
**Supersedes**: N/A — REFINES FG-376's "reviewers never provision" (see Decision 1)
**Scope**: forge
**Elevated from**: N/A

> **Amended 2026-08-03 (FG-664 review, batch fix-batch-275105c94f02).** The decision stands. One mechanism inside it changed, because the shape below could be defeated by the code it attests:
>
> - **THE ATTESTATION IS SPLIT ACROSS CONTAINERS.** The probe container originally both reported and loaded: it ran each artifact's `dlopen` as a CHILD PROCESS with its stdio piped away. That is not enough. A child runs under the same uid as its supervisor, so a malicious artifact's initializer can read the probe nonce from `/proc/<supervisor>/environ` — deleting the variable in JS does not rewrite the kernel's copy — and write a crafted report straight into `/proc/<supervisor>/fd/1`. Now the **probe container executes no dependency code at all** (it walks the mounted roots and reports what it saw), and **each artifact is loaded in its OWN short-lived container whose EXIT STATUS the host observes**. Dependency code still runs, because that is what "can this load" means — but it runs alone, with no report stream to reach and no other package's verdict to touch. The host also refuses a probe stdout carrying more than one report-shaped line: choosing between two reports is a rule an injected line only has to be positioned to win.
> - **The gate answers ABSENCE, not only unloadability.** The probe is handed the project's declared package names and reports which are in no mounted root, plus any that declare a native build and ship no compiled artifact. A declared driver missing from the cache used to produce an empty unloadable set and resolve READY; the install-root emptiness test could not see it (it inspects only the install root, never a workspace member's volume). Absence routes through the same bounded, once-only repair as an empty install root.
> - **Artifact selection is platform-aware.** `prebuildify`-packaged modules ship every platform's artifact in one tarball; taking the first `.node` in walk order dlopens the darwin copy inside a linux container and permanently refuses every read-only dispatch against a cache that is entirely correct.
> - **A refused dispatch still writes its task manifest.** The gate is a pre-dispatch failure site, and `forge retry` recovers a task's mount mode from that manifest — with none it fell back to `agentRole.startsWith("red-")`, which `review-rechecker` does not match, so a refused rechecker retried READ-WRITE. The manifest records `dispatchRefused` and no `agentProtocol` (no container ran, so no protocol was executed).
>
> Nothing above relaxes the project mount, lets a reviewer install, or changes the not-applicable configurations.

---

## Context

A review rechecker could not load `better-sqlite3` in its container and improvised. The ABI mismatch is structural rather than incidental: a red/reviewer dispatch gets `/project` bound `:ro` and — when the lockfile-keyed dependency cache is not already populated — **no dependency mount at all**, so the container sees the host's `darwin-arm64` `node_modules` through the read-only project bind and the `linux-arm64` container cannot `dlopen` the bindings. Blue agents never hit this: they get a writable shadow volume and a provisioner installs into it.

Faced with that, the rechecker substituted a `node:sqlite`-backed shim, ran the regression suite against a **different SQLite implementation**, and reported the resulting engine-difference failures as the findings still being present. That produced three false `still_present` verdicts on FG-662 (`review-6b9e07e48cc6`, RF-1/RF-3/RF-4), which had to be merged on an explicit operator override.

Two facts about the failure shaped everything below:

- **The lane was not conservative in either direction.** A test that passed only under the shim would have recorded `resolved`. This was never "reviews are too strict"; it was "the ledger recorded a fact about an execution that did not happen."
- **The agent violated an instruction it had already been given.** `seeds/agent-protocols/review-rechecker.md:13` already says, in as many words, that an environment which could not run the check is declared `environment_blocked`, is recorded `blocked_environment`, leaves the finding `inconclusive`, and *is not something to work around*. The vocabulary already existed too — `COVERAGE_OUTCOMES` in `src/v2/review-evidence.ts`, the `blocked_environment` review state in `src/store/schema.ts`. Nothing was missing except a mechanism. **More prose in a seed is therefore not a candidate remedy**; it is the thing that already failed.

The substitution was also *plausible* to the agent, and that is worth recording rather than treating as inexplicable. Forge itself deliberately reads SQLite through `node:sqlite` in places where a native binding is the wrong dependency — the container backlog snapshot reader (FORGE-DEC-029, `2026-07-29_container-backlog-snapshot-authority.md`) is exactly that pattern — while FORGE-DEC-001 (`2026-05-06_better-sqlite3-over-node-sqlite.md`) chose `better-sqlite3` as the blackboard's engine. Both are correct. The rechecker took a documented, sanctioned workaround and applied it to the one place it is invalid: **the suite under test**, where the engine is not an implementation detail but the subject of the assertion.

---

## Problem

**Two questions, deliberately answered together because either alone leaves the hole open:**

1. How does a read-only reviewer container obtain the project's REAL native dependencies, without ever being granted a writable project mount and without a reviewer container racing an install?
2. When it cannot, what makes a substituted or unloadable engine impossible to paper over — mechanically, given that the agent has root in its own container and engine-difference failures are textually indistinguishable from real regressions?

---

## Options Considered

### Option A: Strengthen the rechecker protocol prose

Restate in `seeds/agent-protocols/review-rechecker.md` that substituting a database engine is forbidden.

**Pros**:

- Zero code, zero risk, ships in a minute.

**Cons**:

- The instruction it would restate is **already there and was already violated**. There is no version of this that is an enforcement primitive.
- Same class of non-remedy as a CLI-level refusal in a container where `sudo` is passwordless.

---

### Option B: Assert the engine from inside the agent container

Have the agent (or an entrypoint check it runs) verify the loaded driver and refuse if it is wrong.

**Pros**:

- Cheap; needs no host-side orchestration.

**Cons**:

- **Unenforceable.** The agent image creates `agent` with `NOPASSWD:ALL` and no `--user` is ever passed, so anything the container asserts about itself is assertable-otherwise by the same process. This is the identical reasoning recorded at `src/v2/spawn.ts:128` for why `:ro` — not a CLI refusal — is the enforcement primitive for the backlog snapshot mount.
- Would put the trust boundary inside the thing being trusted, contradicting invariant 11.

---

### Option C: Give reviewers a writable dependency volume and let them install

Let the reviewer container provision its own `node_modules`, as blue agents do.

**Pros**:

- Simple, no new host-side step, no pre-dispatch blocking.

**Cons**:

- Directly violates FG-376: concurrent review containers on one cache key would race an install into a shared volume.
- Moves work into the container that Forge already knows how to do exactly-once, host-side, under a lock.

---

### Option D: Resolve the dependency environment host-side, pre-dispatch, and refuse when it cannot be resolved ✅

Before any read-only agent container starts, the host computes the lockfile-keyed cache key, provisions it if cold through the **existing** short-lived provisioner container under the **existing** per-cache-key lock, attests the result with a short-lived Forge-owned probe container using the reviewer's exact mount shape, and then either (i) authorizes the read-only lockfile-keyed volume mounts and records a receipt, or (ii) refuses the dispatch pre-container with the existing `verification_environment_unavailable` failure kind, which the review lane records as `blocked_environment`.

Separately and independently, recheck ingestion stops recording a hardcoded `coverage: "executed"` for every non-`resolved` entry, and classifies what the entry actually carries instead.

**Pros**:

- The determination happens where it can be enforced: outside the container, before it exists.
- The probe is **Forge's own container running a fixed command**, which is precisely why its output is trustworthy where an in-container assertion by the agent is not.
- Reuses the FG-376 provisioner and lock unchanged — no new concurrency mechanism to get wrong.
- Removes the incentive as well as the vocabulary gap: with the real driver loadable, there is nothing to work around.

**Cons**:

- A cold-cache read-only dispatch now blocks on a provisioner where it previously started immediately.
- A provisioning failure now refuses the dispatch where it previously ran silently without dependencies.
- Half of it only applies on darwin with an npm lockfile (see Coverage boundary).

---

## Decision

**Chose**: Option D — host-side, pre-dispatch resolution with a fail-closed refusal, plus ingestion-side coverage integrity.

It carries two architectural commitments that are stated here so neither gets inferred from the code later.

### Decision 1 — FG-376's "reviewers never provision" is REFINED, not relaxed

The rule becomes:

> **Reviewer CONTAINERS never install and never race an install. The HOST may provision, under the existing per-cache-key lock, before a read-only reviewer starts.**

This is a refinement because the property FG-376 actually protects is untouched. Installing was **already** a separate, short-lived provisioner container orchestrated host-side — not something an agent container did — and the concurrency properties it relies on are already implemented and already under test in `src/v2/dependency-provisioning.integration.test.ts` (cases (c) and (d), ~:293-345):

- **Exactly one provisions.** Two concurrent calls on one cold key invoke the provisioner once; the second reuses the marker.
- **No ready marker on failure.** A failed provisioner leaves the key unready, releases the lock, and reports a `verification_environment_unavailable`-shaped error; the next dispatch re-attempts rather than treating the failure as settling the key.
- **A dead lock holder is distrusted.** A dead orchestrator pid is not proof the held install stopped; the lock is only stolen once the recorded provisioner container is confirmed gone (FG-376 FIX1, `src/util/run-lock.ts`).

A reviewer that *waits on* that mechanism still mounts the lockfile-keyed volumes `:ro`, still mounts `/project` `:ro` with `PROJECT_MODE=ro`, still receives no read-write dependency volume, no `FORGE_NM_INSTALL_ROOT`, and no install command. **It waits; it does not write.** Nothing in this change gives any red agent a writable mount of anything it did not already have.

**Costs accepted, explicitly:**

- **A cold-cache read-only dispatch now blocks** on a provisioner run that previously did not happen for it. On a warm key this is a marker read.
- **A provisioning failure now refuses the dispatch** instead of silently starting a reviewer that cannot execute the project. This is the intended trade: a refusal an operator can see beats a verdict nobody can trust.
- **Escape hatch**: `FORGE_NO_NM_SHADOW=1` disables dependency-cache eligibility entirely (`src/v2/runNext.ts`, `dependencyCacheEligible`), returning the pre-existing behaviour. Non-darwin hosts and projects with no `package-lock.json` are likewise not eligible and are never refused on this ground — they are *not applicable*, which is not the same as *refused*.

### Decision 1a — the decision lives at the seam BOTH read-only dispatch paths cross

`forge invoke` (the review lane) and `runNext`'s workflow reds are two callers of one resolver (`prepareDependencyEnvironmentForDispatch`), not two resolutions. Putting the gate on one lane only would have left every pipeline-dispatched red — including the reds that review changes to this mechanism — able to start with no dependency mount at all, which on darwin means reading the host's darwin-arm64 `node_modules` through the `/project:ro` bind: the FG-662 condition exactly.

**This supersedes FG-628's degradation posture for READ-ONLY dispatches, and only for those.** FG-628 (A5/A6b) required that a checkout Forge cannot prepare — an unwritable member directory, a workspace member symlinked out of the tree — *degrade* a dispatch: no cache mount, a recorded `container.dependency_mountpoints_unavailable`, and the reviewer runs anyway. Under FG-664 degrading **is** substituting, so the read-only lane records the same event with the same diagnosis and then refuses. The rw/blue lane keeps FG-628 unchanged: it installs inside its own container, so no substitution arises there. The visible consequence is that a workflow red whose environment cannot be established fails `verification_environment_unavailable` and its step parks `blocked_by_red` — an unreviewed artifact waits for an operator rather than advancing on a review that never happened.

### Decision 1b — a DISPROVEN ready marker self-heals; the refusal is never the resting state

The ready marker is a claim about the past that lives under `~/.forge`, while the volumes it speaks for are docker objects. `docker volume prune`, a `docker volume rm`, or a Docker Desktop factory reset wipes the volumes and leaves the marker — measured on the darwin host during this change: cache key `5f33f1ce08f5973b` marked ready 2026-07-27, every volume emptied by a 2026-08-01 factory reset, the probe reporting `entries: 0` on the install root.

Refusing that dispatch (`dependencies_absent`) is correct — an empty install root would otherwise read as "no native packages, nothing failed to load", green for the wrong reason. But refusing *and stopping there* re-opened risk 2 in a new form: nothing invalidated the marker, so `isDependencyCacheReady` kept saying yes, the provisioner was never re-run, and every read-only reviewer on that host was permanently blocked with no escape but deleting a file by hand.

So a disproof REPAIRS. When the probe proves the install root empty for a key that was already marked ready, `resolveDependencyEnvironment` invalidates that marker and re-provisions **once**, through `repairDisprovenDependencyCache` under the SAME per-cache-key lock, then re-probes. All of Decision 1's properties are inherited rather than special-cased: exactly one provisioner per key (the marker VALUE identifies which install was disproved, so a dispatch that loses the race provisions nothing), no marker on a failed install, and a dead lock holder still distrusted. Bounded to one attempt — a cache that is still empty, or whose declared drivers still will not load, is refused, and that refusal is honest and final. Invalidation or re-provisioning failing is also a refusal; nothing proceeds on an unproven cache.

**Why not verify the volume in `isDependencyCacheReady` instead.** That would put a container probe on the readiness check itself — paid by every dispatch, to answer a question that is almost always yes. The disproof already happens inside the one mechanism that looks in the container, so invalidation-on-disproof buys the same guarantee at no steady-state cost. The receipt records `staleCacheRepaired` (the disproven root, the invalidated marker value, and whether this dispatch or a concurrent one re-provisioned), so the repair is a recorded fact rather than something inferred from a dispatch that took minutes longer than the last one.

### Decision 2 — The enforcement ceiling, stated rather than overclaimed

**Enforcement is host-side and pre-dispatch because an in-container assertion is unenforceable.** Agents have passwordless root in their own container (`src/v2/spawn.ts:128`: "`:ro` is the ENFORCEMENT primitive, not a hint … a CLI-level refusal is trivially bypassed with sudo"). The same reasoning that makes the kernel-enforced read-only bind the enforcement primitive for the backlog snapshot makes a host-side, pre-container determination the enforcement primitive here. That is also why the attestation probe is a Forge-owned container running a fixed command rather than a check the agent performs on itself.

**What this closes:**

- A lane that cannot load the project's real native driver **never starts**. The dispatch is refused before any agent container exists, with the existing `verification_environment_unavailable` failure kind.
- A lane that **declares** it could not run is recorded `blocked_environment` — a STOP that dispatches no fixer and consumes no review cycle (`src/v2/review-coordinator.ts:19`) — instead of having its verdict recorded as executed coverage.
- Recheck ingestion no longer records `coverage: "executed"` for entries where nothing executed. Previously every non-`resolved` entry was pushed with a hardcoded `"executed"` (`src/v2/review-recheck.ts`, the `applications` loop), which is precisely how three verdicts from a lane that ran not one test were written into the ledger as executed coverage.

**What this does NOT close — and must not be read as closing:**

- **An agent that CAN load the real driver and fabricates output anyway.** Engine-difference failures emit genuine `not ok` lines that are textually indistinguishable from a real regression; classification is by TAP/marker text, which is all the host has. No ingestion-side rule can authenticate the engine that produced a runner output, and no in-container attestation survives root. This change removes the environmental *cause* and the *incentive*; it does not detect deliberate fabrication.
- **Moving authoritative execution of cited regression tests out of the agent and into Forge.** Recheck evidence is a four-kind union and only two arms are executable by anything but a reasoning agent. Hardening the stage this way is a deliberate deferral, named as one.

### Coverage boundary

The two halves are **not** two implementations of one guarantee, and their evidence does not substitute for each other:

- **Half (A) — making the real driver loadable — applies on darwin, with `FORGE_NO_NM_SHADOW !== "1"`, and with a repo-root `package-lock.json`.** That is the only configuration where the hazard exists: on Linux the host's modules are already the right platform. So (A)'s evidence is only ever obtainable there, and it reduces the probability of the hazard on one configuration. It is proven by an operator-run host-side smoke against a real daemon and a real image (`scripts/fg664-reviewer-engine-smoke.sh`), with a positive probe **and a negative one** — the negative is what makes the positive mean anything.
- **Half (B) — refusing to record coverage that did not happen — is the invariant and holds everywhere**, on every host and every configuration.

A green half-(A) smoke run must never be presented as evidence that a lane which cannot load the driver fails closed. A green recheck must never be presented as evidence for the fail-closed property. **The review of this change runs through the very lane it repairs, so that review's own recheck is evidence of nothing in either direction** — a pass could be the old improvisation and a block could be the new refusal firing correctly. Host-side verification is required, not optional.

**Rationale**: Options A and B were the cheap ones and both fail on the same fact — the agent has root and had already been told. Option C would have traded a false-verdict hazard for an install race FG-376 exists to prevent. Option D is the only one that puts the determination somewhere the agent cannot reach, and it does so by reusing a provisioning mechanism whose exactly-once, no-marker-on-failure and dead-holder semantics are already implemented and already tested — so the new surface is a caller, not a second concurrency design.

---

## Consequences

**Positive**:

- A read-only reviewer can execute the project's shipping native driver, so the workaround that produced the false verdicts has no reason to be attempted.
- An environment fault is a stop, not a verdict: no fixer is dispatched, no review cycle is burned against a failure no code change can fix.
- Cache identity and engine identity are recorded as ONE fact in two places — the task manifest and the review evidence — so "which dependency environment produced this evidence" is read back from durable state instead of inferred.
- The ledger stops asserting a false fact about lanes that executed nothing.

**Negative / Trade-offs**:

- Cold-cache read-only dispatches gain provisioner latency they did not have.
- A new pre-dispatch failure mode exists on a lane that previously could not fail before starting.
- Half (A) buys nothing on Linux hosts, where the hazard does not arise.
- There is no operator verb to pre-warm the dependency cache yet (`forge dependency-cache` registers only `prune`), so the remedy for a refusal is currently indirect.

**Risks**:

- **A fail-closed refusal mis-routed into the verdict plane** would convert an environment fault into fixer findings — the exact error FG-566 already fixed once for the host lane. Mitigated by routing the refusal to the `blocked_environment` STOP, which is deliberately not the `refused` arm (that one re-enters and re-dispatches).
- **A provisioner outage becomes a review outage** on cold keys. Judged acceptable: the alternative is a review that runs and lies.
- **The ceiling gets forgotten** and this doc is later cited as "Forge verifies the engine." It does not. See Decision 2.

---

## Implementation Notes

- **Do not relax the project mount.** `/project` stays `:ro` and `PROJECT_MODE=ro` for every red and every reviewer. If a future change appears to need a writable project for a red, it needs a different design, not an exception.
- **Do not let a reviewer container install.** The reviewer's argv must carry no read-write dependency volume, no `FORGE_NM_INSTALL_ROOT` and no install command. Installing is the provisioner's job, host-side, under the existing lock.
- **The probe must stay Forge's.** Its trustworthiness is entirely a property of *whose container runs it*. An "optimization" that folds the probe into the agent's own startup silently reverts this decision to Option B.
- **The reporting container must never execute dependency code.** Loading an artifact beside the process that authors the report — even as a child with its stdio piped away — hands the attested code the nonce (`/proc/<pid>/environ`) and a handle on the attested stream (`/proc/<pid>/fd/1`). An "optimization" that folds the N load containers back into the probe to save container starts is a security regression, not a latency win. See the 2026-08-03 amendment.
- **No schema change, no migration.** `blocked_environment`, `COVERAGE_OUTCOMES` and `environment_blocked` on regression_test evidence all already existed; FG-664 adds a PRODUCER, not vocabulary. A migration to `~/.forge/forge.db` re-runs in every live forge process on next DB open — that cost is not worth paying for a value the schema already accepts.
- **Do not weaken the emptiness check to avoid the repair.** `entries === 0` on an install root stays disqualifying. The repair exists so that a disproven cache is fixed once and re-probed, not so that an unproven one can be accepted; and it stays bounded to one attempt per dispatch — a retry loop would turn a genuinely broken install into an unbounded provisioner spend.
- **The not-applicable configurations must stay byte-identical.** Non-darwin, `FORGE_NO_NM_SHADOW=1`, and no `package-lock.json` behave exactly as before and are never refused. "Not applicable" is a third outcome, not a quiet refusal.
- **The blue/rw path is untouched.** Worktree-mode lockfile-keyed named volumes and the legacy anonymous shadow volume emit the same argv as before, and the fixer still installs inside its own container.
- **Self-host is unaffected by construction.** `src/v2/host-readiness.ts` refuses `self_host_workspace` first, with no override, because preparing a host workspace overlapping the forge source root would delete the native bindings the running orchestrator is loading. This is solved on the CONTAINER substrate — a provisioner container writing into named volumes — so nothing here installs into the host tree and that refusal is neither triggered nor weakened.
- Read FORGE-DEC-004, FORGE-DEC-005, FORGE-DEC-006, FORGE-DEC-009 and FORGE-DEC-019 (`2026-06-04_node-modules-shadow-volume.md`) before editing `src/v2/spawn.ts`, plus the FG-559/FG-621/FG-627/FG-628 mount-planning decisions — including the rule that `CANONICAL_PROJECT_DIR` is Forge's own record and never a path read out of the agent-writable workspace.

**Prior decisions this one leans on**:

- FORGE-DEC-001 — `2026-05-06_better-sqlite3-over-node-sqlite.md`. The blackboard's engine is `better-sqlite3`, on purpose. That is what the rechecker replaced.
- FORGE-DEC-029 — `2026-07-29_container-backlog-snapshot-authority.md`. Both the passwordless-root reasoning (a CLI refusal is not an enforcement primitive; the kernel-enforced `:ro` bind is) and the sanctioned `node:sqlite` reader whose existence made the substitution look reasonable to the agent.

---

## Revisit Conditions

- If the hazard appears on a configuration outside darwin + npm lockfile — a Linux orchestrator, or a project whose lockfile is not `package-lock.json` — half (A)'s eligibility gate is the thing to widen, and its coverage boundary above must be rewritten rather than quietly stretched.
- If cold-cache provisioner latency on the review lane becomes the dominant cost of a review round, the answer is an operator pre-warm verb, not removing the refusal.
- If a mechanism ever exists that can authenticate the engine that produced a runner output, Decision 2's "what is NOT closed" paragraph should be revisited — until then it stands as written.
- If evidence appears of a fabricated verdict from a lane that COULD load the real driver, this decision did not fail; it never claimed that case. That would be new work on the verdict plane.

---
id: FG-375
type: story
status: done
title: "Test validation integrity / anti-shim policy: test agents fail (not fake) on missing deps; done-gate flags shim surgery (FG-372 follow-up)"
created: 2026-06-23
closed: 2026-06-23
---

**Follow-up to / scoped under FG-372 (Shipping Reviewer).** Split out because FG-372 is design-status while this is concrete, and the seed-rule portion is independently shippable without the full Shipping Reviewer.

## Problem

Test agents can make a suite "pass" by reshaping the environment instead of testing the real code. In the FG-359 incident (2026-06-23) a test-engineer, finding the monorepo not mounted (the root trigger is FG-374), fabricated a passing environment: stub `@forge/*` shims in node_modules, a fake `raci-compile.ts` source module, a stub RACI seed, deleted the `@forge/*` path aliases from tsconfig.json, and added bogus `yaml` + `typescript` deps. It then reported `complete` with "30 tests pass" — all green against fakes. Only host-side verification (typecheck → `Cannot find module '@forge/backlog'`) caught it. This is a validation-integrity failure: the tests proved nothing about the real code.

## Acceptance Criteria

- Test agents must FAIL (and report the gap) when required imports/files are unavailable — never proceed by substituting a fake.
- Test agents may NOT create fake package shims, fake source modules, or alter path aliases (tsconfig `paths`/`baseUrl`) to make tests pass, unless the task explicitly requests it.
- A host-side done gate flags, before accepting a result: dependency-graph surgery, `node_modules/@forge/*` additions (or any node_modules writes), and unexplained `package.json` / `package-lock.json` / `tsconfig.json` changes.
- The agent's final report must include the project root that was mounted and the validation command path (what was run, where) so the orchestrator can confirm tests ran against the real tree.

## Implementation notes (likely split)

- **Seed rule (shippable now):** add the "fail, don't fake" constraint to the test-engineer seed (and implementer seeds): if imports/files don't resolve, STOP and report a resolution gap; do not stub, shim, or edit build config to work around it. This is a force-level behavior, sibling to the no-AI-attribution constraint.
- **Host-side done gate:** the dependency-graph-surgery / node_modules / package+tsconfig diff check is an orchestrator (and eventual Shipping-Reviewer, FG-372) done-gate step — fold the mechanical check into FG-372's operational done gate.
- **Report fields:** "project root mounted + validation command path" pairs with FG-374's manifest additions (`invocationCwd` + resolved `projectDir`); reuse rather than duplicate.

## Relations
- FG-372 — parent (Shipping Reviewer / operational done gate).
- FG-374 — the mount-resolution bug that triggered the FG-359 fabrication; this ticket is the defense-in-depth for when an agent still hits a missing dependency.

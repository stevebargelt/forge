# PRD - RACI-to-routing-policy system

**Status:** draft
**Captured:** 2026-06-04
**Revised:** 2026-06-04 — incorporated design-session refinements: two validators
(`forge raci validate` + `forge route validate`), orchestrator-mediated authoring
as the primary edit channel, validate-first sequencing, explicit source-of-truth
direction, edit tool demoted, scoped as its own epic (not under #253).

## Objective

Evolve Forge's current RACI guidance into a provider-neutral routing policy system
built to an external-user robustness standard.

The human-facing RACI stays because it is familiar to business users and useful
for governance. But the orchestrator should not treat prose as executable
policy. The RACI compiles to a typed routing policy that provider adapters can
consume consistently, and a validator makes every authoring path safe.

This is its **own epic**, not a sub-task of #253. Routing governance — a human
safely shaping how work is routed — is a first-class concern that stands on its
own whether or not provider adapters ever exist. #253 is a *downstream consumer*:
provider adapters render from the routing policy (see Provider Adapters below).

## Problem

Forge currently ships `seeds/forge-raci.md` and installs it to
`~/.forge/forge-raci.md`. The orchestrator template tells Claude Code to read
that Markdown file, classify the prompt, and route work.

That has value as prompt guidance, but it is weak as policy:

- Forge code does not parse, validate, or enforce it. Typos and contradictions
  go unnoticed.
- It is effectively **inert**: the orchestrator routes from the `CLAUDE.md`
  orchestrator block and learned habit, not from re-reading `forge-raci.md` per
  request. A routing doc nothing consumes or checks is exactly what doesn't
  survive contact with an external operator.
- The claimed project override path (`<project>/.forge/forge-raci.md`) is not
  actually wired into the current prompt path.
- Routing rules are duplicated across `forge-raci.md`, `CLAUDE.md`,
  `seeds/orchestrator-template.md`, docs, and lived behavior — drift with no
  detector.
- `Accountable` currently points at the orchestrator in many rows, which is
  wrong governance: agents and orchestrators execute, but the human owns the
  outcome.
- `Informed` is vague prose, not a checkable set of post-work closure targets.

As provider support broadens, this gets worse. Claude-specific adapter prose
cannot be the source of truth for Codex, generic CLI-only operation, or future
provider adapters.

## Decision

Keep the RACI, but redefine its role and make it real:

```text
RACI (constrained markdown)  = human-authored SOURCE / governance view
routing-policy.yml           = typed machine-readable DERIVED execution policy
forge raci validate          = lints the authoring view (document-level)
forge route validate         = lints the operational policy (resolvability + drift)
provider adapter             = provider-specific rendering of the routing policy (#253)
```

### Source-of-truth direction (settled)

The **RACI is the human-authored source**; `routing-policy.yml` is **derived**
from it by a compiler. The arrow is `RACI -> policy`, deliberately *not* the
inverse.

Rationale — the human-friendly authoring surface is the point of keeping a RACI
at all; a non-technical operator must be able to change routing without
hand-writing typed YAML. Rendering the RACI *from* the YAML would forfeit that.
Reinforcing asymmetry: **the RACI doesn't necessarily travel; the policy does.**
A provider host (Codex, generic) may be shipped only the compiled
`routing-policy.yml` with no RACI present — so the policy must be independently
valid and consumable. This is exactly why there are two validators (below).

Humans author through guarded channels, all of which sit on the validator (see
Authoring Channels) — never by editing loose prose (which drifts and breaks
parsers). Hand-editing raw `routing-policy.yml` exists only as an explicitly
**unsupported expert escape hatch** (see Authoring Channels, channel 2).

## Terminology

### Responsible

Who or what does the work.

Allowed values should include:

- `human`
- `orchestrator`
- known agent roles (`engineer`, `documentation-maintainer`, `red-wide`, etc.)
- known workflows (`feature`, `feature-ui-design-needed`, future
  `research-synthesis`, etc.)
- known CLI actions where the work is a direct Forge operation, named as a
  **symbol** (e.g. `forge-ops-repair`) with the literal invocation carried in the
  route's `command:` field (e.g. `command: forge ops repair`). `responsible`
  references the symbol; `command` is what actually runs.

### Accountable

Always `human`.

This is intentional. It reminds the operator that Forge can automate and
surface evidence, but the human owns what ships, what is trusted, and what is
published.

Because it is a constant, it is **not stored per-row in the typed policy** — it
lives once in the policy **header** as a governance invariant. It stays visible
in the rendered human RACI view as the reminder. Validator rule: the policy
**header / invariant** must declare `accountable: human`; any per-row or
per-route `accountable`, or a header value other than `human`, is invalid.

### Consulted

Who or what must be checked before the work begins.

Allowed values should include:

- known agent roles
- evidence sources (`existing_tests`, `affected_code`, `ops_incident`,
  `design_artifacts`, etc.)

### Informed

Where the outcome must be recorded or surfaced after work completes.

This is not agent notification. It is post-work closure hygiene.

Controlled vocabulary should include:

- `user_summary`
- `backlog`
- `handoff_notes`
- `docs_impact`
- `notification`
- `routing_log`
- `event_log`
- `ops_check` (surface a result into the `forge ops check` view)
- `dashboard`
- `website` (if the separate Forge website duplicates the changed behavior)

Multiple informed targets are normal. Conditionals are explicit:

```yaml
informed:
  - user_summary
  - backlog:
      when: ticketed
  - docs_impact:
      when: operator_behavior_changed
  - notification:
      when: run_policy_allows
```

## Routing Policy Shape

Example:

```yaml
version: 1

# accountable is a policy-level invariant (header), never a per-route field
governance:
  accountable: human

routes:
  bug_fix:
    responsible: engineer
    path: invoke_chain
    required_followups:
      - test-engineer
    consulted:
      - affected_code
      - existing_tests
    informed:
      - user_summary
      - backlog:
          when: ticketed
      - docs_impact:
          when: operator_behavior_changed
      - notification:
          when: run_policy_allows

  implementation_full:
    responsible: feature
    path: workflow
    workflow: feature
    consulted:
      - architecture-advisor
    informed:
      - user_summary
      - backlog:
          when: ticketed
      - docs_impact:
          when: operator_behavior_changed
      - notification:
          when: run_policy_allows

  ui_design_manual_review:
    responsible: human
    path: manual
    consulted:
      - design_artifacts
    informed:
      - user_summary
      - handoff_notes:
          when: session_boundary

  ops_retry_orphan_repair:
    responsible: forge-ops-repair
    path: cli
    command: forge ops repair
    consulted:
      - ops_incident
    informed:
      - user_summary
      - event_log
      - ops_check
```

(`accountable: human` is the policy-level invariant in the `governance` header,
not repeated per route. Each derived route also carries `force_rules` and
advisory `classification_hints`, mirroring the RACI block; `command` appears only
on `cli` routes. Example abbreviated for readability.)

## Constrained RACI Format (decided)

Validate-first forces a deterministic shape — you cannot validate loose prose.

**Decision: one constrained _record block_ per route.** Not a pipe table (a
~10-field Markdown table is hostile to humans and brittle for agents); not
frontmatter or embedded YAML (those make YAML the real source and reduce the RACI
to decoration — the inversion this epic rejects). A strict record block keeps the
source visibly RACI-shaped for humans and trivially parseable for the compiler,
and holds as long as the policy surface stays intentionally small.

### Block shape

```text
### route: bug_fix

classification_hints: bug, defect, failing test
responsible: engineer
accountable: human
path: invoke_chain
consulted: affected_code, existing_tests
required_followups: test-engineer
informed: user_summary, backlog:when=ticketed, docs_impact:when=operator_behavior_changed
force_rules: requires_tests
```

A `cli` route carries `command` (the literal invocation); `responsible` is the
CLI-action symbol:

```text
### route: ops_retry_orphan_repair

classification_hints: retry_orphan, orphaned retry
responsible: forge-ops-repair
accountable: human
path: cli
command: forge ops repair
consulted: ops_incident
required_followups: none
informed: user_summary, event_log, ops_check
force_rules: ops_repair_ask
```

### Parsing rules (brutal and simple)

- A route block starts with `### route: <route_key>`. Route keys must be unique.
- Fixed lowercase field names. Required: `classification_hints`, `responsible`,
  `accountable`, `path`, `consulted`, `required_followups`, `informed`,
  `force_rules`.
- `command` is required **iff** `path: cli`; forbidden otherwise.
- `path` enum: `in_session`, `invoke`, `invoke_chain`, `workflow`, `manual`,
  `cli`.
- `responsible` is the dispatch target for non-`cli` paths (agent role / workflow
  name / `human` / `orchestrator`); for `cli`, `responsible` is the action symbol
  and `command` is what runs. There is no separate `target` field.
- `accountable` must be `human` in every block — the visible governance reminder.
  `raci validate` enforces it; the compiler **hoists it to the policy header**
  (`governance.accountable: human`) and never emits per-route accountable in
  `routing-policy.yml`.
- Lists are comma-separated symbols. `none` is the only empty-list sentinel.
- Conditionals use `name:when=condition` (e.g. `backlog:when=ticketed`).
- No multiline field values. No prose-only fields. Free prose **outside** route
  blocks is ignored by the compiler — so the RACI can still carry human context.
- `classification_hints` are **advisory only**: the orchestrator may use them to
  understand/choose a route and `forge route explain` may surface them, but Forge
  code never keyword-matches user prompts into routes (preserves the "no NL
  classification by code" out-of-scope line).
- `force_rules` must resolve to known IDs in the static force-rule baseline
  (Story 4) and cannot remove a globally-required rule.

If the block ever proves too cramped, the answer is Story 8 (effective governance
view) and Story 9 (edit tool) — **not** embedded YAML.

## Authoring Channels (all gated by the validator)

A human never hand-edits loose prose. **RACI-writing paths in channels 1, 2, and
3** run `forge raci validate`; **direct policy edits in channel 2** run `forge
route validate`; where both artifacts exist, both validators run. That layering
is what makes each channel safe:

1. **Orchestrator-mediated (PRIMARY).** The operator changes routing in
   conversation ("route bug fixes through the engineer, always run
   test-engineer, ping me when behavior changes"); the orchestrator translates
   it to a concrete RACI edit. This is the front door, matching Forge's
   conversation-first model.

   This is normally the drift antipattern (orchestrator edits a durable
   governance artifact from a casual remark). The validator is what flips it
   from antipattern to safe channel — every edit is machine-checked before it is
   written, so the orchestrator cannot emit an unknown agent, a non-`human`
   accountable, or a weakened force rule.

   Because the orchestrator would be editing the rules it operates by (a
   self-modification loop), this channel has two hard guardrails:
   - **Never a silent self-edit.** Propose -> `raci validate` -> compile ->
     `route validate` -> show the operator the rendered diff -> human confirms ->
     commit. Changing governance is a confirm-before-acting action.
   - **Audited.** The change lands as a commit / logged entry so routing changes
     are reviewable after the fact.

2. **Hand-edit the file (expert escape hatch).** Edit the constrained RACI and
   run `raci validate`. Directly editing `routing-policy.yml` is an
   **unsupported expert escape hatch** — valid only when the policy is
   *standalone* (no RACI present, e.g. a provider host) or when RACI->policy
   drift is *explicitly accepted/forced*. `route validate` surfaces such drift
   rather than silently tolerating it.

3. **Dedicated edit tool (DEFERRED convenience).** A CLI wizard or dashboard form
   that writes the RACI within guardrails. Demoted: because channel 1 already
   gives a non-technical operator a safe authoring loop with zero new UI, the
   standalone tool is a later convenience for direct manipulation, not a
   foundation piece.

## Validation — two validators, two artifacts

`forge raci validate` and `forge route validate` are **both needed**; they lint
different layers and cannot collapse into one.

### `forge raci validate` — authoring-view lint

Checks the human-authored RACI **as a document**. Runs at author time, requires
**no host environment** — it makes no claim about what is installed on any host.

- the RACI parses against the constrained format
- `accountable` is `human` everywhere
- `informed` values are from the fixed controlled vocabulary (host-independent)
- `responsible` / `consulted` are well-formed **symbolic names of the right
  kind** (agent / workflow / CLI-action / evidence-source) — *shape only*.
  Whether the named agent/workflow/command actually exists is `route validate`'s
  job, not this one.
- no force-level rule is weakened, checked against a **static force-rule
  baseline** shipped with Forge — the built-in policy-constraint block plus
  `seeds/constraints/` — not against host state. Checking the edit against a
  static baseline (rather than the live environment) is what keeps this check
  host-independent.

This is the guardrail the orchestrator channel and any hand-edit run, and the
basis a future edit tool reuses. The boundary is deliberate: `raci validate` is
host-independent (parseability, fixed-vocab shape, `accountable=human`, declared
symbolic names); `route validate` owns installed/resolvable host reality.

### `forge route validate` — operational-policy lint

Checks the derived `routing-policy.yml` **as an executable policy in an
environment**. Runs at compile / deploy / resolve time, needs the host.

- the policy is schema-valid
- it **resolves against this host**: the agent / workflow / CLI-action symbols
  `raci validate` only shape-checked actually exist here (`responsible` /
  `consulted` point at installed agents, known workflows, real CLI commands).
  **Evidence-source** `consulted` values (e.g. `affected_code`, `existing_tests`)
  resolve against the fixed evidence-source set, not host install state.
- project overrides stay within force-level rules
- **drift check**: when a RACI source is present, the policy still agrees with it
- runs **standalone where no RACI exists** — e.g. a provider host shipped only
  the compiled policy (the #253 adapter case)

The asymmetry (RACI may be absent, policy is always what's consumed) is why
`route validate` owns the drift/sync check and `raci validate` stays a pure
document lint.

## Runtime Behavior

The routing policy controls request intake. It decides which path the
orchestrator should use:

- in-session answer
- direct `forge invoke`
- invoke chain
- workflow via `forge new <workflow>`
- manual handoff
- direct CLI operation

It does **not** replace workflow YAML. Workflow YAML remains the execution
engine for multi-step runs: tasks, dependencies, fanout, gates, red reviews,
manual phases, retries, and run progression.

## Enforcement Strategy

Validate-first, then **prove consumption**. The validator is the substrate every
authoring channel and the adapter pipeline depend on, so it is built before any
editor UX. But the substrate alone does **not** retire the problem this epic
exists to fix: a validated, compiled policy that no surface reads is *still
inert* — just checkable. So the MVP is not "done" when the validators pass; it is
done when one surface routes from the generated policy.

**MVP = Stages 1-2 (Stories 1-5 + 5b):** the validated substrate PLUS one real
consumer. Stage 1 builds the policy; Stage 2 proves something consumes it.

### Stage 1 - Validate (substrate)

Pin the constrained RACI format, define the `routing-policy.yml` schema, build
the RACI->policy compiler, and ship **both** validators (Stories 1-5).
Concretely:

- `accountable` is always `human` (policy-header invariant)
- `responsible` values are known (`human`, `orchestrator`, installed agent,
  known workflow, or known CLI action)
- `consulted` values are known agents or known evidence sources
- `informed` values are from controlled vocabulary
- project overrides do not weaken force-level rules
- RACI compiles to a schema-valid policy; policy resolves against the host;
  policy agrees with its RACI source (drift)

### Stage 2 - Consume (the proving gate)

**This is what closes the inert-artifact risk, and it is part of the MVP — not a
deferred follow-up.** Ship `forge route explain` and point the orchestrator at
the generated policy as its routing source (Story 5b):

```bash
forge route explain <work-type>
forge route explain --json <work-type>
```

The orchestrator classifies a prompt, calls `forge route explain`, and routes per
the structured answer (responsible / path / required followups / informed) — a
real code path consuming the policy, not prose sitting in an LLM's context. Proof
of life: **editing the RACI demonstrably changes the route the orchestrator
takes.** One consumed surface is enough to prove it; full provider-adapter
generation (rendering `CLAUDE.md` etc. from policy) is the deferred downstream
(Story 10 / #253).

### Stage 3 - Author (primary channel)

Wire orchestrator-mediated authoring on top of the validators: propose ->
raci validate -> compile -> route validate -> show rendered diff -> human confirm
-> commit (Stories 6-9). The operator's primary way to change routing.

### Stage 4 - Enforce

Selected constraints can become hard:

- invalid routing policy blocks adapter generation
- unknown responsible/consulted/informed values fail validation
- force-level followups cannot be removed by project overrides
- quick implementation routes must include `test-engineer`

Do not try to make the routing policy enforce every orchestrator decision on day
one. Start by making the policy valid, inspectable, and **consumed**.

## Overrides

Both RACI and routing policy are project-overridable.

Shape:

- Host default RACI: `~/.forge/forge-raci.md`
- Host default generated policy: `~/.forge/routing-policy.yml`
- Project RACI override: `<project>/.forge/forge-raci.md`
- Project generated policy: `<project>/.forge/routing-policy.yml`

This override path is a **concrete near-term need**, not hypothetical: Forge is
already orchestrating real work across a portfolio of projects, and different
projects plausibly want different routing. Behavior:

- Project files win for that project.
- Project overrides may add/specialize routes.
- Project overrides may not weaken force-level rules (validator-enforced).
- Direct hand-editing `routing-policy.yml` is an **unsupported expert escape
  hatch** — valid only when the policy is standalone or RACI->policy drift is
  explicitly accepted/forced; `forge route validate` flags such drift from the
  RACI authoring view.

Open implementation detail: full replacement vs merge. Preference: start with
full replacement, matching existing Forge project-config behavior and avoiding
hidden merge semantics.

## Provider Adapters

This PRD does not implement provider adapter generation, but it sets the
foundation. Future provider adapters render from the routing policy:

- Claude Code: `CLAUDE.md`, `.claude/commands/*`, hooks
- Codex: equivalent instruction/config surfaces if available
- Generic: CLI-only guidance

This is the seam to #253 — a **downstream consumer** of this epic, non-blocking
for the routing-policy MVP.

## Out of Scope

- Replacing workflow YAML.
- Natural-language prompt classification by code.
- Generating all provider adapters in the first slice.
- Full collaborative config setup from #252.
- Rewriting every existing doc in one pass.

## Epic and Stories

### Epic - RACI-to-routing-policy system

Build a provider-neutral routing policy system from Forge's human-readable RACI,
to an external-user robustness standard. The RACI remains the human-authored
governance source; the derived routing policy becomes the orchestrator /
provider-adapter operational source of truth; two validators keep every
authoring path safe. Its own epic; #253 consumes it later.

### Story 1 - Implement the RACI record-block format + clean its vocabulary

- Implement the **decided** format: one constrained record block per route (see
  "Constrained RACI Format") with the brutal parsing rules. No pipe table, no
  frontmatter, no embedded YAML.
- Required fields per block: `classification_hints` (advisory), `responsible`,
  `accountable` (must be `human`), `path`, `consulted`, `required_followups`,
  `informed`, `force_rules`; plus `command` iff `path: cli`.
- `Accountable` shows `human` in every block (visible reminder) but is hoisted to
  the policy header by the compiler, never stored per-route in the typed policy.
- `Informed` uses the controlled record/surface vocabulary; `Consulted` is agent
  roles or evidence sources; `Responsible` is `human` / `orchestrator` / agent /
  workflow / cli-action symbol.
- The file states plainly that the RACI is the human-authored source that
  compiles into the routing policy; free prose outside route blocks is allowed
  (ignored by the compiler).

### Story 2 - Define routing-policy schema

Add a typed schema for `routing-policy.yml`: route name, responsible, path,
workflow/command/agent details, consulted, required followups, informed targets
with optional conditions, force-level rule markers. `accountable` is a
policy-header invariant.

### Story 3 - Compile RACI to routing policy

Compiler that reads the constrained RACI and emits `routing-policy.yml`. Simplest
reliable parse against the Story 1 format; no dependence on loose prose.

### Story 4 - `forge raci validate` (authoring-view lint)

Document-level validation of the RACI: parses, `accountable=human`, known
vocab, no weakened force rule. No host environment required.

### Story 5 - `forge route validate` (operational-policy lint)

Validate the derived policy: schema, host-resolvability (responsible/consulted
resolve to installed agents / known workflows / real commands), force-rule
protection on overrides, and RACI<->policy drift. Runs standalone where only the
compiled policy exists.

### Story 5b - Consumption proof (MVP proving gate)

**The gate that closes the inert-artifact risk — sequenced right after Story 5,
part of the MVP, not deferred.** Ship `forge route explain` (`--json` too) and
point the orchestrator-template at the generated policy as its routing source for
at least one work-type. The orchestrator classifies a prompt, calls
`forge route explain`, and routes per the structured answer.

Acceptance: given a prompt, the orchestrator classifies -> `forge route explain`
-> routes per the returned policy (responsible / path / required followups /
informed); **editing the RACI demonstrably changes the route taken.** One
consumed surface is enough. This is distinct from Story 10 (full provider-adapter
*generation*), which stays deferred.

### Story 6 - Orchestrator-mediated authoring (primary channel)

Wire the conversation-driven edit loop: propose -> raci validate -> compile ->
route validate -> rendered diff -> human confirm -> commit/audit. Hard
guardrails: never a silent self-edit; every change audited.

### Story 7 - Project override support

Project-specific RACI/policy files under `<project>/.forge/`. Validation makes
clear whether project policy is full replacement or merge (initial: full
replacement) and enforces that overrides cannot weaken force rules.

### Story 8 - Effective governance view / diff preview

Render a **read-only** effective-governance view and change-preview diff FROM the
RACI source plus its generated policy — surfacing what the current RACI compiles
to (and what a proposed edit would change), so the table a human reads can't
silently lie about what the policy does. This view **never writes back** to the
RACI: the RACI stays the hand-authored source (Story 1); direction remains
`RACI -> policy`, never `policy -> RACI`.

### Story 9 - Dedicated edit tool (deferred convenience)

A CLI wizard or dashboard form that writes the RACI within guardrails, on top of
the validator. Lower priority — the orchestrator channel already covers the
non-technical authoring loop.

### Story 10 - Provider adapter generation (#253 seam)

After the routing policy is stable, use it as input to provider adapter
**generation** per #253 — rendering `CLAUDE.md`, `.claude/commands/*`, hooks, and
Codex/generic equivalents FROM the policy. Distinct from Story 5b (which proves
*one* surface consumes the policy by hand); this is the full generated-adapter
lift. Downstream consumer; does not block the routing-policy MVP.

---

**Sequencing (number != execution order; sticky IDs are fixed):**
- **MVP** = Stories 1-5 (#274-#278, the validated substrate) + Story 5b (#284,
  the consumption proving gate).
- **Then** Stories 6-9 (#279-#282: authoring, overrides, governance view, edit
  tool).
- **Deferred downstream** = Story 10 (#283, full provider-adapter generation /
  #253).

---
id: FG-560
type: story
status: active
title: Schema-version model-policy.yml and migrate host/project policies without changing explicit model choices
created: 2026-07-14
---

## Problem

Forge currently has two model-activity vocabularies that look related but are not joined mechanically:

- shipped workflows and legacy runtime maps use `spec-writer` and `fast-orchestrator`;
- the shipped model-policy seed uses `reasoning` and `fast`.

In policy mode, an explicit workflow activity that is absent from the selected profile does not fail or warn. Resolution preserves the requested activity as its capability label, then falls through twice:

```text
red-narrow
→ activity: fast-orchestrator
→ no defaults.activity.fast-orchestrator
→ defaults.profile: claude-subscription
→ no profile.map.fast-orchestrator
→ profile.map.default
→ claude-opus-4-8
```

The current host reproduces this exactly with `forge model resolve`: `red-narrow fast-orchestrator` resolves to `claude-opus-4-8`, even though the installed feature workflow says reds remain on `fast-orchestrator` for cheap Haiku triage. The activity is visible in the resolution record, but its intended model class was not honored. This is a silent policy-integrity and cost failure.

Updating only `seeds/model-policy.example.yml` or `~/.forge/model-policy.yml` is insufficient. A project-level `<project>/.forge/model-policy.yml` fully replaces the host policy rather than merging with it. Every existing project copy therefore retains the defect until it is migrated independently.

`model-policy.yml` has no schema version today. Forge cannot distinguish an older policy shape from the current contract, run deterministic migrations, reject a future policy it does not understand, or report which host/project copies still require action. Seed propagation alone is not a migration mechanism, and overwriting project policies from the seed would destroy deliberate provider, auth, model, cost, and agent-routing choices.

## Goal

Make model policy a versioned, safely migratable Forge configuration surface.

The release containing this change must:

1. correct the activity-alias mismatch in the shipped seed and active policies;
2. introduce an explicit root `schema_version`;
3. migrate the host policy and every Forge-known project policy through `forge upgrade`;
4. preserve every explicit user choice;
5. fail or surface an actionable result when a safe migration cannot be proven;
6. prevent future explicit workflow activities from silently resolving through `map.default`.

## Proposed contract

### Schema identity

```yaml
schema_version: 2
```

- Missing `schema_version` is the legacy v1 shape.
- The current version loads normally.
- A known older version is migrated by `forge upgrade` through ordered version-to-version migrations.
- A newer unknown version fails loudly and tells the operator to upgrade Forge. Forge must never interpret it as the current schema or downgrade it.
- `schema_version` describes file structure and resolution semantics, not which provider or model the operator prefers.
- A future `seed_revision` may separately identify an unchanged generated copy. It must not be conflated with schema version.

### v1 → v2 semantic migration

For `defaults.activity` and for every profile `map`:

```text
if spec-writer is absent and reasoning exists:
    copy reasoning → spec-writer

if fast-orchestrator is absent and fast exists:
    copy fast → fast-orchestrator

if the destination already exists:
    preserve it byte-for-byte

if the destination is absent and the source is also absent:
    do not infer from default; report needs-human-decision
```

Keep `reasoning` and `fast`; the migration adds compatibility aliases rather than renaming the vocabulary. Legacy runtime YAML already uses `spec-writer` and `fast-orchestrator`, so changing workflow activities instead would risk fixing policy mode by breaking legacy mode.

An explicit alias may intentionally select the same model as `default`, but that choice must be represented by an exact alias entry. Absence must not silently stand in for intent.

### Runtime resolution rule

When a workflow or CLI invocation supplies an explicit non-`default` activity, the selected profile must contain an exact mapping for that activity. If it does not, Forge refuses before dispatch with a named `activity_unmapped` policy error showing:

- requested agent and activity;
- selected profile and the rule that selected it;
- available mappings;
- the model that `map.default` would have selected, explicitly labeled as diagnostic only;
- the policy file requiring correction.

`map.default` remains valid for an actual `default` activity and for role fallback when no explicit activity was supplied. It is not an implicit substitute for an explicit named activity.

## Upgrade behavior

`forge upgrade` is the migration authority. Ordinary policy loading must not silently rewrite configuration.

Upgrade must cover:

- the installed model-policy seed;
- `~/.forge/model-policy.yml`;
- the current project policy, if present;
- every existing project policy discoverable through Forge's durable project/run registry.

Required operator modes:

```text
forge upgrade --dry-run
→ enumerate every policy
→ report current / migratable / changed-if-applied / needs-human-decision / newer-unsupported
→ write nothing

forge upgrade
→ migrate every safely migratable policy atomically
→ leave unresolved policies unchanged
→ return a per-file summary and non-success overall result when action remains
```

The migration must be idempotent. A second upgrade produces no content changes and reports the policies as current.

Project discovery must be evidence-based and visible. Forge must list which registered projects were inspected, which paths no longer exist, and which policies were not reachable. It must not claim fleet-wide completion from only the current directory.

User-authored YAML is durable configuration. Migration must preserve comments, ordering where the YAML library permits it, unknown-but-valid future metadata, and all explicit mappings. Use a comment-preserving YAML document representation or an equally safe targeted edit; parse-and-reserialize data loss is not acceptable. Writes must use a temporary file plus atomic replacement, with the original retained or recoverable if validation or replacement fails.

The upgrade command itself must remain runnable when the installed policy is v1, invalid for the new runtime schema, or otherwise in need of migration. It cannot require successful current-version model-policy loading before it can repair that policy.

## Acceptance Criteria

- The shipped `model-policy.example.yml` declares the current `schema_version` and contains exact `spec-writer` and `fast-orchestrator` mappings alongside `reasoning` and `fast` for every shipped selectable profile.
- The shipped default activity table explicitly routes `spec-writer` and `fast-orchestrator`; it does not rely on `defaults.profile` accidentally selecting the same profile.
- Before the correction, a production-boundary test demonstrates `red-narrow + fast-orchestrator` resolving through `map.default` to the host profile's normal model. After the correction/migration it resolves through the exact `fast-orchestrator` mapping to the configured cheap model.
- `spec-writer` resolves through its exact mapping to the configured strong model. Neither test merely asserts the final model; both assert the mapping path/provenance.
- A missing version is read as v1 by the migration command and upgraded to the current version.
- v1 → v2 copies `reasoning` to a missing `spec-writer` entry and `fast` to a missing `fast-orchestrator` entry under both `defaults.activity` and each applicable profile map.
- Migration never overwrites an existing `spec-writer` or `fast-orchestrator` entry, even when it differs from the canonical source alias.
- When neither the destination alias nor its canonical source exists, migration leaves the file unchanged and reports a specific needs-human-decision result; it never copies `default` and calls that verified intent.
- `forge upgrade --dry-run` discovers and reports the host policy plus all Forge-known project policy paths without writing any file.
- Applied upgrade safely migrates host and project policies, reports each outcome, and is byte-stable/idempotent on a second run.
- An unreachable or deleted registered project is reported distinctly from a project that has no policy. Neither is silently counted as migrated.
- Comments and explicit user mappings survive migration. A regression fixture with comments, custom providers/models, custom agent overrides, and pre-existing alias choices proves this.
- A write interruption or validation failure leaves the original policy loadable and unchanged; no partially written YAML becomes authoritative.
- A policy with a newer unknown `schema_version` fails loudly without mutation or downgrade.
- An explicit non-`default` activity missing from the selected profile produces `activity_unmapped` before container dispatch. The error and JSON form include the agent, activity, selected profile, resolution source, available mappings, diagnostic default model, and policy path.
- `forge model resolve`, `forge show`, task manifests, and the dashboard distinguish an exact activity mapping from a default fallback. They never render an unmapped explicit activity as though the selected default model satisfied it intentionally.
- The existing no-policy legacy path continues to resolve workflow aliases through runtime YAML exactly as before.
- Documentation explains schema versioning, project-over-host replacement, upgrade/dry-run behavior, alias migration, explicit-activity failure, and recovery from an unresolved migration.
- Release/upgrade tests cover multiple registered projects with a mixture of absent, v1, current, customized, unreachable, and future-version policies.

## Non-goals

- Choosing new providers or models for the operator.
- Replacing an existing explicit alias mapping with the shipped seed's preference.
- Merging project policy with host policy; project-level full replacement remains the current contract.
- Renaming workflow activities or legacy runtime aliases as part of this migration.
- Treating `schema_version` as a seed-content hash or user-preference revision.
- Building the model-routing visualization/board. This story supplies truthful resolution and migration data that such a board can consume later.

## Evidence and affected surfaces

- `src/v2/model-resolution.ts` resolves `profile.map[capability] ?? profile.map.default` without distinguishing an intentional default activity from an unmapped explicit activity.
- `src/v2/loader.ts` gives a project policy complete precedence over the host policy; it is file-level replacement, not key-level merge.
- `seeds/workflows/feature*.yml` and `security-audit.yml` use `spec-writer` and `fast-orchestrator` repeatedly.
- `seeds/runtimes/claude-*.yml` expose those same legacy aliases.
- `seeds/model-policy.example.yml` and the current host policy instead expose `reasoning` and `fast`.
- The current host resolution is observable as `capability: fast-orchestrator`, `resolved by: defaults.profile`, `model: claude-opus-4-8`.

Propagation surfaces that must change together:

- model-policy schema and loader;
- ordered migration implementation;
- `forge upgrade` and dry-run reporting;
- host/project discovery;
- shipped policy seed;
- active installed host policy;
- existing project policy copies;
- resolver failure/provenance behavior;
- task manifest and durable resolution record;
- `forge model resolve`, `forge show`, JSON output, dashboard, and doctor/setup surfaces;
- documentation and release/upgrade tests.

## Suggested route

This is no longer only a configuration edit because migration and fleet-wide propagation are part of correctness. Use a bounded implementation path with an architecture check focused only on migration ownership, project discovery, YAML-preservation/atomicity, and compatibility behavior. Do not reopen provider selection or redesign the model-policy system.

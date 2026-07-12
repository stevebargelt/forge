---
id: FG-546
type: story
status: active
title: forge init provisions schema-invalid docs-surfaces.yml and cannot repair generated copies
created: 2026-07-12
---

## Problem

`forge init` provisions `.forge/docs-surfaces.yml` from `seeds/docs-surfaces.example.yml`, but the bundled seed is invalid against Forge's production schema. The seed emits object entries with `name`, `kind`, and `path`; `src/v2/contract.ts` requires `surfaces` to be an array of non-empty path-prefix strings. Freshly initialized projects therefore receive configuration that Forge immediately rejects and silently replaces with built-in defaults after warning.

This is live across multiple initialized projects. The known generated object-shaped file is present in constellation, trakt-letterboxd, and forge-scratch-workspace. Pixtron's independently authored string-list file is valid.

The seed is also semantically misleading: its comments describe a catalog of documentation destinations (`README.md`, API reference), while the runtime contract uses these values as operator-facing code/config path prefixes whose changes trigger documentation-impact reconciliation.

Existing setup tests prove only that the file is copied and not clobbered. They never parse the bundled seed through the production loader. Re-running `forge init`/`forge upgrade` preserves existing files, so correcting the seed alone will not repair projects that already received the known-bad template.

## Goal

Make every newly provisioned docs-surfaces file valid and meaningful, detect the known generated-invalid template, and safely repair affected projects without overwriting customized configuration.

## Acceptance Criteria

- `seeds/docs-surfaces.example.yml` conforms to the production `surfaces: string[]` schema and its example values represent operator-facing source/config path prefixes, not documentation destination objects.
- Seed comments and operator documentation accurately explain that a matching changed path indicates an operator behavior surface that may require documentation reconciliation.
- A test loads the bundled seed through the same production parser/resolver used at task dispatch; schema-only duplicate logic is not sufficient.
- Fresh `forge init` provisions the seed and production resolution reports `source: project` with no invalid-config warning.
- `forge init`/`forge upgrade` recognizes the exact known legacy generated object template and migrates it to the corrected generated form. Detection must be content/shape-specific so arbitrary customized files are not mistaken for generated files.
- A customized invalid docs-surfaces file is never overwritten automatically. Setup/upgrade fails visibly or emits an actionable warning naming the file, validation error, and repair action.
- `forge doctor` reports invalid docs-surfaces configuration and distinguishes valid project configuration, missing configuration, the known generated legacy shape, and customized invalid content.
- Dry-run output reports whether docs-surfaces would be created, migrated, preserved, or requires operator repair.
- Tests cover fresh provisioning, exact-template migration, idempotent rerun, customized-valid preservation, customized-invalid preservation plus warning/failure, and production fallback behavior.
- Documentation impact is reconciled for the changed setup, upgrade, doctor, and config contract surfaces.

## Non-Goals

- Expanding the runtime schema to accept the accidental object format merely to preserve the invalid seed.
- Automatically inventing project-specific operator surfaces from arbitrary source trees.
- Overwriting customized project configuration during upgrade.

## Evidence

- `seeds/docs-surfaces.example.yml`: object entries under `surfaces`.
- `src/v2/contract.ts`: `z.array(z.string().min(1))` production contract.
- `src/cli/commands/init.ts`: provisions the seed when absent and preserves existing files.
- `src/cli/commands/init.test.ts` and `init.integration.test.ts`: assert copying/non-clobbering but not production-schema validity.

## Relations

- Pair with FG-446 (interactive backlog prefix) as a setup/init reliability batch.
- Related to FG-291 (stable baseline requires setup validation of docs surfaces).
- Corrective follow-up to closed FG-308 and FG-332, whose provisioning path shipped the invalid seed without a production-loader test.
- Related to FG-349 (dashboard visibility of invalid project config and built-in fallback provenance).

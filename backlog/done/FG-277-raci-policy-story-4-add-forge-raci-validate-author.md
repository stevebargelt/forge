---
id: FG-277
type: story
status: done
title: "RACI policy Story 4: add forge raci validate (authoring-view lint)"
---

**Closed:** 2026-06-05.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

Add `forge raci validate` — a host-INDEPENDENT lint of the human-authored RACI document. Makes no claim about what is installed on any host. (The host-resolvable half is `forge route validate`, Story 5.)

Acceptance:
- Reports parse failures against the Story 1 constrained format.
- Verifies `accountable` is `human` everywhere.
- Verifies `informed` values are from the fixed controlled vocabulary.
- Verifies `responsible` / `consulted` are well-formed SYMBOLIC names of the right kind (agent / workflow / CLI-action / evidence-source) — shape only; existence-on-a-host is route validate's job.
- Reports any force-level rule weakened by the file, checked against the static force-rule baseline shipped with Forge (built-in policy constraints + `seeds/constraints/`), NOT against host state.
- Supports JSON output.
- Tests cover clean RACI, parse error, bad accountable, off-vocab informed, malformed symbolic name, and force-rule weakening.

Relations: #273.
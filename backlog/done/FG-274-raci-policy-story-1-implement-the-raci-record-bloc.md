---
id: FG-274
type: story
status: done
title: "RACI policy Story 1: implement the RACI record-block format + clean vocabulary"
---

**Closed:** 2026-06-04.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

Implement the DECIDED RACI format and clean its vocabulary. Format is settled (see PRD "Constrained RACI Format"): one constrained record block per route — NOT a pipe table, NOT frontmatter, NOT embedded YAML. Record blocks stay visibly RACI-shaped for humans and parse deterministically. The compiler and both validators key off this.

Acceptance:
- Implement the record-block format + brutal parsing rules: one block per route headed by an h3 `route: <key>` marker; fixed lowercase field names; route keys unique; lists comma-separated symbols; `none` the only empty-list sentinel; conditionals as `name:when=condition`; no multiline values; free prose outside blocks ignored.
- Required fields per block: classification_hints, responsible, accountable, path, consulted, required_followups, informed, force_rules. `command` required iff `path: cli`, forbidden otherwise. No generic `target` field.
- `path` enum: in_session, invoke, invoke_chain, workflow, manual, cli. `responsible` is the dispatch target for non-cli paths; for cli, responsible is the action symbol and command is the literal invocation.
- `accountable` is `human` in every block (visible reminder); the compiler hoists it to `governance.accountable: human` and never emits per-route accountable in routing-policy.yml.
- classification_hints are advisory only — never code-dispatched (Forge does not keyword-match prompts into routes); the orchestrator and `forge route explain` may use/surface them.
- `force_rules` is required and parses as `none` or comma-separated symbols; semantic resolution against the static force-rule baseline is deferred to #277.
- `Informed` uses the controlled record/surface vocabulary; `Consulted` is agent roles or evidence sources.
- The file states plainly that the RACI is the human-authored SOURCE that compiles into routing policy (direction RACI -> policy), and removes language implying Markdown prose is the operational policy.

Relations: #273, #253, #252, `seeds/forge-raci.md`.
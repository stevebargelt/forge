---
id: FG-273
type: story
status: done
title: "EPIC: RACI-to-routing-policy system"
closed: 2026-06-21
---

**PRD:** `docs/prds/raci-routing-policy.md`.

Build a provider-neutral routing policy system from Forge's human-readable RACI, to an external-user robustness standard. The RACI stays the human-authored governance SOURCE; the derived routing policy becomes the orchestrator/provider-adapter operational source of truth; two validators keep every authoring path safe.

**Its own epic, not under #253.** Routing governance — a human safely shaping how work is routed — stands on its own whether or not provider adapters ever exist. #253 (provider adapters) is a downstream consumer that renders from the routing policy.

**Core decision:**
- RACI (constrained markdown) = human-authored SOURCE / governance view.
- `routing-policy.yml` = typed machine-readable DERIVED execution policy, compiled from the RACI. Direction is RACI -> policy, never the inverse.
- `forge raci validate` lints the authoring view (host-independent); `forge route validate` lints the operational policy (host-resolvable + drift).
- Provider adapters render FROM the routing policy, not from prose.

**Governance rule:** `Accountable` is always `human` — a policy-level invariant, not a per-row column. Agents and orchestrators execute; the human owns outcomes.

**Authoring:** humans never hand-edit loose prose. RACI-writing paths run `forge raci validate`; direct raw-policy edits are an unsupported expert escape hatch gated by `forge route validate`; the primary channel is orchestrator-mediated (conversation -> propose -> validate -> human-confirm diff -> commit), and a dedicated edit tool is deferred.

**Stories:** the PRD holds the authoritative breakdown; each story is a separate ticket tagged `Epic: #273`. This epic deliberately does NOT re-enumerate stories inline — that inline list is exactly what went stale.

**Relations:** #253 (provider adapter surfaces — downstream consumer), #252 (collaborative setup), #225 (provider/profile choice), #250 (provider-neutral ops primitive), #174 (backlog edit-body verb — needed to maintain these), `seeds/forge-raci.md`, `seeds/orchestrator-template.md`.
---
id: FG-291
type: epic
status: active
title: "[EPIC] Stable, feature-rich Forge baseline"
---

**Captured:** 2026-06-05. This is the commitment set for getting Forge from "powerful internal tool" to a stable, feature-rich baseline worth relying on across real projects and machines.

**Definition:** stable does not mean feature-frozen. It means the core loop is trustworthy, provider-agnostic enough to survive runtime/provider changes, easy to set up on a new machine, and documented well enough that both technical and less-technical stakeholders can understand what Forge is doing.

**Commit first:**
1. **Provider-agnostic runtime architecture / Pi PRD lands.** Accept `docs/prds/provider-agnostic-runtime-pi.md`, reconcile #258/#260-#268 to its framing, and pilot Pi as runtime + upstream-provider separation, not merely a third provider.
2. **Ops/dashboard truthfulness.** Close #290 so stale DB `running` is not shown as ordinary running when filesystem/Docker reality says "reconcile candidate."
3. **Routing control plane hardening.** Finish the RACI/routing follow-through: #287 route-before-dispatch adherence, #285 governance visibility, project overrides dogfooded, and provider adapters kept thin/generated per #253.
4. **Collaborative setup and new-machine readiness.** Advance #252 so `forge init`/`forge upgrade`/doctor flows generate and validate project config instead of asking humans to hand-write YAML.
5. **Docs impact becomes hard to forget.** Build on #289 with enough enforcement or structured checking that operator-facing behavior changes cannot silently ship with unresolved docs impact.
6. **One showcase workflow.** Advance #251 research-synthesis as the feature-rich demonstration: parallel researchers, synthesis, provider/model diversity, auditability, and dashboard visibility.

**Why these first:** they cover the reliability spine (truthful state, routing adherence), the provider future (Pi/runtime split), the onboarding spine (setup/doctor), the maintenance spine (docs impact), and one high-value feature that proves Forge's multi-agent value beyond direct coding.

**Acceptance for the baseline:**
- Pi PRD is tracked and #258's backlog language no longer contradicts it.
- Dashboard/Ops has a tested read-only reconcile-candidate signal.
- Orchestrator dispatch has evidence that routing policy is resolved before work starts, including project override dogfood.
- A new-machine/project setup path validates seeds, runtime image/tool availability, provider auth, model policy, docs surfaces, routing policy, and adapters.
- Implementation runs carry a resolved docs-impact outcome or a filed deferral ticket when operator-facing behavior changes.
- Research-synthesis can run as a coherent Forge workflow or explicitly chosen orchestrator-mediated equivalent with durable task/audit visibility.

Non-goals:
- Dropping Claude Code or Codex immediately.
- Building every future dashboard feature before stabilizing the core loop.
- Treating "feature-rich" as unbounded scope. This epic is about the first baseline, not the whole product roadmap.

Relations: #258, #290, #273, #287, #252, #289, #251, #253, #285.
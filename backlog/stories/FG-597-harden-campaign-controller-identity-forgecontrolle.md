---
id: FG-597
type: story
status: active
title: "Harden campaign-controller identity: FORGE_CONTROLLER_ID is an unauthenticated bearer identity"
created: 2026-07-20
---

## Origin

Surfaced by red-security during the FG-564 (Slice 5b campaign continuation adoption) build review.

## Finding

The campaign-controller lease owner is resolved from the `FORGE_CONTROLLER_ID` environment variable (`src/cli/commands/campaign.ts` `resolveCampaignControllerOwner`). That value is an **unauthenticated bearer identity**: a caller who supplies the live controller's `FORGE_CONTROLLER_ID` can renew or impersonate its lease. `FORGE_CONTROLLER_ID` is forge's established controller-identity mechanism across the durable-continuation system (orchestrator + campaign), so this is a **forge-wide** property, not a FG-564 regression.

## Accepted for FG-564

This is **accepted for FG-564 under the existing trusted single-operator-host model**: forging `FORGE_CONTROLLER_ID` requires host-level access, at which point the actor already controls the forge host (and could edit `~/.forge/forge.db` directly). It does **not** weaken FG-564's lease/concurrency guarantees within that model — the physical-drive fence is anchored by the immutable born-under owner/generation token persisted in `campaign_item_launches` and compared against the live lease, and the fail-closed drive-item path denies when no live lease + matching linkage exists. The forgeable-identity concern is a hardening item for a future multi-actor / reduced-trust posture, not an exploit within the current single-operator threat model.

## Scope

- Bind campaign-controller identity (and, consistently, the orchestrator continuation controller identity) to an unforgeable/authenticated credential rather than a plain env bearer value.
- Revisit alongside any move toward a multi-tenant or reduced-trust host posture (see the pre-launch security-hardening posture — track findings now, harden before real/external users).

## Acceptance criteria

- A forged `FORGE_CONTROLLER_ID` can no longer renew, take over, or impersonate a campaign-controller lease it does not legitimately own.
- The lease/concurrency guarantees FG-564 established remain intact (regression tests still green).
- Documented threat-model note on what trust level this assumes.

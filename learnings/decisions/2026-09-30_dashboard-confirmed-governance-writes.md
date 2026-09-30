# Decision: dashboard-confirmed governance writes through the CLI gate

**ID**: FORGE-DEC-037
**Date**: 2026-09-30
**Status**: Decided
**Decided by**: forge (FG-834 part 1)
**Supersedes**: N/A — REVISES FORGE-DEC-033's D2 boundary and `docs/invariants.md` invariant 15, narrowly, for project RACI/governance writes only
**Scope**: forge
**Elevated from**: N/A

---

## Context

FG-273 shipped the RACI-to-routing-policy authoring gate: `forge-raci.md` is the
human-authored source, `routing-policy.yml` is compiled from it, and `forge raci propose`
/ `forge raci apply --confirm` are the one path that gates and writes a project override —
re-running `raci validate` → compile → `route validate` immediately before every write, and
refusing a candidate that weakens a host force rule. Until this ticket that path was
CLI-only, full stop — no dashboard route touched it at all, consistent with FORGE-DEC-033's
D2: "authorizing or stopping unattended container execution is a materially larger
capability [than planning writes] and stays CLI-only."

FG-822 later gave the dashboard a **confirm**, not a decide, channel for a different closed
set of CLI-decided actions — gate, retry, recover — each a `POST` that shells exactly one
named verb, with eligibility decided server-side so a button the CLI would refuse is never
offered. FG-834 part 1 asks whether a project RACI apply — a human deciding *who is
accountable for what kind of work* — can get the same treatment: confirmed from the
dashboard a human is already looking at, while the actual gate stays exactly where FG-273
put it.

---

## Problem

How does a human confirm a project RACI change from the dashboard's unauthenticated
loopback surface without widening the write authority `forge raci apply --confirm` already
has from a terminal — no new reach to the host RACI, no `--force`, no route to
`route compile` or `raci validate`, and no path an agent (rather than a human) can drive?

---

## Options Considered

### Option A: a second writer, in-process (the Remote Board precedent)

Give the dashboard its own atomic store authority for the RACI write, mirroring FG-783's
`applyRemotePlanningCommand` — one transaction covering precondition, write and audit,
never shelling a child process.

**Pros**:
- No child-process latency; one atomic commit.

**Cons**:
- **Two writers of `forge-raci.md` / `routing-policy.yml` / `raci-audit.log`.** FG-273's
  whole design is a SINGLE gate that re-runs immediately before every write; a second
  implementation of "propose then apply" is a second place that gate logic can drift from
  the CLI's, which is exactly the divergence FORGE-DEC-015 (CLI as the sole mutation
  entrypoint) exists to prevent. The Remote Board's in-process authority was justified by a
  cross-process atomicity requirement (replay-resistant ledger + mutation in one
  transaction) that has no analogue here — nothing about a RACI apply needs to be atomic
  with anything else.

### Option B: two more rows in the existing closed mutation registry, gated by a UI-honesty precondition ✅

Add `POST /api/raci/propose` and `POST /api/raci/apply` as two more `ACTION_ROUTES` rows
(the same registry FG-822/FG-823 already use), each shelling the identical CLI argv a
terminal would run. `apply` is additionally refused, server-side, before any spawn, unless
the same candidate bytes were proposed green for the same checkout within a 15-minute
window, the caller types the project key back, and a rationale is given.

**Pros**:
- **Exactly one writer, unchanged.** `forge raci apply --confirm` is still the only code
  that writes the project override, recompiles the policy, and appends the audit line —
  from a terminal or from the dashboard, it is the same binary doing the same gate.
- The three dashboard-side preconditions (proposal window, typed confirm, rationale) are
  **UI honesty, not authority**: they make the confirm feel as deliberate as a terminal
  `--confirm` typed by someone who just read the diff, but a request that skipped all three
  still hits the identical CLI gate and can still be refused by it. Removing them would not
  create a security hole; it would only make the *confirm* casual.
- Matches FG-822's already-accepted shape: dashboard confirms, CLI decides.

**Cons**:
- Two more rows the closed-registry source guard (`claude-md-mutation-parity.test.ts`,
  the `ACTION_ROUTES` assertions) must keep enumerating forever.
- The proposal window is in-memory per dashboard process — a restart forgets a green
  propose, which only ever costs a re-propose, never a false accept.

---

## Decision

**Chose**: Option B — two more closed-registry rows, shelling the unchanged CLI gate.

**Rationale**: the write authority was never the thing in question — `forge raci apply
--confirm` already exists, is already gated, and already audits. What FG-834 part 1 adds is
a second **confirm** surface for a human who is already in the dashboard, on the same terms
FG-822 already established for gate/retry/recover. Giving the dashboard its own writer
(Option A) would create a capability that does not exist today (a second RACI-writing code
path) to solve a problem (confirmation ergonomics) that does not need one.

---

## Consequences

**Positive**:
- A RACI change confirmed from the dashboard is indistinguishable, at the point of write,
  from one confirmed at a terminal — same gate, same compiled policy, same audit log shape,
  now additionally carrying `actor: "dashboard"`, `source: "dashboard"` and the rationale
  verbatim so the record itself says which surface it came from and why.
- No widening of what the dashboard can cause to be written: no host RACI, no `--force`, no
  route to `route compile` or `raci validate` exists on either row, enforced by the same
  closed-registry-plus-source-guard discipline FG-822/FG-823 already use.

**Negative / Trade-offs**:
- The registry and its parity tests grow by two rows that must stay enumerated correctly
  forever (`dashboard/src/claude-md-mutation-parity.test.ts`,
  `dashboard/src/fg834-raci-enforcement.test.ts`).
- A reader who sees "the dashboard can apply a RACI change" without reading
  `raci-mutation.ts`'s own header comment could mistake the proposal window / typed confirm
  / rationale for the authority boundary, rather than the CLI gate underneath it. Mitigated
  by naming this explicitly here and in `docs/concepts.md`.

**Risks**:
- If a future change adds a new `forge raci` verb or flag without updating
  `buildRaciArgv`'s fixed argv shape, it would need to be reached through the same closed
  builder — the risk is the same "unregistered argv" class FG-822 already defends against,
  not a new one.

---

## Implementation Notes

- `dashboard/src/raci-mutation.ts` is the whole of the dashboard-side addition: the
  `ProposalWindow` (15-minute, 256-entry-bounded, in-memory), the request shape, the four
  named `apply` refusals (`rationale_required`, `rationale_invalid`, `confirm_key_mismatch`,
  `candidate_not_proposed`/`candidate_changed`), the fixed argv builder, and the scratch-file
  lifecycle (`$FORGE_HOME/dashboard/raci-candidates/`, never the project — the candidate
  text never reaches argv, only its scratch path does; `candidate_sha256` is the durable
  identity once the scratch file is removed).
- `src/cli/commands/raci.ts`'s `apply` gained `--by`, `--rationale` and `--source
  {dashboard}` — attribution recorded on the audit entry (`actor`, `rationale`, `source`),
  never a gate input. The gate itself (`applyRaciChange`) is byte-for-byte what it was
  before FG-834.
- This does not touch FORGE-DEC-033's D2 as it applies to the queue: arming/disarming
  autonomous dispatch, `max_active_runs`, and `forge queue cancel` remain CLI-only,
  unreached by any dashboard route. D2's own test — "is this materially larger than
  reordering a list" — still answers "yes, stays CLI-only" for those; a *confirmed* RACI
  apply is not new decision authority, only a new front door onto authority FG-273 already
  granted `forge raci apply --confirm`.

---

## Revisit Conditions

- If a second RACI-writing code path is ever proposed (an in-process authority, a bulk
  import, a sync job), re-open Option A's rejection here rather than assuming it was never
  considered.
- If the dashboard RACI editor (FG-834 part 2) needs authority beyond confirming an
  already-proposed candidate — e.g. proposing without a prior terminal round trip, or a
  bulk/multi-route apply — that is new surface area and needs its own decision, not a quiet
  extension of this one.

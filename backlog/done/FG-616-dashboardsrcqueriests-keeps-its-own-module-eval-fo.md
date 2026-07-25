---
id: FG-616
type: story
status: done
title: dashboard/src/queries.ts keeps its own module-eval FORGE_HOME/DB_PATH snapshot — same latent shape as the FG-607 store-path bug
created: 2026-07-25
closed: 2026-07-25
---

## The latent bug

`dashboard/src/queries.ts:45-46` takes its OWN module-evaluation snapshot of `FORGE_HOME` / `DB_PATH`, independent
of `src/util/paths.ts`. That is the same shape as the defect FG-607 hit in CI: a value captured when the module is
first evaluated, used later by code whose environment was set afterwards.

**Not currently reachable, which is why it was left alone.** `queries.ts` is only entered through the
dynamically-imported `server.ts`, so by the time it evaluates, the environment is already set. It is a latent
trap, not a live bug — flagged by the engineer during FG-607 round 4 and deliberately not swept into that fix.

## Why it is worth closing anyway

FG-607 round 4 fixed exactly this shape in `src/util/paths.ts` and the symptom was severe and silent: the store
opened a DIFFERENT host's `forge.db`, and `GET /api/backlog` returned **0 tickets while `listTickets()` returned
3** in the same process. Four dashboard test files failed with no diagnostic, because a bare `catch {}` turned the
error into an empty list. A second module holding the same kind of snapshot re-arms that trap for whoever next
changes the dashboard's import order.

The fix that landed in FG-607 is the pattern to follow (`src/util/paths.ts`): keep the process-start const for the
many call sites that legitimately want it, and resolve the STORE PATH at open time, because that is the one path
whose staleness reads and writes another host's data rather than merely misnaming a directory. Same expression,
two consumers — never two definitions.

## Scope

- Make `dashboard/src/queries.ts` derive its store path from the shared resolver (`resolveDbPath()`) instead of its
  own snapshot.
- Check for any other module-eval `FORGE_HOME` / `DB_PATH` snapshots while in there — grep rather than trusting
  this ticket's list.
- A regression test only if one can be written that actually fails against the current source; if the condition is
  genuinely unreachable today, say so in the commit rather than manufacturing a test that proves nothing.

## Acceptance Criteria

- No module in `dashboard/` holds an independent module-eval snapshot of the store path.
- `cd dashboard && npm run test:integration` stays green.
- If a reachable failure case is found while fixing it, it gets a regression test.

## Relations

Follow-up from FG-607 round 4 (`src/util/paths.ts` `resolveDbPath()`), flagged by the implementing engineer.

---

## Closed 2026-07-25 — folded into FG-608

Latent, not reachable in the dashboard's current single-home usage, and on a surface FG-608 already owns (seam-bypassing dashboard readers). Recorded there; fix lands with the seam migration.

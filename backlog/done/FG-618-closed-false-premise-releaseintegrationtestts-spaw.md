---
id: FG-618
type: story
status: done
title: "CLOSED (false premise): release.integration.test.ts spawns already inherit a disposable FORGE_HOME from test-setup.ts"
created: 2026-07-25
closed: 2026-07-25
closed_commit: c29264d
---

## CLOSED — false premise, verified

Filed and closed 2026-07-25 without work. Recorded so the observation is not re-filed.

## What the ticket claimed

That `runEntryUnderHostilePath` and three other release-entry spawns in
`src/v2/release.integration.test.ts` pass the **ambient** `FORGE_HOME`:

```
FORGE_HOME: process.env.FORGE_HOME ?? ""
```

rather than a disposable one — an unpinned ambient dependency worth hardening.

## Why that is wrong

`src/test-setup.ts:6-7` assigns a disposable home before any test runs:

```
const tempHome = mkdtempSync(join(tmpdir(), "forge-test-"));
process.env["FORGE_HOME"] = tempHome;
```

and `scripts/run-integration-tests.sh` hardcodes `--import ./src/test-setup.ts` into the only
supported invocation of this tier. So `process.env.FORGE_HOME` is ALREADY a per-process temp
directory at the point those spawns read it. It never resolved to the operator's real `~/.forge`.

The ticket's framing — "ambient" — invited the reading "the operator's", which is what made it look
like hardening. It is not.

## The only genuine residual

`buildHome` is a *finer-grained* disposable home: a separate temp dir per suite, so the interpreter
store (FG-571) does not accumulate inside the shared per-process test home. Passing it to those four
spawns instead of the inherited one is a marginal tidiness improvement with no correctness or
isolation impact.

Not worth its own pipeline. If FG-617 changes this file for other reasons, folding in the four-line
change is fine; it does not need to be tracked as scope.

## Process note

This ticket was created by promoting an implementer's in-result observation into the backlog without
verifying its central factual claim. The observation was accurate about the CODE (`?? ""` is what the
spawns pass) and misleading about the CONSEQUENCE (that this reaches an operator-owned location).
Verify the consequence, not just the code, before filing.

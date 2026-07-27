---
id: FG-634
type: story
status: active
title: "FG-566 follow-up: readiness records and events persist the setup command and unredacted stderr, and forward HOME to the setup child (npmrc registry-auth token reach)"
created: 2026-07-27
---

Deferred from the FG-566 build-phase red re-check (2026-07-27). Three related findings about what
host-readiness writes down and what it hands the setup child. None blocks FG-566's own invariant —
after FG-566's fixer round the setup command is **operator-authored host config**, not attacker-
authored workspace content — so these are hardening, not the trust-boundary defect FG-566 fixed.

## Findings

**1. The setup command is persisted and now has a dashboard surface** (red-security, medium).
The durable readiness record writes `setupCommand`, `host_readiness.ready` logs it, and FG-566's
FIX 6 widened the dashboard task timeline to include run-scoped readiness events — so an operator's
configured bootstrap command is now visible wherever that timeline renders. If an operator's
`hostVerificationSetup` embeds a credential (a registry token, a private-mirror URL with basic auth),
it is written to the event store and displayed.

**2. `stderrTail` is persisted unredacted** (red-security, medium).
The refusal payload records `stderrTail` straight from the setup command's combined output. Package
manager failures routinely echo registry URLs and occasionally auth material. FG-566 suppresses
lifecycle scripts, which removes the *attacker-controlled* path into this field, but an ordinary
`npm ci` failure against an authenticated registry can still put credentials there.

**3. `HOME` is forwarded to the setup child** (red-backend, low).
`src/v2/host-readiness.ts:381` includes `HOME` in `SETUP_ENV_PASSTHROUGH`, alongside
`NPM_CONFIG_USERCONFIG` at `:384`. That transitively grants the install access to `~/.npmrc` registry
auth tokens and to `~/.forge`. FG-566's lifecycle-script suppression is the only remaining barrier
between a dependency tree and those tokens.

`HOME` is not gratuitous — npm needs a home for its cache and user config — so this is a real
trade-off rather than an oversight. The question is whether the setup child should get the operator's
real `HOME` or a scoped one.

## Why deferred rather than folded into FG-566

FG-566's stated invariant is that the workspace under test supplies data only and the operator
supplies the command; that invariant is met and was independently verified (red-backend confirmed
`HostReadinessRequest` has no `configDir`, and that `resolveSetupCommand` reads only
`FORGE_HOST_VERIFICATION_SETUP`, `hostConfigPath()`, then a literal `npm ci`). These three are about
protecting **operator-owned** secrets from **operator-visible** surfaces, which is a different
boundary and a broader one — the same questions apply to other Forge subsystems that persist command
output.

## Acceptance criteria

1. Decide and record the policy: which of these fields are operator secrets, and what is the
   redaction rule. A stated "no redaction, these surfaces are local-only and trusted" is an
   acceptable outcome IF it is written down with its reasoning — silence is not.
2. If redaction is adopted: `setupCommand` and `stderrTail` are redacted on the way into the durable
   record and the event payload, not merely at render time, with a negative test that a
   credential-shaped value does not reach the store.
3. Decide whether the setup child gets the real `HOME` or a scoped one. If scoped, npm must still
   resolve a usable cache and the change must not silently break private-registry installs that
   currently work — cover that case.
4. Whatever is decided, it must not weaken FG-566's boundary: the command still comes from operator
   host config, never from the workspace under test.
5. `forge-test` green; required CI checks green.

Refs: FG-566 (the readiness contract these fields belong to), `src/v2/host-readiness.ts` around
`SETUP_ENV_PASSTHROUGH` (:381-384) and the evidence/refusal record shapes, FG-566's FIX 6 dashboard
timeline widening. Sibling deferrals from the same review: FG-631, FG-632, FG-633.

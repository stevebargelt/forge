---
id: FG-499
type: story
status: done
title: "forge claude preflight: advisory-only, never hard-block — native claude/AWS auth owns interactive failure"
created: 2026-07-08
closed: 2026-07-08
closed_commit: 3c75f9e07992c76a0d932df715378d3f7d28b994
---

## Problem

FG-435 (shipped, PR #68) made the `forge claude` STS/SSO preflight profile-scoped and made `aws configure export-credentials` authoritative — but it retained a hard block (exit 1) for the case where the export probe ALSO fails. Operator direction 2026-07-08 after live production use on the work laptop: the preflight fired correctly as an advisory and the session authenticated fine — "we just don't need to block anything. Claude knows how to auth."

For an INTERACTIVE host-side `claude` session that is correct: if creds are genuinely broken, native claude/AWS auth surfaces its own actionable error (or an interactive login flow) — a forge-side exit 1 just adds a wall in front of a tool that can handle the situation itself.

## Goal

`forge claude` preflight never exits non-zero for credential-staleness reasons. Every current hard-block path (stale mtime + failed export; expired SSO + failed export) becomes a clearly-labeled warning carrying the SAME profile-named, timezone-labeled diagnostics and remediation text, then launches anyway.

## Scope nuance (keep this distinction)

- `forge claude` (interactive host session): advisory-only. This ticket.
- `validateCredsForNewRun` (`forge next`/`forge new` container dispatch): KEEPS its gate. Containers get creds via env-snapshot injection at spawn; a dispatch with a failed export produces an opaque mid-run container failure and burns a spin-up. This is the "mode that genuinely needs credentials before spawning" carve-out FG-435's own AC named. Not changed here.

## Acceptance criteria

- [ ] No credential-staleness/expiry condition makes `forge claude` exit non-zero; the two former hard-block paths print warnings (same diagnostic content, marked advisory) and proceed to launch.
- [ ] `validateCredsForNewRun` behavior unchanged (regression test asserting the container-dispatch gate still blocks on failed export).
- [ ] Integration tests updated: former exit-1 shapes now assert launch-proceeds + warning text.
- [ ] docs/quick-start.md preflight passage updated (it currently documents the hard-block paths).

## Refs
- FG-435 (PR #68) — lineage; its AC specified the retained hard block this ticket removes for the interactive surface.
- Operator direction 2026-07-08 (work-laptop production validation: advisory fired, auth succeeded natively).

---
id: FG-574
type: story
status: done
title: package.json engines >=22 contradicts FG-570 exact-ABI preflight — reconcile the declared Node support
created: 2026-07-16
closed: 2026-07-16
closed_commit: 5044c5d
---

**Parent:** FG-553 (Slice 1) · **Surfaced by:** FG-573/FG-570 docs-impact pass

## Problem

**RESOLVED WITHIN FG-570 — this ticket closes with it; no separate work remains.**

FG-570 replaced the CLI's minimum-major Node floor with an **exact ABI equality** preflight: forge refuses to start on any Node whose ABI ≠ the binding's (137 / Node 24), older **or** newer, with a named message. When this ticket was filed, `package.json:38` still declared `engines: { "node": ">=22" }` — a minimum-major floor advertising Node 22 (ABI 127) and Node 25/26 (ABI 141/147) as supported, all of which the runtime refuses at startup, so `npm install` under one of them warned about nothing and forge then refused to run.

FG-570's review took the engines contradiction in-scope rather than deferring it: `package.json` now ships **`engines: { "node": "^24" }`** — the ABI-137 range (all Node 24.x share ABI 137; Node 25 is ABI 141), matching the runtime guard and `.nvmrc`. The "keep it loose" alternative below was not taken; `engines` now gives the earlier, consistent install-time signal. It must be bumped together with `.nvmrc` when the repo moves LTS.

Also: README and `docs/work-laptop-setup.md` were reconciled to the exact-ABI requirement by FG-570 (`5044c5d`) — both now state that a matching ABI is the requirement and the `.nvmrc` pin is the tested way to obtain it, rather than naming an exact Node version. With `engines: "^24"` shipped, **no Node-support surface remains un-reconciled.**

## Decision made (config policy)

`engines.node` expresses the **ABI-137 range** — `"^24"`: all Node 24.x minors share ABI 137; Node 25 = ABI 141. This matches the runtime guard and gives an install-time warning on a mismatched Node. The alternative (keep it loose, rely solely on the runtime preflight) was **not** taken.

The runtime guard (FG-570) is authoritative regardless; `engines` is the earlier, consistent signal. It tracks `.nvmrc` and must bump with it.

## Acceptance

- `engines.node` no longer advertises a Node the FG-570 preflight refuses (or an explicit, recorded decision to keep it loose with the rationale).
- If pinned: a comment or doc note ties it to `.nvmrc` / the ABI so it is bumped together.

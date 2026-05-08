# Decision: Make the dashboard interactive (write endpoints, gate buttons, run-next)

**ID**: FORGE-DEC-015
**Date**: 2026-05-07
**Status**: Decided
**Decided by**: Steven (architectural call after the design-pivot day)
**Supersedes**: N/A
**Scope**: forge

---

## Context

The dashboard today (`src/dashboard/server.ts` + `src/dashboard/html.ts`) is read-only. It surfaces runs/tasks/verdicts/gates from the SQLite blackboard, but every action (gate decision, run-next, run-creation) requires the user to drop to a terminal and type a `forge` CLI command.

That was fine when forge was small. It's becoming friction now: BACKLOG #34/#35/#48 all describe pieces of "make the dashboard the primary UX," and FORGE-DEC-014's pivot makes the dashboard the natural home for design review (PNG renders, gate decisions, brief authoring). The dashboard needs write semantics.

Tonight's design pass at `~/code/forge-design/` produced concrete designs for the gate-decision UI, the design-task review screen, and the awaiting_gate detail. We have a target. Time to commit to the architecture.

---

## Problem

How does the dashboard's HTTP server, which currently only serves GETs, gain mutation capabilities (gate, dispatch next phase, etc.) safely and simply on a personal-Mac developer setup?

Specifically:
1. Where does the actual mutation logic live — re-implemented in the dashboard process, or shelled out to the existing `forge` CLI?
2. What's the security model for a localhost server that mutates state?
3. Should we go further and turn the dashboard into a native (Electron) app?

---

## Options Considered

### Option A: dashboard becomes a thick Express app, reimplements gate/dispatch logic in-process

Add POST handlers in `src/dashboard/server.ts` that import `gate.ts`, `next.ts`, `spawn.ts` directly and run the operations in-process.

**Pros**:
- Tightest integration. No process spawning.
- Easier to surface errors in the dashboard UI.

**Cons**:
- Splits the truth in two. `forge gate` and `forge next` (CLI) and the dashboard would diverge over time, and one set of gate semantics is hard enough.
- The dashboard process becomes long-running and stateful. Today it can be killed and restarted with no side effect on runs. With in-process spawn, killing it mid-task could orphan a docker child.
- Tests get harder: dashboard endpoints would need to be tested against real spawn behavior.

---

### Option B: dashboard shells out to the `forge` CLI for mutations ✅

Add POST handlers but their job is to validate the request, then spawn `forge gate ...` / `forge next ...` as a subprocess. The CLI is the single source of truth for mutation semantics.

**Pros**:
- Single source of truth. Whatever `forge gate` does on the command line, the dashboard's gate button does.
- Dashboard process stays thin. Killing/restarting it during a long task has no effect; the spawned `forge` process is the one doing work.
- Forge's existing tests for gate/next continue to validate the dashboard's behavior transitively.
- Matches the principle BACKLOG #35 already articulated: "Dashboard shells out to the `forge` CLI for actions; doesn't reimplement spawn/gate logic."

**Cons**:
- Subprocess spawn overhead per action (negligible in absolute terms, but worth noting).
- Streaming progress to the UI (e.g. "task 2 of 5 dispatched") is harder than in-process — requires reading the subprocess's stderr/stdout. Acceptable for v1; can revisit.

---

### Option C: defer interactivity entirely; build a different surface (TUI, native app, etc.)

**Pros**:
- Could leapfrog the browser-tab UX problem.

**Cons**:
- Today's dashboard is a real localhost web app and works. Throwing it away to build something fundamentally different (especially a TUI) doesn't serve the goal — the dashboard has visual surface (PNG previews, finding cards, gate audit history) that benefits from a real graphical UI.
- Electron (the most reasonable variant of "different surface") makes sense LATER as a wrapper around a mature SPA. Doing it now means rebuilding the SPA AND adding native chrome at once.

---

## Decision

**Chose**: Option B — dashboard shells out to the `forge` CLI for mutations.

**Rationale**:
- Aligns with BACKLOG #35's existing principle and avoids re-litigating it.
- Keeps the dashboard process as the thin presentation layer it should be.
- The CLI subprocess overhead is irrelevant compared to the agent dispatch costs forge runs do.
- Defers Electron until the SPA is mature enough that wrapping it (rather than rebuilding it) is straightforward (BACKLOG #61).

---

## Consequences

**Positive**:
- The dashboard becomes a real control surface without doubling forge's mutation surface.
- Gate audit trail is unchanged: every gate flows through the same `forge gate` path that records to SQLite, regardless of whether the human used CLI or browser.
- Iteration is fast. Add a POST endpoint, add a button on the SPA, click → it shells out → forge does what forge does.
- The architecture is portable: when Electron eventually happens (BACKLOG #61), the wrap is "BrowserWindow loads the existing dashboard SPA," not "rewrite the dashboard."

**Negative / Trade-offs**:
- Subprocess pattern means the dashboard server needs error handling for `forge` failures (non-zero exit, stderr surfacing). Not hard, but real work.
- For very long operations (`forge next` on a heavy phase), the dashboard has to stream progress somehow — initially probably just "running..." spinner + final result. SSE or websockets for live progress is a v2 concern.

**Risks**:
- The CLI's argv contract is what the dashboard depends on. Changing CLI flags (renaming `--rationale`, etc.) breaks the dashboard. Mitigation: covered by the existing "if you change a CLI flag, update the relevant doc in the same commit" rule in CLAUDE.md — extend it to "and the dashboard."
- A bug in the CLI that corrupts state is now reachable from the browser. But the same bug is reachable from any terminal; the dashboard isn't introducing new attack surface, just new ergonomics.

---

## Implementation Notes

### Endpoints (sketch — refine in #57)

```
POST /api/gate/:taskId
  body: { decision: "advance" | "reject" | "request-changes", rationale?: string, force?: boolean }
  shells out: forge gate <taskId> <decision> [--rationale "..."] [--force]
  returns: { taskId, status: "complete"|"failed"|..., nextTasks: [...] } from the CLI's exit info

POST /api/next/:runId
  body: { project?: string }
  shells out: forge next <runId> [--project <path>]
  returns: { kind, tasks } matching forge next's existing output

POST /api/runs
  body: { workflow, title, brief?, prd?, question?, project?, meta? }
  shells out: forge new <workflow> "<title>" [...flags]
  returns: { runId }
```

The full CLI ↔ HTTP mapping should match `forge --help` exactly so users can switch back and forth without learning two vocabularies.

### Security model

**Localhost-only is the security boundary.** Forge is a personal-Mac developer tool; if your machine is compromised, forge being interactive isn't your top concern. That said, two cheap mitigations:

1. **Bind to `127.0.0.1`** (not `0.0.0.0`). Already true; codify it in `server.ts` with a comment.
2. **Require a custom header on all mutating endpoints** (e.g. `X-Forge-Request: 1`). This blocks the only realistic remote attack: a malicious site you visit POST'ing a `<form>` to `localhost:<port>`. Plain HTML forms can't set custom headers; they'd be CORS-preflighted and either rejected or visible.

That's it. **No CSRF tokens. No auth. No HTTPS.** Anything more is paper armor on a localhost dev tool.

### What we're NOT doing

- **No streaming logs to the browser in v1.** Run a `forge next` from the dashboard, see "Running..." then the final result. SSE/WebSockets is v2.
- **No reimplementation of any mutation in-process.** Always shell out.
- **No multi-user / RBAC / share-this-link.** Localhost-only is the model.
- **No HTTPS or auth.** Same reason.
- **No Electron yet.** BACKLOG #61 — defer until the SPA is mature.

### CSS/HTML approach for the SPA

The dashboard today is server-rendered HTML strings in `src/dashboard/html.ts`. Interactive UI needs JS — at least for the gate-button POST and rationale handling. Two paths:

1. **Sprinkle vanilla JS in the existing HTML** — minimal footprint, no build step. Probably right for v1.
2. **Introduce a real frontend framework** (Preact, Svelte, etc.) — better DX for complex UI.

(1) is the right call now. The existing dashboard server has no build pipeline (matches forge's "tsx runtime, no build" decision in DEC). Keep that property. If complexity overwhelms vanilla JS later, revisit.

---

## Revisit Conditions

- **The dashboard's interactive surface gets complex enough** (multiple modals, drag-and-drop, real-time updates, large state) that vanilla JS becomes painful. Then introduce a real framework.
- **Electron becomes warranted** (BACKLOG #61). Wrap the existing SPA in `BrowserWindow`, add native chrome — no rewrite of the dashboard itself.
- **Forge becomes multi-user or non-local.** Then real auth, real CSRF, real session model. Today's localhost assumption goes out the window. None of that is on the roadmap.
- **The CLI ↔ HTTP mapping ever gets hard to maintain.** Then maybe extract a thin shared layer (an internal `forgeOps` library that both `cli/` and `dashboard/` import). Don't do this preemptively.

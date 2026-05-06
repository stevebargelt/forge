# Decision: tsx + bin/forge shim, no compiled dist

**ID**: FORGE-DEC-005
**Date**: 2026-05-06
**Status**: Decided
**Decided by**: Claude Code (forge build)
**Supersedes**: N/A
**Scope**: forge

---

## Context

A TypeScript Node CLI can either be (a) compiled to JavaScript at build time and shipped as `dist/`, or (b) run directly via `tsx` (or `ts-node`). The right choice depends on distribution model.

---

## Problem

**Should forge ship as compiled JS, or run from TypeScript via tsx?**

---

## Options Considered

### Option A: Compiled `dist/` shipped as the entrypoint

**Pros**:
- Zero TypeScript dependency at runtime
- Predictable startup performance

**Cons**:
- Need a build step before every change is testable
- `dist/` either gets committed (noisy) or built on `npm install` (slows install)
- Overkill for a personal CLI — there's no "user" who isn't also "developer"

---

### Option B: tsx via a thin shim ✅

`bin/forge` is a tiny Node script that spawns `tsx` against `src/cli/index.ts`. Source files are the only thing that exists; no `dist/`.

**Pros**:
- Edit any source file, run `./bin/forge ...` immediately — no build wait
- One source of truth (the .ts files)
- `package.json` still declares the bin so `npm link` works for symlinking

**Cons**:
- ~200ms tsx startup overhead (negligible for an interactive CLI)
- Requires `tsx` as a dev dependency

---

## Decision

**Chose**: Option B — tsx via shim

**Rationale**: forge is a personal tool. The "developer" and "user" are the same person; the extra build step buys nothing. The shim approach makes editing-and-running a tight loop, which is the primary workflow during build. A future `npm run build` is still trivially available (`tsc -p .`) for environments where tsx isn't desired.

---

## Consequences

**Positive**:
- Edit source → run immediately. No "did I rebuild?" thrash
- The shim is six lines and depends only on `tsx`'s presence in `node_modules/.bin/`

**Negative / Trade-offs**:
- ~200ms cold-start overhead per invocation
- `tsx` is a real dependency, not just a dev convenience — moving it to `dependencies` would be necessary if forge were ever published

---

## Implementation Notes

- `bin/forge` is a Node script (not a shell script) so it works the same on macOS and Linux
- It resolves `tsx` from the local `node_modules/.bin/tsx` to avoid PATH issues
- `package.json` declares `"bin": { "forge": "./bin/forge" }` so `npm link` (or `npm install -g`) wires up a global `forge` command
- A `npm run build` target (`tsc -p .`) is wired up but unused day-to-day; it's there for future packaging

---

## Revisit Conditions

- If forge is ever distributed to a user who doesn't have TypeScript tooling, switch to a compiled dist
- If startup latency becomes user-visible (e.g., interactive completions), pre-compile

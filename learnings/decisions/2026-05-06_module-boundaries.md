# Decision: TypeScript module boundaries — cli / spine / store / types / util / workflows

**ID**: FORGE-DEC-003
**Date**: 2026-05-06
**Status**: Decided
**Decided by**: Claude Code (forge build)
**Supersedes**: N/A
**Scope**: forge

---

## Context

The spine sketch specifies the primitives (`next`, `dispatch`, `spawn`, `spawnRed`, `gate`, `composeSystemPrompt`) and the SQLite schema, but it doesn't dictate the source-tree layout. With ~900 LOC across many concerns (CLI, DB access, agent spawning, workflow loading, constraints, etc.), some structure is needed up front to keep the dependency graph clean.

---

## Problem

**How should the forge source tree be partitioned?**

---

## Options Considered

### Option A: flat `src/` with all files at the top level

**Pros**: shortest import paths.

**Cons**: by ~20 files the directory becomes hard to scan; no signal about what depends on what.

---

### Option B: module-per-feature (`feature/*.ts` per phase or per agent)

**Pros**: per-feature locality.

**Cons**: forge's primitives are general; phases/agents are *data*, not modules. Module-per-feature would scatter the spine code.

---

### Option C: layered by concern ✅

```
src/
├── types/        Authoritative TypeScript types (no runtime deps)
├── store/        SQLite tables + accessors (depends on types only)
├── util/         paths, ids, creds, watchdog (depends on types)
├── spine/        primitives — composeSystemPrompt, spawn, spawnRed, dispatch, next, gate
│                 (depends on store + util + types + workflows)
├── workflows/    one TS file per workflow (depends on types only)
└── cli/          subcommand registrations (depends on spine)
```

**Pros**:
- Dependency graph flows in one direction: cli → spine → (store + workflows + util) → types
- Each layer has one job
- A change in one workflow file touches `workflows/`, not the spine
- `types/` is the contract; both store and spine depend on it but never on each other circularly

**Cons**:
- Slightly longer import paths than a flat layout

---

## Decision

**Chose**: Option C — layered by concern

**Rationale**: The spine sketch already separates the concerns implicitly (types in one section, schema in another, primitives in another). Encoding that in the source tree makes the dependency graph self-evident and prevents the kind of accidental cross-cuts that turn into circular imports later.

The `cli/` layer specifically depends only on `spine/`, never on `store/` directly. This keeps "what the CLI does" expressed in spine vocabulary (e.g., `dispatch`, `gate`) rather than in store vocabulary (e.g., `insertTask`).

---

## Consequences

**Positive**:
- File location is predictable from file role
- Dependency graph is acyclic by construction
- Adding a new workflow doesn't touch the spine

**Negative / Trade-offs**:
- One extra directory level on imports

---

## Implementation Notes

- ES modules with explicit `.js` import suffixes (TypeScript convention for `module: "ESNext"`)
- The `tsconfig.json` uses `"moduleResolution": "bundler"` to avoid the `.ts` vs `.js` import dance, and `noUncheckedIndexedAccess` for safer array access
- `cli/commands/<name>.ts` exports a single `register<Name>(program)` function — keeps each subcommand self-contained

---

## Revisit Conditions

- If a future feature introduces a strong cross-cut (e.g., live observability), revisit whether a `obs/` or similar layer makes sense
- If the spine grows a separate "scheduler" concept, it should likely move from `spine/` to its own layer

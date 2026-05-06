# Decision: Use Commander.js as the CLI framework

**ID**: FORGE-DEC-002
**Date**: 2026-05-06
**Status**: Decided
**Decided by**: Claude Code (forge build)
**Supersedes**: N/A
**Scope**: forge

---

## Context

Forge has a small, fixed CLI surface: five subcommands, each with a few options. The CLI parsing layer should be light — there is nothing exotic to express.

---

## Problem

**Which Node CLI framework — if any — should forge use?**

---

## Options Considered

### Option A: hand-rolled `process.argv` parsing

**Pros**: zero dependencies.

**Cons**: subcommand routing, help text, option parsing, and error messages all need to be reinvented. For 5 subcommands with options, that's noise.

---

### Option B: Commander.js ✅

**Pros**:
- One small dependency, zero peer deps
- Subcommand syntax is one-liner-per-flag
- Auto-generated `--help` per subcommand
- Async actions work natively (`.action(async () => …)`)

**Cons**:
- Adds ~30kb to install size (irrelevant)

---

### Option C: yargs

**Pros**: rich middleware, validation.

**Cons**: API surface is bigger than forge needs; configuration verbosity outweighs the benefit at this scale.

---

### Option D: oclif

**Pros**: scaffolding, plugin architecture.

**Cons**: massively over-engineered for a five-subcommand personal CLI.

---

## Decision

**Chose**: Option B — Commander.js

**Rationale**: forge has five subcommands, each with two-to-five options. Commander expresses that in ~30 lines per subcommand and gets auto-help, error messages, and async actions for free. yargs and oclif are correct choices for larger CLIs; here, they would impose configuration overhead that exceeds the actual problem.

---

## Consequences

**Positive**:
- Each subcommand lives in its own `src/cli/commands/<name>.ts` file as a `register<Name>(program)` function
- Help text comes from the `.description()` and `.argument(...)` calls automatically

**Negative / Trade-offs**:
- A small native dependency where none was strictly required

---

## Implementation Notes

- Entry: `src/cli/index.ts` constructs a `Command()`, calls each `register*` function, then `parseAsync(argv)`
- Each command file exports `register<Name>(program: Command): void` and registers its own subcommand
- Errors thrown from `.action()` handlers are caught at the top-level `parseAsync().catch()` and rendered as `forge: <message>` with exit code 1

---

## Revisit Conditions

- If forge grows past ~10 subcommands or needs nested commands, evaluate yargs's middleware
- If a plugin/extension story emerges (third-party workflows shipping CLI commands), evaluate oclif

# L2 changed-primitive drift grep — noise measurement (#240)

**Status:** prototype measured. **Recommendation: do NOT enforce as a gate yet.**
Naive mention-grep is ~5–10% precision. There is a clear precision path before
enforcement is worth wiring.

## What was built

`scripts/drift-l2.ts` — a standalone, non-gating prototype. Given a git range it
extracts the high-signal primitives that changed (CLI flags, `forge <verb>`
command phrases, schema/YAML `field:` keys, dotted event names, runtime names)
and greps the durable-docs corpus (`docs/`, `learnings/`, `README.md`,
`CLAUDE.md`, seed prose/templates — 96 files) for mentions. Each mention is a
drift *candidate*. It self-maintains the affected-doc set (no static
surface→docs map to rot), exactly per the ticket.

## Measurement — three real changes

| change | primitives | findings | relevant | drift precision |
|--------|-----------|----------|----------|-----------------|
| #227 `model:`→`activity:` (e0c3384) | 9 | 78 | ~8 (`activity:`) | ~10% |
| #233 `forge usage --run/--task` (0fb68bf) | 2 | 77 | ~0 | ~0% |
| #235 notify milestone (e168fcc) | 14 | 138 | ~10 | ~7% |

"Relevant" = mentions of the actually-changed primitive. True *stale-doc* hits
were near zero — the docs had been fixed in the same session — so even the
relevant findings were mostly already-correct usage, not drift. As a **review
surface** ("here's where this primitive is documented, eyeball it") the relevant
slice is useful; as an **enforcing drift gate** the noise is disqualifying.

## Noise taxonomy (dominant → fixable)

1. **Still-valid generic flags.** `--run`, `--task`, `--json`, `--kind` are
   valid across many commands. A doc mentioning `--run` is correct, not drift.
   These produced the bulk of the findings (77/77 on #233; 52+/138 on #235).
2. **Prose `forge <word>` false commands.** The `forge <verb>` extractor grabbed
   sentence fragments: "forge already chose", "forge owns delivery", "forge
   applies policy". English, not commands.
3. **Co-located unchanged schema keys.** The #227 rename reflowed a schema block,
   so `authority:` and `gate_on_verdict:` (64 of 78 findings) were extracted
   despite not changing semantically — they were just lines in a touched hunk.

## Precision path (before any enforcement — #240 → enforcement decision)

1. **Discriminate added vs removed/renamed primitives.** The single biggest win:
   only a *removed or renamed* token is a drift candidate. A still-present flag
   mentioned in docs is correct. Kills noise sources #1 and most of #3.
2. **Gate `forge <verb>` on a known-command set or backtick/code context.** Kills
   noise source #2 outright.
3. **Namespace flags to their command** (`forge usage --run`, not bare `--run`).
4. **Diff the actual key set for schema files** (added/removed YAML/zod keys),
   not every line in a reflowed hunk.

With (1)+(2) alone, the three test changes drop from 293 combined findings to a
handful of genuinely-changed primitives. That is the version worth re-measuring
and, only then, considering as an L3-feeding signal — never a hard block (per
the #236 META: gate on a drift *verdict*, not a mention count).

## Decision

Keep `scripts/drift-l2.ts` as a manual investigative tool. Do not wire it into
reds/review/gates. Revisit enforcement only after the added-vs-removed
discrimination lands and re-measurement shows precision above a usable bar.

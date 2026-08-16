// FG-694: ONE source of truth for the dashboard browser tier's census.
//
// Two guards need to know how big the tier is, and each carried its own hand-kept copy
// of the number:
//
//   - src/util/fg642-browser-tier-consistency.test.ts — the source-level census (exact
//     suite set, exact per-suite test counts);
//   - dashboard/src/fg642-browser-tier-fail-first.integration.test.ts — the behavior
//     proof that a Chrome-less run fails EVERY test in the tier instead of skipping to
//     green, which needs the tier's size to say "every".
//
// FG-694 took the tier from 64 to 66 real-browser tests, updated the first copy and not
// the second — nobody knew the second existed — and `dashboard_integration` went red on
// a stale literal rather than on a defect. Both guards now resolve the count from here:
// the fail-first proof counts the tier itself, so it carries no number at all.
//
// The per-suite map below stays a hand-maintained DECLARATION on purpose: it is the
// tripwire. A total alone cannot see three tests deleted from one suite and three added
// to another, and coverage vanishing quietly is the exact failure FG-642 closed. Growing
// or pruning the tier is fine — update this map in the same commit, on purpose, and
// every guard moves with it.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BROWSER_TIER_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dashboard",
  "browser-tests"
);

// The tier as FG-642 restored it (5 suites, 18 tests), plus the two FG-648 runtime
// suites — `agent-runtime` grown by the FG-648 review fixes to cover the weekly
// resolution, the width band a viewport breakpoint left illegible, contrast, reduced
// motion, the error state, out-of-order responses and the role write-back;
// `agent-runtime-legibility` added by the reopened ticket's verify phase to attack
// AC8-AC10 (axis truthfulness at the scale edges, mean-and-count pairing swept across
// twelve widths, UTC disclosure on the plot rather than only the caption).
// FG-661 then added one test to `agent-runtime` for the stale-read affordance (RF-15)
// and re-pointed the timezone tests in both suites at the Local/UTC toggle.
// FG-591 then added `fg591-queue-board` (6 tests): the operator work-queue board as an
// operator drives it — a real browser drag-reorder that reaches the durable rank through
// the CLI, the same move by keyboard, a stale-version refusal surfaced rather than
// swallowed, a not-ready enqueue's concrete refinement proposal on screen, blocked vs.
// waiting-to-overlap kept visibly distinct, and the CLI-only dispatcher panel.
// FG-679 added `fg679-current-activity` (9 tests): the rendered Current activity
// surface — three distinct sections, the four BD-4 launch statuses as four distinct
// strings, `unobserved since <t>`, per-context required CI, old-sha evidence
// disappearing, and the no-host-path/read-only guarantees.
// FG-694 grew that suite to 12: the compact hierarchy under the reported historical
// noise, and one test per malformed-payload depth AC7 has to survive in a real browser —
// a null AGENT entry (RF-3) and a null CI CONTEXT inside a valid-looking observation
// (RF-5). Both used to throw mid-render, which leaves the operator a blank surface
// rather than the unavailable state and its Retry. FG-700 adds the mixed live-launch
// shape: one declared verification and every associated invoke/review/campaign launch
// remain separately visible in Activity.
// The FG-694 POST-SHIP CORRECTION then added `fg694-home-in-flight` (9 tests): Home's
// own shape, which the suite above no longer asserts because the `Current activity`
// panel moved off Home onto the Activity view. One activity surface, no agent rendered
// twice, compact host/CI waits with no sha/URL/timestamp/argv, no CI from a closed
// ticket's unfinished review, the In-flight surface inside the 862px viewport the
// reported 810.5px panel overflowed, and the failed-read line that keeps the section
// from implying it looked at launches and checks. The ninth is the correction's own
// correction: a running launch nobody associated with current work — the dashboard
// server, placed by its cwd — is host activity to read on the Activity view, not a wait
// to watch on Home.
// FG-683 added `completed-runs` (8 tests): the runtime panel's metric selector and
// the count chart behind it — both metrics offered with the duration one still the
// default, an integer runs axis that cannot be read as the duration chart, zero
// buckets drawn as observed zeros, a dense window's label thinning and fallback
// list, the Local/UTC toggle proven to move labels and nothing a count is read off,
// the duration chart restored untouched on the way back, the count read's own
// error, and containment at 390px.
// FG-683 verification also adds `completed-runs-real-store` (2 tests): it takes
// the selector through the real dashboard server and production schema, including
// canonical checkout scope, dedupe against related records and a phone-to-desktop
// count-chart legibility sweep.
// FG-663 adds `fg663-deleted-checkout` (1 test): a run written from a disposable
// checkout remains visibly attributed to its project after that checkout is gone.
// FG-643 adds `fg643-sanitize-markdown` (1 test): a hostile ticket body stored
// through the real backlog path renders inert in a real browser — no
// script/handler/navigation executes, stored bytes unchanged, a benign control
// still renders.
// FG-386 adds `fg386-shipping-audit` (9 tests): the read-only shipping-audit panel
// in a real browser — every audit state as its own labelled badge with absence
// rendered not_observed (never green), mechanical checks and model reviewer findings
// in visually distinct blocks, a failed mechanical check surfacing an actionable
// failure message (gate + exit code + reproduce), a superseded row marked stale rather
// than a live pass, an open architecture question reading as needs-human on the review
// axis, an unselected project rendering the empty/unselected state rather than a
// perpetual spinner, the details toggle exposing aria-expanded/aria-controls (RF-4), an
// accepted-deferral follow-up ticket rendered as a link (RF-7), and a scope switch
// clearing the panel so a failed new-scope response never retains the prior project's
// rows (RF-3).
export const TIER_TESTS: Readonly<Record<string, number>> = {
  "agent-runtime-legibility.test.ts": 12,
  "fg386-shipping-audit.test.ts": 9,
  "agent-runtime.test.ts": 18,
  "backlog-count.test.ts": 2,
  "completed-runs.test.ts": 8,
  "completed-runs-real-store.test.ts": 2,
  "fg591-queue-board.test.ts": 6,
  "fg643-sanitize-markdown.test.ts": 1,
  "fg663-deleted-checkout.test.ts": 1,
  "fg679-current-activity.test.ts": 13,
  "fg694-home-in-flight.test.ts": 9,
  "fg608-backlog-cutover.test.ts": 3,
  "inactive-checkouts.test.ts": 3,
  "offline-boot.test.ts": 2,
  "usage-limits.test.ts": 8,
};

/** The suite set the map declares, in the order `tierSuites()` reports. */
export const DECLARED_TIER_SUITES: readonly string[] = Object.keys(TIER_TESTS).sort();

/** The tier's size as DECLARED. Compare against `tierTestTotal()`, never restate it. */
export const DECLARED_TIER_TOTAL = Object.values(TIER_TESTS).reduce((sum, n) => sum + n, 0);

export const tierSuites = (): string[] =>
  readdirSync(BROWSER_TIER_DIR)
    .filter((f) => f.endsWith(".test.ts"))
    .sort();

export const tierSource = (file: string): string => readFileSync(join(BROWSER_TIER_DIR, file), "utf8");

/** Top-level `test(` declarations per suite, counted from the tier as it stands on disk. */
export function countTierTests(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of tierSuites()) counts[file] = (tierSource(file).match(/^test\(/gm) ?? []).length;
  return counts;
}

/** The tier's size as it actually is — derived, so a guard using it needs no literal. */
export const tierTestTotal = (): number => Object.values(countTierTests()).reduce((sum, n) => sum + n, 0);

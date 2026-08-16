// FG-722 (FG-477 child E): the lifecycle-inventory source guard. FG-477 consolidated
// every terminal/lifecycle-state derivation behind the evaluator
// (src/v2/lifecycle-evaluator.ts) and its ready-queue projection
// (src/v2/ready-queue.ts). FG-720/FG-721/FG-722 migrated the last three ad-hoc
// consumers that re-derived that state with their own row scans. This guard is the
// belt that keeps the inventory closed: the repo has no ESLint, so a source-scanning
// node:test IS the enforcement — same shape as backlog-seam-bypass-guard.test.ts.
//
// TWO forbidden idioms, scanned in production `.ts` under src/ (excluding tests) and
// OUTSIDE the two evaluator-owned files that legitimately own them:
//
//   (1) an ad-hoc parent-less row scan — `<x>.parentId === undefined` — used to
//       reason about lifecycle/terminal state. The FG-722 regression was exactly
//       this: `t.parentId === undefined && t.status === "failed"` in
//       src/campaign/executor.ts, re-deriving the failed-primary set the evaluator
//       already computes (classifyRunTerminalState -> failedPhases). Every remaining
//       parent-less scan is a DIFFERENT, non-terminal use (a display count, a
//       dispatch-dedup, a supersession-guard on a mutation, packet assembly) and is
//       precision-allowlisted below with the reason it is not a terminal decision.
//
//   (2) `startsWith("red-")` / `` `red-${` `` used as a lifecycle/lineage
//       discriminator. Red-review lineage is the classifier's job (isRedReviewRow /
//       classifyTaskLineage), never a string-prefix test. The two legitimate `red-`
//       prefix uses that remain decide READ-ONLY MOUNT MODE (capability/security),
//       not lineage, plus the reviewer-task-id CONSTRUCTION sites.
//
// The ALLOWLIST is the inventory, and it is asserted by OCCURRENCE-PRECISE multiset
// equality (RF-1/RF-2): every entry declares the EXACT number of occurrences it
// accounts for (`count`, default 1), the gate rejects any hit no entry claims, rejects
// any hit two entries both claim (an over-broad entry), and asserts each entry claims
// EXACTLY its declared count. So the allowlist can neither silently grow — a NEW
// occurrence in a non-allowlisted file, a reintroduction in src/campaign/executor.ts,
// OR a SECOND matching occurrence added to an already-allowlisted file all fail — nor
// keep a stale entry (an entry that now claims zero occurrences fails "exactly count").
// Each entry carries the one-line reason it is not a lifecycle/terminal decision.
//
// The scan is WHITESPACE-NORMALIZED (RF-3): each file is collapsed to a single-spaced
// string before matching, so a multiline / whitespace-padded form of either forbidden
// construction — `task.parentId\n  === undefined`, `startsWith(\n  "red-"\n)` — is
// caught exactly like its one-line form. Detectors run over that normalized text; an
// allowlist entry claims a forbidden occurrence when its own (path-scoped) match SPANS
// that occurrence, so entries match against the same normalized text and need no line
// anchors. This closes the whitespace gap deferred as FG-723 in the same pass.
//
// NOTE ON SCOPE: FG-722's ticket enumerated the "interesting" confusable sites; the
// realized inventory also carries the src/v2/runNext.ts drive-core scans (dispatch
// branch selection, liveness, pending-primary existence, reviewer-context primary
// pick) and the src/v2/retry.ts fanout-parent guard, because the pattern (1) idiom is
// the bare parent-less scan, which those legitimately use for non-terminal reasons.
// runNext.ts:~5275 (latest complete architect/tech-lead primary) is the one that is
// evaluator-shaped (resolveCompletedPhasePrimary) and a candidate for a later
// migration; it is allowlisted, not swept in, because migrating it is out of FG-722's
// scope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at src/v2/; the guard scans the whole src/ tree, so climb one level.
const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));

// (1) An ad-hoc parent-less row scan. The leading `.` is load-bearing: it requires a
//     member access (`t.parentId`, `task.parentId`, `args.parentId`) so PROSE that
//     merely quotes the idiom — the FG-721/FG-722 migration comments say
//     "`parentId === undefined && status === 'failed'`" with a bare, dot-less
//     `parentId` — is NOT matched. That precision is asserted below.
//     `\s*` around the `===` so a whitespace-collapsed `parentId===undefined` (or
//     any extra-spaced variant) cannot slip the scan — the same bypass class RF-2
//     flagged for the red- discriminator, closed here too.
const PARENTLESS_SCAN = /\.parentId\s*===\s*undefined/;

// (2a) A `red-` prefix test used as a discriminator: `<x>.startsWith(<q>red-<q>)`.
//      RF-2: the quote is captured and back-referenced so ALL THREE JS string quote
//      styles are caught — double ("red-"), single ('red-'), and backtick (`red-`).
//      The pre-RF-2 regex matched ONLY the double-quoted form, so a single-quoted
//      startsWith('red-') reintroduced the lineage discriminator straight past the gate.
//      RF-3: `\s*` inside the parens so a multiline `startsWith(\n  "red-"\n)` (collapsed
//      to `startsWith( "red-" )` by the normalizer) is caught too.
const RED_PREFIX_TEST = /\.startsWith\(\s*(["'`])red-\1\s*\)/;
// (2b) A `red-${...}` template literal (reviewer-task-id construction today; a future
//      `taskId === `red-${id}`` discriminator would be caught here too).
const RED_TEMPLATE = /`red-\$\{/;

// The evaluator-owned files that legitimately derive lifecycle/terminal state — the
// single home of the parent-less predicate (isPhasePrimaryRow) and its terminal
// projection (classifyRunTerminalState). Everything else goes through them.
const EVALUATOR_OWNED = ["src/v2/lifecycle-evaluator.ts", "src/v2/ready-queue.ts"];

interface AllowEntry {
  /** Label-relative file path (e.g. "src/v2/gate.ts"). Never a line number. */
  readonly file: string;
  /** The specific construction allowed in that file. Never a bare catch-all. */
  readonly pattern: RegExp;
  /** Why this occurrence is not a lifecycle/terminal decision. Every entry carries one. */
  readonly reason: string;
  /**
   * RF-1/RF-2: the EXACT number of occurrences this entry accounts for (default 1). The
   * gate asserts each entry claims exactly this many hits — so an ADDITIONAL matching
   * occurrence in an already-allowlisted file (count would rise to expected+1) fails,
   * and a stale entry (count falls to 0) fails too. Only two entries legitimately claim
   * more than one: runNext.ts's `args.parentId === undefined` dispatch-branch pair and
   * its two `newTaskId(`red-${...}`)` reviewer-id construction sites.
   */
  readonly count?: number;
}

const ALLOWLIST: readonly AllowEntry[] = [
  // ── (1) parent-less scans that are NOT terminal-state decisions ──────────────
  {
    file: "src/notify/trigger.ts",
    pattern: /t\.parentId === undefined && t\.status === "failed"/,
    reason: "DISPLAY pick: failureDetailForRun names a failed primary for a notification body; it does not decide terminal state.",
  },
  {
    file: "src/notify/trigger.ts",
    pattern: /t\.parentId === undefined && t\.status === "blocked_by_red"/,
    reason: "DISPLAY pick: blockedTaskForRun names a blocked primary for a notification body; it does not decide terminal state.",
  },
  {
    file: "src/v2/metrics.ts",
    pattern: /tasksForRun\(run\.id\)\.filter\(\(t\) => t\.parentId === undefined\)/,
    reason: "Display COUNT: counts top-level tasks per run for metrics rollup — fanout children/reds roll up under their parent.",
  },
  {
    file: "src/v2/runs-query.ts",
    pattern: /tasksForRun\(run\.id\)\.filter\(\(t\) => t\.parentId === undefined\)/,
    reason: "Display COUNT: top-level-only task list for the runs query view; children roll up under their parent.",
  },
  {
    file: "src/v2/re-drive-eligibility.ts",
    pattern: /t\.parentId === undefined && t\.createdAt >= parent\.createdAt/,
    reason: "Supersession guard on a MUTATION: refuses a re-drive when a newer parent-less attempt already superseded this one; not a run-terminal read.",
  },
  {
    file: "src/v2/gate.ts",
    pattern: /t\.parentId === undefined && t\.status === "pending"/,
    reason: "Request-changes DISPATCH dedup: finds an existing pending primary to merge rationale into rather than orphan it; dispatch state, not terminal state.",
  },
  {
    file: "src/v2/reviewer-context-packet.ts",
    pattern: /t\.agentRole === "architecture-advisor" && t\.status === "complete" && t\.parentId === undefined/,
    reason: "Packet assembly: finds the completed architect primary whose result seeds the reviewer context packet; a role+status FIND, not a terminal decision.",
  },
  {
    file: "src/v2/reviewer-context-packet.ts",
    pattern: /t\.agentRole === "tech-lead" && t\.status === "complete" && t\.parentId === undefined/,
    reason: "Packet assembly: finds the completed tech-lead primary whose result seeds the reviewer context packet; a role+status FIND, not a terminal decision.",
  },
  {
    file: "src/cli/commands/recover.ts",
    pattern: /task\.parentId === undefined && allTasks\.some\(\(t\) => t\.parentId === task\.id && isFanoutChildRow\(t\)\)/,
    reason: "isFanoutParent: documented workflow-free inspector layered over the canonical isFanoutChildRow primitive; identifies a fanout parent, not run-terminal state.",
  },
  {
    file: "src/v2/retry.ts",
    pattern: /if \(task\.parentId === undefined\) return undefined/,
    reason: "fanoutParentOf early-out: a parent-less row HAS no fanout parent — a structural guard on the retry lineage walk, not a terminal read.",
  },
  {
    file: "src/v2/runNext.ts",
    pattern: /args\.parentId === undefined/,
    count: 2,
    reason: "Dispatch branch: keys off the NEW task's own parentId (primary vs child) to decide which existing rows to inspect before creating it; not a terminal-state scan. Two sites: the phaseTasks gather and the existing-primary find.",
  },
  {
    file: "src/v2/runNext.ts",
    // RF-3: matches the NORMALIZED statement, not a `$`-anchored line — the liveness
    // detector spans multiple physical lines, so anchoring the distinguishing
    // `(t.status === "running" || t.status === "awaiting_red")` suffix is what scopes it.
    pattern: /t\.parentId === undefined && \(t\.status === "running" \|\| t\.status === "awaiting_red"\)/,
    reason: "Liveness: part of the active-with-children (running|awaiting_red) fanout-parent detector — an in-flight-run check, not a terminal decision.",
  },
  {
    file: "src/v2/runNext.ts",
    // RF-3: the manual-step existence find is `...t.parentId === undefined )` in
    // normalized form; the trailing `)` distinguishes it from the two `t.phase ===
    // step.id && t.parentId === undefined && ...` scans that continue past `undefined`.
    pattern: /t\.phase === step\.id && t\.parentId === undefined\s*\)/,
    reason: "Pending-primary existence: locates a manual step's already-created primary so it is not spawned twice; a dispatch-existence check, not a terminal read.",
  },
  {
    file: "src/v2/runNext.ts",
    pattern: /t\.phase === step\.id && t\.parentId === undefined && t\.status === "complete"/,
    reason: "Reviewer-context primary pick: latest complete architect/tech-lead primary whose result feeds context — evaluator-shaped (resolveCompletedPhasePrimary), a candidate future migration, not a terminal decision.",
  },
  // ── (2) `red-` prefix uses that are NOT lineage discriminators ───────────────
  {
    file: "src/v2/project-auth.ts",
    pattern: /role\.startsWith\("red-"\) \|\| role === "red"/,
    reason: "MOUNT MODE (capability/security): a red role gets a read-only project mount; the prefix decides a capability, not workflow lineage.",
  },
  {
    file: "src/v2/retry.ts",
    pattern: /task\.agentRole\.startsWith\("red-"\)/,
    reason: "MOUNT MODE fallback: when no receipt records the mount mode, a red role's retry defaults to a read-only project mount; capability, not lineage.",
  },
  {
    file: "src/v2/runNext.ts",
    pattern: /t\.agentRole\.startsWith\("red-"\)\) continue/,
    reason: "adoptablePlanItemChildren skips red-review rows when adopting plan-item children — a pre-existing prefix use (candidate for isRedReviewRow); scoped to plan-item adoption, not run-terminal state.",
  },
  {
    file: "src/v2/runNext.ts",
    pattern: /newTaskId\(`red-\$\{args\.step\.id\}`\)/,
    count: 2,
    reason: "Reviewer-task-id CONSTRUCTION (mints the red review task id from the step id); it builds an id, it does not discriminate lineage. Two sites: the pipeline red dispatch and the standalone red dispatch.",
  },
];

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** Indices into ALLOWLIST whose (path-scoped) match SPANS this occurrence. */
  readonly claimedBy: number[];
}

interface Span {
  readonly start: number;
  readonly end: number;
}

const DETECTORS: readonly RegExp[] = [PARENTLESS_SCAN, RED_PREFIX_TEST, RED_TEMPLATE];

/**
 * RF-3: collapse every run of whitespace (spaces, tabs, and NEWLINES) to a single
 * space so a construction split across physical lines matches exactly like its
 * one-line form. `lineAt[i]` is the original source line of the normalized char at i,
 * so a hit still reports the line the operator has to open.
 */
function normalize(body: string): { text: string; lineAt: number[] } {
  const out: string[] = [];
  const lineAt: number[] = [];
  let line = 1;
  let pendingWs = false;
  for (const ch of body) {
    if (ch === "\n") line += 1;
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f" || ch === "\v") {
      pendingWs = true;
      continue;
    }
    if (pendingWs && out.length > 0) {
      out.push(" ");
      lineAt.push(line);
    }
    pendingWs = false;
    out.push(ch);
    lineAt.push(line);
  }
  return { text: out.join(""), lineAt };
}

function allMatches(text: string, pattern: RegExp): Span[] {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const spans: Span[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
    if (m.index === re.lastIndex) re.lastIndex += 1; // guard against a zero-width match
  }
  return spans;
}

function gatherSourceFiles(dir: string, root: string = dir): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...gatherSourceFiles(full, root));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !/\.(test|integration|worktree)\.ts$/.test(entry.name)
    ) {
      // Test files are excluded: they legitimately build parent-less/red- fixtures.
      // This exclusion is also what keeps THIS file out of its own scan.
      results.push(relative(root, full));
    }
  }
  return results;
}

function scan(dir: string): { files: string[]; hits: Hit[] } {
  const files = gatherSourceFiles(dir);
  const hits: Hit[] = [];
  for (const rel of files) {
    const label = `src/${rel}`;
    if (EVALUATOR_OWNED.includes(label)) continue;
    const { text, lineAt } = normalize(readFileSync(join(dir, rel), "utf8"));
    // Each allowlist entry that is scoped to this file contributes its match spans
    // once; an entry "claims" a forbidden occurrence when one of its spans CONTAINS it.
    const entrySpans = ALLOWLIST.map((entry, idx) =>
      entry.file === label ? { idx, spans: allMatches(text, entry.pattern) } : { idx, spans: [] as Span[] },
    );
    for (const detector of DETECTORS) {
      for (const hit of allMatches(text, detector)) {
        const claimedBy = entrySpans
          .filter(({ spans }) => spans.some((s) => s.start <= hit.start && s.end >= hit.end))
          .map(({ idx }) => idx);
        hits.push({
          file: label,
          line: lineAt[hit.start] ?? 0,
          text: text.slice(Math.max(0, hit.start - 6), Math.min(text.length, hit.end + 32)).trim(),
          claimedBy,
        });
      }
    }
  }
  return { files, hits };
}

/**
 * The gate proper. Asserts the vacuity precondition FIRST — a scan that found no
 * files is a guard that stopped guarding because the source layout moved — then that
 * every occurrence is claimed by EXACTLY one allowlist entry, and finally (RF-1/RF-2)
 * that each entry claims EXACTLY its declared occurrence count. The three together are
 * multiset set-equality: the allowlist cannot silently grow (a new occurrence in a
 * non-allowlisted file is unclaimed; a second occurrence in an allowlisted file pushes
 * that entry's count over) and cannot keep a stale entry (its count falls to zero).
 */
function assertGateHolds(dir: string): void {
  const { files, hits } = scan(dir);
  assert.ok(
    files.length > 0,
    `FG-722 lifecycle source guard scanned no .ts files under ${dir} — the path or the layout changed and the gate is no longer guarding anything.`,
  );
  const unallowed = hits.filter((hit) => hit.claimedBy.length === 0).map((hit) => `${hit.file}:${hit.line}: ${hit.text}`);
  assert.deepEqual(
    unallowed,
    [],
    `FG-722: an ad-hoc parent-less row scan or a red- lineage-discriminator used to reason about lifecycle/terminal state, outside the evaluator. ` +
      `Derive terminal/lifecycle state from the evaluator (src/v2/lifecycle-evaluator.ts / src/v2/ready-queue.ts) instead — classifyRunTerminalState / isPhasePrimaryRow / isRedReviewRow — ` +
      `or add an ALLOWLIST entry with the reason this is not a terminal decision:\n${unallowed.join("\n")}`,
  );
  const overclaimed = hits
    .filter((hit) => hit.claimedBy.length > 1)
    .map((hit) => `${hit.file}:${hit.line}: ${hit.text} — claimed by ${hit.claimedBy.map((i) => `${ALLOWLIST[i]!.pattern}`).join(", ")}`);
  assert.deepEqual(
    overclaimed,
    [],
    `FG-722: an occurrence is claimed by more than one ALLOWLIST entry — an over-broad entry defeats occurrence-precise counting. Tighten the patterns so each occurrence has exactly one owner:\n${overclaimed.join("\n")}`,
  );
  const countMismatch: string[] = [];
  ALLOWLIST.forEach((entry, idx) => {
    const actual = hits.filter((hit) => hit.claimedBy.length === 1 && hit.claimedBy[0] === idx).length;
    const expected = entry.count ?? 1;
    if (actual !== expected) {
      countMismatch.push(`${entry.file} :: ${entry.pattern} — expected ${expected}, found ${actual}`);
    }
  });
  assert.deepEqual(
    countMismatch,
    [],
    `FG-722 allowlist occurrence count mismatch — the allowlist is asserted by set-equality, so this is either an ADDITIONAL forbidden occurrence added to an already-allowlisted file (found > expected) or a now-STALE entry (found 0). Fix the source or update the entry's count with its reason:\n${countMismatch.join("\n")}`,
  );
}

function withFixture(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "fg722-src-guard-"));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the gate ---

test("FG-722: no ad-hoc parent-less / red- lifecycle scan outside the evaluator", () => {
  assertGateHolds(SRC_ROOT);
});

test("FG-722: src/campaign/executor.ts is clean — the migrated probe no longer scans parent-less rows", () => {
  // The FG-722 Part 1 regression check: probeCampaignSystemRetryEvidence used to run
  // `t.parentId === undefined && t.status === "failed"`. If that (or any forbidden
  // idiom) is reintroduced there, it shows up as a hit and executor.ts must NOT be
  // allowlisted — so the file failing here IS the signal that Part 1 regressed.
  const executorHits = scan(SRC_ROOT).hits.filter((h) => h.file === "src/campaign/executor.ts");
  assert.deepEqual(
    executorHits.map((h) => `${h.file}:${h.line}: ${h.text}`),
    [],
    "src/campaign/executor.ts must derive its failed-primary set from the evaluator (classifyRunTerminalState), not an ad-hoc parent-less scan",
  );
  assert.ok(
    !ALLOWLIST.some((e) => e.file === "src/campaign/executor.ts"),
    "src/campaign/executor.ts must never be allowlisted — a hit there is a Part 1 regression to fix, not to wave through",
  );
});

// ------------------------------------------------- the gate guards itself ---

test("FG-722 guard: the vacuity precondition fails an empty scan", () => {
  const empty = mkdtempSync(join(tmpdir(), "fg722-src-guard-empty-"));
  try {
    assert.throws(
      () => assertGateHolds(empty),
      /scanned no \.ts files/,
      "an empty scan must fail the gate, not pass it",
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("FG-722 guard: a reintroduced parent-less terminal scan in a non-allowlisted file fails the gate", () => {
  withFixture(
    {
      "campaign/executor.ts": [
        "export function probe(runId: string, tasks: Task[]): Task[] {",
        '  return tasks.filter((t) => t.parentId === undefined && t.status === "failed");',
        "}",
      ].join("\n"),
    },
    (dir) => {
      assert.throws(
        () => assertGateHolds(dir),
        /ad-hoc parent-less row scan/,
        "reintroducing `t.parentId === undefined && t.status === \"failed\"` must fail the gate",
      );
    },
  );
});

test("FG-722 guard: a reintroduced red- lineage discriminator in a non-allowlisted file fails the gate", () => {
  withFixture(
    {
      "v2/some-consumer.ts": [
        "export function isRed(task: Task): boolean {",
        '  return task.agentRole.startsWith("red-");',
        "}",
      ].join("\n"),
    },
    (dir) => {
      assert.throws(
        () => assertGateHolds(dir),
        /red- lineage-discriminator|ad-hoc parent-less/,
        'reintroducing `startsWith("red-")` as a discriminator must fail the gate',
      );
    },
  );
});

test("FG-722 guard (RF-2): a SINGLE-quoted reintroduced startsWith('red-') in a non-allowlisted file fails the gate", () => {
  // The RF-2 bypass: JS permits the discriminator argument in single quotes, which the
  // pre-fix double-quote-only regex did not match — so the lineage discriminator the
  // guard exists to catch could be reintroduced verbatim, just re-quoted.
  withFixture(
    {
      "v2/single-quote-consumer.ts": [
        "export function isRed(task: Task): boolean {",
        "  return task.agentRole.startsWith('red-');",
        "}",
      ].join("\n"),
    },
    (dir) => {
      assert.throws(
        () => assertGateHolds(dir),
        /red- lineage-discriminator|ad-hoc parent-less/,
        "reintroducing startsWith('red-') with SINGLE quotes must fail the gate",
      );
    },
  );
});

test("FG-722 guard (RF-2): a BACKTICK-quoted reintroduced startsWith(`red-`) in a non-allowlisted file fails the gate", () => {
  withFixture(
    {
      "v2/backtick-consumer.ts": [
        "export function isRed(task: Task): boolean {",
        "  return task.agentRole.startsWith(`red-`);",
        "}",
      ].join("\n"),
    },
    (dir) => {
      assert.throws(
        () => assertGateHolds(dir),
        /red- lineage-discriminator|ad-hoc parent-less/,
        "reintroducing startsWith(`red-`) with BACKTICKS must fail the gate",
      );
    },
  );
});

test("FG-722 guard (RF-2): a whitespace-collapsed parentId===undefined terminal scan still fails the gate", () => {
  // The analogous whitespace bypass: the pre-fix `\.parentId === undefined` regex
  // required exactly one space around `===`, so a collapsed `parentId===undefined`
  // (or any extra-spaced variant) slipped past. The `\s*` widening closes it.
  withFixture(
    {
      "campaign/executor.ts": [
        "export function probe(tasks: Task[]): Task[] {",
        '  return tasks.filter((t) => t.parentId===undefined && t.status === "failed");',
        "}",
      ].join("\n"),
    },
    (dir) => {
      assert.throws(
        () => assertGateHolds(dir),
        /ad-hoc parent-less row scan/,
        "a whitespace-collapsed parentId===undefined terminal scan must fail the gate",
      );
    },
  );
});

test("FG-722 guard: the allowlist is scoped by path — the same construction elsewhere still fails", () => {
  // The exact notification DISPLAY pick that IS allowed in src/notify/trigger.ts,
  // placed in a different file. A pattern-only allowlist would wave this through.
  withFixture(
    { "v2/impostor.ts": '    (t) => t.parentId === undefined && t.status === "failed",' },
    (dir) => {
      assert.throws(
        () => assertGateHolds(dir),
        /ad-hoc parent-less row scan/,
        "allowlist entries must be path-scoped, not global patterns",
      );
    },
  );
});

test("FG-722 guard: the migration comment's dot-less `parentId` prose does not trip the gate", () => {
  // src/campaign/executor.ts and the evaluator carry comments quoting the idiom as
  // "`parentId === undefined && status === 'failed'`" with a bare, dot-less parentId.
  // The `.parentId` member-access requirement is what keeps that prose quiet.
  withFixture(
    {
      "v2/prose.ts": [
        "// FG-721: the failed-primary SELECTION is the evaluator's terminal classification,",
        "// not an ad-hoc `parentId === undefined && status === 'failed'` row scan.",
        "const note = \"parentId === undefined marks a workflow-phase primary\";",
      ].join("\n"),
    },
    (dir) => {
      assert.deepEqual(scan(dir).hits, [], "dot-less prose mentioning the idiom must not be flagged");
    },
  );
});

test("FG-722 guard: the guard does not scan itself", () => {
  const self = relative(SRC_ROOT, fileURLToPath(import.meta.url));
  const scanned = gatherSourceFiles(SRC_ROOT);
  assert.ok(!scanned.includes(self), `${self} must be excluded from its own scan`);
  // The exclusion is load-bearing, not incidental: this file's fixtures really do
  // contain the triggering constructions.
  const own = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.ok(
    own.split("\n").some((line) => PARENTLESS_SCAN.test(line) || RED_PREFIX_TEST.test(line)),
    "this guard's fixtures should contain a matching construction, so self-exclusion is proven necessary",
  );
});

test("FG-722 guard: every allowlist entry is occurrence-precise, load-bearing, and carries a reason (RF-1/RF-2)", () => {
  const { hits } = scan(SRC_ROOT);
  const problems: string[] = [];
  ALLOWLIST.forEach((entry, idx) => {
    assert.ok(entry.reason.trim().length > 0, `allowlist entry for ${entry.file} must carry a reason`);
    const claimed = hits.filter((hit) => hit.claimedBy.length === 1 && hit.claimedBy[0] === idx).length;
    const expected = entry.count ?? 1;
    if (claimed !== expected) {
      problems.push(`${entry.file} :: ${entry.pattern} — declares count ${expected}, claims ${claimed}`);
    }
  });
  assert.deepEqual(
    problems,
    [],
    `FG-722 allowlist entries must each claim EXACTLY their declared occurrence count — a stale entry claims 0, an under-counted entry hides an extra occurrence:\n${problems.join("\n")}`,
  );
  // Full multiset set-equality: every occurrence is accounted for exactly once, so the
  // total hit count equals the sum of the declared counts. This is the RF-1/RF-2 guard
  // stated positively — the allowlist can neither grow nor shrink silently.
  const declared = ALLOWLIST.reduce((sum, e) => sum + (e.count ?? 1), 0);
  assert.equal(
    hits.length,
    declared,
    `FG-722: ${hits.length} forbidden occurrences in the tree but the allowlist declares ${declared} — the set-equality invariant is broken.`,
  );
  assert.ok(
    hits.every((hit) => hit.claimedBy.length === 1),
    "every occurrence must be claimed by exactly one allowlist entry",
  );
});

test("FG-722 guard (RF-1/RF-2): a SECOND forbidden occurrence in an already-allowlisted file fails the gate", () => {
  // The core RF-1/RF-2 gap: the pre-fix gate matched by (file, pattern) and tolerated
  // ANY number of occurrences, so a NEW parent-less terminal scan added to a file that
  // is ALREADY allowlisted for one such scan slipped in silently. Occurrence-precise
  // counting makes the second occurrence push the entry's count past its declared 1.
  withFixture(
    {
      "notify/trigger.ts": [
        'const failed = tasks.find((t) => t.parentId === undefined && t.status === "failed");',
        'const sneaked = more.find((t) => t.parentId === undefined && t.status === "failed");',
      ].join("\n"),
    },
    (dir) => {
      assert.throws(
        () => assertGateHolds(dir),
        /occurrence count mismatch[\s\S]*trigger\.ts[\s\S]*expected 1, found 2/,
        "a second matching occurrence in an already-allowlisted file must fail the gate",
      );
    },
  );
});

test("FG-722 guard (RF-3): a MULTILINE parent-less terminal scan in a non-allowlisted file fails the gate", () => {
  // The RF-3 gap: the pre-fix scan tested each physical line independently, so a
  // parent-less terminal scan split across lines produced no single matching line and
  // evaded the gate. The whitespace-normalized scan collapses it back to one string.
  withFixture(
    {
      "v2/multiline-consumer.ts": [
        "const failed = tasks.filter(",
        "  (t) =>",
        "    t.parentId",
        "      === undefined &&",
        '      t.status === "failed",',
        ");",
      ].join("\n"),
    },
    (dir) => {
      assert.throws(
        () => assertGateHolds(dir),
        /ad-hoc parent-less row scan/,
        "a parent-less terminal scan split across physical lines must fail the gate",
      );
    },
  );
});

test("FG-722 guard (RF-3): a MULTILINE / whitespace-padded red- discriminator in a non-allowlisted file fails the gate", () => {
  withFixture(
    {
      "v2/multiline-red.ts": [
        "const isRed = task.agentRole.startsWith(",
        '  "red-"',
        ");",
      ].join("\n"),
    },
    (dir) => {
      assert.throws(
        () => assertGateHolds(dir),
        /red- lineage-discriminator|ad-hoc parent-less/,
        "a red- discriminator split across physical lines must fail the gate",
      );
    },
  );
});

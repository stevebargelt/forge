// FG-608 (FG-496 Slice C): once a project's ticket storage mode flips to `db`,
// `backlog/*.md` is a FROZEN snapshot — anything that still reads ticket Markdown
// directly is reading a lie. Slice B migrated every consumer that already went
// through the structured.ts seam; Slice C migrated the stragglers that bypassed it
// (the dashboard ticket source, the campaign dir-guards). This guard is the belt:
// it fails on any NEW direct `backlog/` ticket-path construction outside the seam.
//
// The repo has no ESLint, so a source-scanning node:test is the established
// mechanism here — same shape as dashboard-offline-guard.test.ts,
// dashboard-phantom-status.test.ts, and test-tiers.test.ts. It scans BOTH src/
// and dashboard/src/, because the dashboard is part of the canonical gate
// (`npm run test:all` runs `npm test -w dashboard`) and the dashboard is exactly
// where the last seam-bypassing ticket reader lived.
//
// WHAT IT MATCHES — filesystem path CONSTRUCTION naming a `backlog` segment, not
// the word "backlog". Two idioms:
//   (1) join(...)/resolve(...) with a quoted "backlog" path segment, and
//   (2) a string/template path literal with `/backlog/<ticket-subdir>` in path
//       position (a leading separator preceded by `${...}` or a path character).
// Prose is deliberately NOT matched: review-loop's prompt text says things like
// "moves it to `backlog/done/`" and done-audit compares `path === "backlog/notes.md"`.
// Neither can read a ticket, and allowlisting prose file-by-file would rot fast.
// That precision is itself asserted below, so a future widening of the pattern
// that starts swallowing prose fails here rather than silently growing the
// allowlist.
//
// KNOWN LIMIT (deliberate): the guard anchors on the site where the literal
// "backlog" segment enters a path. A downstream `join(backlogDir, sub)` off an
// already-constructed variable is not matched — but the construction that
// produced `backlogDir` is, so the bypass still has to pass through this gate
// once. Fully dynamic construction (a "backlog" string assembled at runtime)
// escapes detection; this is a guard against drift, not an adversary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = fileURLToPath(new URL(".", import.meta.url));
const DASHBOARD_SRC_ROOT = fileURLToPath(new URL("../dashboard/src/", import.meta.url));

// (1) A quoted "backlog" path segment inside join()/resolve(): `join(dir, "backlog")`,
//     `join(dir, "backlog", "stories", id)`, `resolve(x, "backlog/stories")`. The
//     trailing `["'`]|/` guard keeps `"backlogx"` / `"backlog-import"` from matching.
const JOINED_BACKLOG_SEGMENT = /(?:join|resolve)\s*\([^;]*["'`]backlog(?:["'`]|\/)/;

// (2) A path literal in path POSITION: `${projectDir}/backlog/stories/...`,
//     `/backlog/done/...`. The required leading separator (preceded by an
//     interpolation or a path character) is what separates a real path from
//     backticked prose like `backlog/done/`.
const BACKLOG_PATH_LITERAL = /(?:\$\{[^}]*\}|[A-Za-z0-9_.\-])\/backlog\/(?:ideas|epics|stories|done)\b/;

// The seam itself. src/backlog/** owns ticket Markdown (structured.ts is THE
// reader), and src/store/backlog-import.ts is the one sanctioned second reader —
// it walks backlog/*.md to populate the DB shadow, which is the whole point of
// the import direction. Everything else must come through the seam.
const SEAM_OWNED = ["src/backlog/", "src/store/backlog-import.ts"];

interface AllowEntry {
  /** Label-relative file path (e.g. "src/cli/commands/init.ts"). Never a line number. */
  readonly file: string;
  /** The specific construction allowed in that file. Never a bare catch-all. */
  readonly pattern: RegExp;
  /** Why this bypass is legitimate. Every entry carries one. */
  readonly reason: string;
}

const ALLOWLIST: readonly AllowEntry[] = [
  {
    file: "src/cli/commands/backlog.ts",
    pattern: /join\([^)]*["']backlog["'],\s*["']notes\.md["']\)/,
    reason:
      "backlog/notes.md is FG-380 per-checkout operational state (session handoff), not ticket truth — " +
      "it stays branch-local and file-backed after the db cutover.",
  },
  {
    file: "src/cli/commands/backlog.ts",
    pattern: /mkdirSync\(join\([^)]*["']backlog["']\)/,
    reason: "`forge backlog notes replace` creates the directory that holds notes.md; no ticket is read.",
  },
  {
    file: "src/cli/commands/backlog.ts",
    pattern: /existsSync\(join\([^)]*["']backlog["']\)\)/,
    reason:
      "`mode --set db` probes for a backlog/ directory to decide whether this checkout can see the " +
      "project's Markdown ids before refusing the flip — a directory-presence gate, not a ticket read.",
  },
  {
    file: "src/cli/commands/init.ts",
    pattern: /const backlogDir = join\([^)]*["']backlog["']\)/,
    reason:
      "init scaffolds the backlog/ layout (subdirs + notes.md) for a fresh project. Per FG-608's non-goals " +
      "init still scaffolds notes.md and must not gate ticket features on the directory.",
  },
  {
    file: "src/cli/commands/backlog-migrate.ts",
    pattern: /join\(dir, ["']backlog["']/,
    reason:
      "`forge backlog-migrate` is the LEGACY-FORMAT converter (BACKLOG.md -> structured backlog/*.md) — a " +
      "different operation from FG-608's new `forge backlog migrate` (Markdown -> DB) cutover verb. " +
      "Writing backlog/*.md is its entire job; it runs before a project has any DB ticket truth.",
  },
  {
    file: "src/queue/fg591-falsification-smoke-runner.ts",
    pattern: /const dir = join\(project, ["']backlog["'], ["']stories["']\)/,
    reason:
      "FG-591's operator-run falsification constructs disposable fixture tickets, then immediately runs " +
      "`forge backlog migrate` to cut that fixture over to db mode; it never reads this repository's ticket truth.",
  },
  {
    file: "dashboard/src/server.ts",
    pattern: /join\([^)]*["']backlog["'],\s*["']notes\.md["']\)/,
    reason:
      "The dashboard keeps notes.md reads per-checkout (FG-380 operational state), orthogonal to ticket " +
      "truth — FG-608 moved only the TICKET source to the host-wide DB.",
  },
  {
    file: "src/orient/snapshot.ts",
    pattern: /join\([^)]*["']backlog["'],\s*["']notes\.md["']\)/,
    reason:
      "FG-588: the orient snapshot reads backlog/notes.md — FG-380 per-checkout operational state (session " +
      "handoff), not ticket truth. It stays branch-local and file-backed after the db cutover, exactly like the " +
      "`forge backlog notes show` read this mirrors; ticket reads go through the structured.ts seam.",
  },
  {
    file: "src/integration-cli-spawn.ts",
    pattern: /resolve\(INTEGRATION_BUILD_DIR, ["']backlog["'], ["']container-authority\.testkit\.js["']\)/,
    reason:
      "This is the build-dir MIRROR path of src/backlog/container-authority.testkit-spawn.ts, not a ticket " +
      "read. The integration build mirrors src/ into .forge-integration-build/, so the compiled testkit lands " +
      "at <buildDir>/backlog/container-authority.testkit.js — the .js a spawned `node` CLI passes to --import " +
      "(it has no tsx to parse the .ts source). No backlog/*.md Markdown is opened.",
  },
];

interface Hit {
  readonly label: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

interface ScanRoot {
  readonly label: string;
  readonly dir: string;
}

function gatherSourceFiles(dir: string, root: string = dir): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...gatherSourceFiles(full, root));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      // Test files are excluded: they legitimately build backlog/*.md fixtures.
      // This exclusion is also what keeps THIS file out of its own scan.
      results.push(relative(root, full));
    }
  }
  return results;
}

function scanRoot(root: ScanRoot): { files: string[]; hits: Hit[] } {
  const files = gatherSourceFiles(root.dir);
  const hits: Hit[] = [];
  for (const rel of files) {
    const label = `${root.label}/${rel}`;
    if (SEAM_OWNED.some((owned) => (owned.endsWith("/") ? label.startsWith(owned) : label === owned))) continue;
    const body = readFileSync(join(root.dir, rel), "utf8");
    body.split("\n").forEach((text, i) => {
      if (JOINED_BACKLOG_SEGMENT.test(text) || BACKLOG_PATH_LITERAL.test(text)) {
        hits.push({ label: root.label, file: label, line: i + 1, text: text.trim() });
      }
    });
  }
  return { files, hits };
}

function matchingAllowEntry(hit: Hit): AllowEntry | undefined {
  return ALLOWLIST.find((entry) => entry.file === hit.file && entry.pattern.test(hit.text));
}

/**
 * The gate proper. Asserts the vacuity precondition FIRST — a scan that found no
 * files is not a pass, it is a guard that stopped guarding because a directory
 * moved — and only then asserts zero unallowlisted hits.
 */
function assertGateHolds(roots: readonly ScanRoot[]): void {
  const unallowed: string[] = [];
  for (const root of roots) {
    const { files, hits } = scanRoot(root);
    assert.ok(
      files.length > 0,
      `FG-608 seam-bypass guard scanned no .ts files under ${root.label} — the path or the layout ` +
        `changed and the gate is no longer guarding anything.`,
    );
    for (const hit of hits) {
      if (!matchingAllowEntry(hit)) unallowed.push(`${hit.file}:${hit.line}: ${hit.text}`);
    }
  }
  assert.deepEqual(
    unallowed,
    [],
    `FG-608: direct backlog/ ticket-path construction outside the structured.ts seam. After the db-mode ` +
      `cutover backlog/*.md is a frozen snapshot, so a direct read returns stale ticket truth. Go through ` +
      `the seam (src/backlog/structured.ts), or add an ALLOWLIST entry with a reason if this genuinely ` +
      `is not a ticket read:\n${unallowed.join("\n")}`,
  );
}

const PRODUCT_ROOTS: readonly ScanRoot[] = [
  { label: "src", dir: SRC_ROOT },
  { label: "dashboard/src", dir: DASHBOARD_SRC_ROOT },
];

function withFixture(files: Record<string, string>, fn: (root: ScanRoot) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "fg608-seam-guard-"));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
    fn({ label: "src", dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the gate ---

test("FG-608: no direct backlog/ ticket-path construction outside the seam (src/ and dashboard/src/)", () => {
  assertGateHolds(PRODUCT_ROOTS);
});

// ------------------------------------------------- the gate guards itself ---

test("FG-608 guard: the vacuity precondition fails an empty scan of EITHER root", () => {
  // The production gate asserts files.length > 0 for src/ AND dashboard/src/ before
  // it asserts zero hits. Prove that precondition holds for both — an empty scan of
  // either root must FAIL, not pass, or the gate stops guarding the moment a
  // directory moves and nobody notices.
  const empty = mkdtempSync(join(tmpdir(), "fg608-seam-guard-empty-"));
  try {
    for (const label of ["src", "dashboard/src"]) {
      assert.throws(
        () => assertGateHolds([{ label, dir: empty }]),
        new RegExp(`scanned no \\.ts files under ${label}`),
        `an empty scan of ${label} must fail the gate`,
      );
      // ...and it must fail on the precondition even when paired with a healthy root,
      // so one live root cannot mask the other going dark.
      assert.throws(
        () => assertGateHolds([...PRODUCT_ROOTS, { label, dir: empty }]),
        new RegExp(`scanned no \\.ts files under ${label}`),
      );
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("FG-608 guard: a synthetic direct ticket read in a non-allowlisted file fails the gate", () => {
  withFixture(
    {
      "some/feature/reader.ts": [
        'import { readFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "export function readTicket(projectDir: string, id: string): string {",
        '  return readFileSync(join(projectDir, "backlog", "stories", `${id}.md`), "utf8");',
        "}",
      ].join("\n"),
    },
    (root) => {
      assert.throws(
        () => assertGateHolds([root]),
        /direct backlog\/ ticket-path construction/,
        "join(projectDir, 'backlog', 'stories', ...) in an unallowlisted file must fail the gate",
      );
    },
  );
});

test("FG-608 guard: a template-literal ticket path is caught too, not just join()", () => {
  withFixture(
    {
      "some/feature/template-reader.ts": [
        'import { readFileSync } from "node:fs";',
        "export function readTicket(projectDir: string, id: string): string {",
        '  return readFileSync(`${projectDir}/backlog/stories/${id}.md`, "utf8");',
        "}",
      ].join("\n"),
    },
    (root) => {
      assert.throws(() => assertGateHolds([root]), /direct backlog\/ ticket-path construction/);
    },
  );
});

test("FG-608 guard: the allowlist is scoped by path — the same construction elsewhere still fails", () => {
  // The exact notes.md read that IS allowed in src/cli/commands/backlog.ts, placed
  // in a different file. A pattern-only allowlist would wave this through.
  const notesRead = '  const notesPath = join(dir, "backlog", "notes.md");';
  withFixture({ "some/other/place.ts": notesRead }, (root) => {
    assert.throws(
      () => assertGateHolds([root]),
      /direct backlog\/ ticket-path construction/,
      "allowlist entries must be path-scoped, not global patterns",
    );
  });
  // ...and is genuinely allowed at its real home.
  const real = scanRoot({ label: "src", dir: SRC_ROOT }).hits.filter(
    (h) => h.file === "src/cli/commands/backlog.ts" && /notes\.md/.test(h.text),
  );
  assert.ok(real.length > 0, "expected the allowlisted notes.md reads in src/cli/commands/backlog.ts");
  for (const hit of real) assert.ok(matchingAllowEntry(hit), `${hit.file}:${hit.line} should be allowlisted`);
});

test("FG-608 guard: prose and non-path mentions of backlog do not trip the gate", () => {
  // These are the real shapes in the tree that must stay quiet: review-loop prompt
  // text, done-audit's git-relative path comparison, and error-message prose. If a
  // future widening of the pattern starts matching them, the fix is a narrower
  // pattern — not six more allowlist entries.
  withFixture(
    {
      "some/prose.ts": [
        'const rule = "when the diff CLOSES a ticket — moves it to `backlog/done/` — check the closeout text";',
        'const never = "Never edit `backlog/` ticket files and never run `forge backlog close`";',
        'const stillOpen = "the ticket is EXPECTED to still live in `backlog/stories/` with status: active";',
        "function isNoise(path: string): boolean {",
        '  return path === "backlog/notes.md" || path.startsWith(".forge-scratch/");',
        "}",
        'const err = `--ticket not found in backlog under ${projectDir}/backlog/ (ideas|epics|stories|done)`;',
      ].join("\n"),
    },
    (root) => {
      assert.deepEqual(scanRoot(root).hits, [], "prose mentioning backlog/ must not be flagged");
    },
  );
});

test("FG-608 guard: the guard does not scan itself", () => {
  const self = relative(SRC_ROOT, fileURLToPath(import.meta.url));
  const scanned = gatherSourceFiles(SRC_ROOT);
  assert.ok(!scanned.includes(self), `${self} must be excluded from its own scan`);
  // The exclusion is load-bearing, not incidental: this file's fixtures really do
  // contain the triggering construction.
  const own = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.ok(
    own.split("\n").some((line) => JOINED_BACKLOG_SEGMENT.test(line)),
    "this guard's fixtures should contain a matching construction, so self-exclusion is proven necessary",
  );
});

test("FG-608 guard: every allowlist entry is still load-bearing and carries a reason", () => {
  const hits = PRODUCT_ROOTS.flatMap((root) => scanRoot(root).hits);
  const stale: string[] = [];
  for (const entry of ALLOWLIST) {
    assert.ok(entry.reason.trim().length > 0, `allowlist entry for ${entry.file} must carry a reason`);
    if (!hits.some((hit) => hit.file === entry.file && entry.pattern.test(hit.text))) {
      stale.push(`${entry.file} :: ${entry.pattern}`);
    }
  }
  assert.deepEqual(
    stale,
    [],
    `Stale FG-608 allowlist entries — these no longer match anything, so they only widen the gate. ` +
      `Delete them:\n${stale.join("\n")}`,
  );
});

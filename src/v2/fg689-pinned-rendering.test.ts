// FG-689 step 3, unit tier: the pinned rendering's PARSING and REFUSAL contract, against a
// fake git seam. The tier boundary is deliberate — unit-tier files may not spawn
// subprocesses (src/test-tiers.test.ts enforces it), so everything here that needs a REAL git
// and a REAL hostile config lives in fg689-pinned-rendering.worktree.test.ts. What is proved
// here is what a real repository cannot easily be made to exhibit on demand: quoted paths,
// octal-escaped paths, malformed headers, and every refusal arm.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  REVIEW_DIFF_CONFIG_ARGS,
  REVIEW_DIFF_RENDERING_ID,
  REVIEW_DIFF_SIZE_UNIT,
  REVIEW_DIFF_SUBCOMMAND_ARGS,
  renderReviewDiff,
  reviewDiffArgs,
  type GitRunner,
} from "./review-diff.js";

const BASE = "1111111111111111111111111111111111111111";
const CAND = "2222222222222222222222222222222222222222";

/** A git seam that resolves both shas and returns a canned rendering. Records every argv it
 *  was called with, so the pinning is asserted by value rather than described. */
function fakeGit(rendering: string, opts: { unresolvable?: string[]; diffThrows?: string } = {}) {
  const calls: string[][] = [];
  const git: GitRunner = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") {
      const rev = (args[2] ?? "").replace(/\^\{commit\}$/, "");
      if (opts.unresolvable?.includes(rev)) throw new Error(`fatal: Needed a single revision`);
      return `${rev}\n`;
    }
    if (opts.diffThrows !== undefined) throw new Error(opts.diffThrows);
    return rendering;
  };
  return { git, calls };
}

function headersIn(rendering: string): string[] {
  return rendering.split("\n").filter((l) => l.startsWith("diff --git "));
}

const MODIFY = [
  "diff --git a/src/keep.ts b/src/keep.ts",
  "index c5b33a76..7414ca2c 100644",
  "--- a/src/keep.ts",
  "+++ b/src/keep.ts",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "",
].join("\n");

const ADD = [
  "diff --git a/src/added.ts b/src/added.ts",
  "new file mode 100644",
  "index 00000000..7fc6d848",
  "--- /dev/null",
  "+++ b/src/added.ts",
  "@@ -0,0 +1 @@",
  "+fresh",
  "",
].join("\n");

const DELETE = [
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "index a290ee39..00000000",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "",
].join("\n");

// A `git mv` under --no-renames renders as a delete plus an add, and BOTH paths must appear.
const RENAME_AS_DELETE = [
  "diff --git a/src/moveme.ts b/src/moveme.ts",
  "deleted file mode 100644",
  "index 3e75765b..00000000",
  "--- a/src/moveme.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-old",
  "",
].join("\n");

const RENAME_AS_ADD = [
  "diff --git a/src/moved.ts b/src/moved.ts",
  "new file mode 100644",
  "index 00000000..3e75765b",
  "--- /dev/null",
  "+++ b/src/moved.ts",
  "@@ -0,0 +1 @@",
  "+old",
  "",
].join("\n");

// core.quotepath=false, so non-ASCII arrives RAW rather than octal-escaped.
const NON_ASCII = [
  "diff --git a/docs/naïve-ünïcode-日本.md b/docs/naïve-ünïcode-日本.md",
  "index 11111111..22222222 100644",
  "--- a/docs/naïve-ünïcode-日本.md",
  "+++ b/docs/naïve-ünïcode-日本.md",
  "@@ -1 +1 @@",
  "-café",
  "+CAFÉ",
  "",
].join("\n");

test("FG-689: the argv is pinned by value, and renderingId is a hash OF that argv", () => {
  assert.deepEqual(REVIEW_DIFF_CONFIG_ARGS, [
    "-c",
    "core.quotepath=false",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.abbrev=8",
    "-c",
    "diff.external=",
    "-c",
    "diff.noprefix=false",
    "-c",
    "diff.mnemonicprefix=false",
    "-c",
    "diff.renames=false",
    "-c",
    "diff.suppressblankempty=false",
    "-c",
    "diff.indentheuristic=true",
    "-c",
    "diff.orderfile=/dev/null",
    "-c",
    "diff.srcprefix=a/",
    "-c",
    "diff.dstprefix=b/",
  ]);
  assert.deepEqual(REVIEW_DIFF_SUBCOMMAND_ARGS, [
    "diff",
    "--no-color",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "--unified=3",
    "--abbrev=8",
    "--ignore-submodules=none",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--diff-algorithm=myers",
    "--indent-heuristic",
  ]);
  assert.equal(REVIEW_DIFF_SIZE_UNIT, "utf8_bytes");

  // Not a hand-bumped constant: it is derived from the arrays above, so editing a flag
  // changes it and every derivation recorded under the old id is detectably stale.
  const expected = `review-diff-1-${createHash("sha256")
    .update(JSON.stringify([REVIEW_DIFF_CONFIG_ARGS, REVIEW_DIFF_SUBCOMMAND_ARGS, REVIEW_DIFF_SIZE_UNIT]))
    .digest("hex")
    .slice(0, 16)}`;
  assert.equal(REVIEW_DIFF_RENDERING_ID, expected);
  assert.notEqual(
    REVIEW_DIFF_RENDERING_ID,
    `review-diff-1-${createHash("sha256")
      .update(JSON.stringify([REVIEW_DIFF_CONFIG_ARGS, [...REVIEW_DIFF_SUBCOMMAND_ARGS, "--stat"], REVIEW_DIFF_SIZE_UNIT]))
      .digest("hex")
      .slice(0, 16)}`,
    "adding a flag must change the rendering id",
  );

  assert.deepEqual(reviewDiffArgs(BASE, CAND), [
    ...REVIEW_DIFF_CONFIG_ARGS,
    ...REVIEW_DIFF_SUBCOMMAND_ARGS,
    `${BASE}..${CAND}`,
  ]);
});

test("FG-689: the diff is invoked with exactly the pinned argv, over the RESOLVED shas", () => {
  const { git, calls } = fakeGit(MODIFY);
  const out = renderReviewDiff(git, { baseSha: "main", candidateSha: "HEAD" });
  assert.ok(out.ok);

  assert.deepEqual(calls[0], ["rev-parse", "--verify", "main^{commit}"]);
  assert.deepEqual(calls[1], ["rev-parse", "--verify", "HEAD^{commit}"]);
  // Commit-ness is CHECKED: `rev-parse --verify <rev>^{commit}` rather than bare rev-parse,
  // which echoes any 40-hex string back without consulting the object store.
  assert.deepEqual(calls[2], reviewDiffArgs("main", "HEAD"));
  assert.equal(calls.length, 3, "exactly one diff invocation — a second rendering could disagree");
  assert.equal(out.rendering.renderingId, REVIEW_DIFF_RENDERING_ID);
  assert.equal(out.rendering.unit, "utf8_bytes");
});

test("FG-689: paths are derived from the BODY, for every change shape", () => {
  const rendering = [MODIFY, ADD, DELETE, RENAME_AS_DELETE, RENAME_AS_ADD, NON_ASCII].join("");
  const { git } = fakeGit(rendering);
  const out = renderReviewDiff(git, { baseSha: BASE, candidateSha: CAND });
  assert.ok(out.ok);

  assert.deepEqual(out.rendering.paths, [
    "src/keep.ts",
    "src/added.ts",
    "src/gone.ts",
    "src/moveme.ts",
    "src/moved.ts",
    "docs/naïve-ünïcode-日本.md",
  ]);

  // A `git mv` under --no-renames is a delete plus an add, and BOTH paths are present.
  assert.ok(out.rendering.paths.includes("src/moveme.ts"));
  assert.ok(out.rendering.paths.includes("src/moved.ts"));

  // The independent check the acceptance names: `paths` equals exactly the set of paths
  // appearing in the rendered body, counted straight off its `diff --git` headers.
  assert.equal(out.rendering.paths.length, headersIn(rendering).length);
  for (const path of out.rendering.paths) {
    assert.ok(
      headersIn(rendering).includes(`diff --git a/${path} b/${path}`),
      `${path} must appear as a header in the rendered body`,
    );
  }

  // Each file's body is its own slice of the rendering, and the slices reassemble it exactly.
  assert.equal(out.rendering.files.map((f) => f.body).join(""), rendering);
});

test("FG-689: a quoted path — space, embedded quote, octal escape — is recovered exactly", () => {
  const spaced = 'diff --git a/src/my file.ts b/src/my file.ts\n@@ -1 +1 @@\n-a\n+b\n';
  const quotedQuote = 'diff --git "a/src/qu\\"ote.ts" "b/src/qu\\"ote.ts"\n@@ -1 +1 @@\n-a\n+b\n';
  // core.quotepath=false suppresses octal escaping for non-ASCII, but a path that also
  // carries a backslash is quoted whole and its non-ASCII bytes come back octal-escaped.
  const octal = 'diff --git "a/src/back\\\\slash-\\303\\251.ts" "b/src/back\\\\slash-\\303\\251.ts"\n@@ -1 +1 @@\n-a\n+b\n';

  const { git } = fakeGit([spaced, quotedQuote, octal].join(""));
  const out = renderReviewDiff(git, { baseSha: BASE, candidateSha: CAND });
  assert.ok(out.ok);
  assert.deepEqual(out.rendering.paths, ['src/my file.ts', 'src/qu"ote.ts', "src/back\\slash-é.ts"]);
});

test("FG-689: sizes are reported in BOTH units and neither is guessed from the other", () => {
  // The dogfood measurement that motivates this: FG-689's recorded numbers are `wc -c` byte
  // counts written down as "characters", and the two differ whenever the diff carries
  // non-ASCII content. A budget compared against `chars` must travel with the unit (D10).
  const { git } = fakeGit(NON_ASCII);
  const out = renderReviewDiff(git, { baseSha: BASE, candidateSha: CAND });
  assert.ok(out.ok);

  const file = out.rendering.files[0];
  assert.ok(file !== undefined);
  assert.equal(file.chars, Buffer.byteLength(NON_ASCII, "utf8"));
  assert.equal(file.utf16Chars, NON_ASCII.length);
  assert.ok(file.chars > file.utf16Chars, "this fixture carries non-ASCII, so bytes exceed UTF-16 units");
  assert.equal(out.rendering.totalChars, file.chars);
  assert.equal(out.rendering.totalUtf16Chars, file.utf16Chars);
});

test("FG-689: totals are the sum of the per-file measurements", () => {
  const rendering = [MODIFY, ADD, DELETE].join("");
  const { git } = fakeGit(rendering);
  const out = renderReviewDiff(git, { baseSha: BASE, candidateSha: CAND });
  assert.ok(out.ok);
  assert.equal(
    out.rendering.totalChars,
    out.rendering.files.reduce((n, f) => n + f.chars, 0),
  );
  assert.equal(out.rendering.totalChars, Buffer.byteLength(rendering, "utf8"));
  assert.equal(out.rendering.totalUtf16Chars, rendering.length);
});

test("FG-689: an empty diff renders as an empty change, not as a refusal", () => {
  const { git } = fakeGit("");
  const out = renderReviewDiff(git, { baseSha: BASE, candidateSha: CAND });
  assert.ok(out.ok);
  assert.deepEqual(out.rendering.paths, []);
  assert.deepEqual(out.rendering.files, []);
  assert.equal(out.rendering.totalChars, 0);
});

test("FG-689: a missing base sha refuses BY NAME, with no ~1 fallback", () => {
  const { git, calls } = fakeGit(MODIFY);
  const out = renderReviewDiff(git, { candidateSha: CAND });
  assert.ok(!out.ok);
  assert.equal(out.reason, "base_sha_missing");
  assert.match(out.refusal, /no recorded base sha/);
  assert.match(out.refusal, /~1 fallback/);
  assert.equal(calls.length, 0, "a review with no base must not reach git at all");
});

test("FG-689: an unresolvable base or candidate refuses BY NAME", () => {
  const base = fakeGit(MODIFY, { unresolvable: [BASE] });
  const outBase = renderReviewDiff(base.git, { baseSha: BASE, candidateSha: CAND });
  assert.ok(!outBase.ok);
  assert.equal(outBase.reason, "base_sha_unresolved");
  assert.match(outBase.refusal, new RegExp(BASE));
  assert.ok(
    !base.calls.some((c) => c[0] === "diff"),
    "an unresolvable base must not reach the diff",
  );

  const cand = fakeGit(MODIFY, { unresolvable: [CAND] });
  const outCand = renderReviewDiff(cand.git, { baseSha: BASE, candidateSha: CAND });
  assert.ok(!outCand.ok);
  assert.equal(outCand.reason, "candidate_sha_unresolved");
  assert.match(outCand.refusal, new RegExp(CAND));
});

test("FG-689 D15: a git failure refuses BY NAME and never returns a placeholder diff", () => {
  const { git } = fakeGit(MODIFY, { diffThrows: "fatal: bad object" });
  const out = renderReviewDiff(git, { baseSha: BASE, candidateSha: CAND });
  assert.ok(!out.ok);
  assert.equal(out.reason, "diff_unreadable");
  assert.match(out.refusal, /fatal: bad object/);
  assert.match(out.refusal, /NOT dispatched over a substitute/);
});

test("FG-689: an unreadable rendering refuses rather than reporting a partial path set", () => {
  const preamble = fakeGit(`warning: something\n${MODIFY}`);
  const outPreamble = renderReviewDiff(preamble.git, { baseSha: BASE, candidateSha: CAND });
  assert.ok(!outPreamble.ok);
  assert.equal(outPreamble.reason, "rendering_unparsable");
  assert.match(outPreamble.refusal, /does not begin with a 'diff --git' header/);

  // A header whose two halves disagree is not approximately recovered — a mis-recovered path
  // is an uncovered surface reported under the wrong name.
  const asymmetric = fakeGit("diff --git a/src/left.ts b/src/right.ts\n@@ -1 +1 @@\n-a\n+b\n");
  const outAsym = renderReviewDiff(asymmetric.git, { baseSha: BASE, candidateSha: CAND });
  assert.ok(!outAsym.ok);
  assert.equal(outAsym.reason, "rendering_unparsable");
  assert.match(outAsym.refusal, /does not carry a recoverable path/);

  const duplicate = fakeGit([MODIFY, MODIFY].join(""));
  const outDup = renderReviewDiff(duplicate.git, { baseSha: BASE, candidateSha: CAND });
  assert.ok(!outDup.ok);
  assert.equal(outDup.reason, "rendering_unparsable");
  assert.match(outDup.refusal, /appears in more than one file header/);
});

test("FG-689: a 'diff --git' line INSIDE a hunk is content, not a file header", () => {
  // Reviewing this very ticket means reviewing diffs that quote diffs. Every line inside a
  // hunk carries a ' ', '+' or '-' prefix, so the split must anchor at column 0.
  const nested = [
    "diff --git a/src/fixture.ts b/src/fixture.ts",
    "index 11111111..22222222 100644",
    "--- a/src/fixture.ts",
    "+++ b/src/fixture.ts",
    "@@ -1,2 +1,3 @@",
    " const FIXTURE = `",
    '+diff --git a/not/a/file.ts b/not/a/file.ts',
    "-diff --git a/also/not.ts b/also/not.ts",
    "",
  ].join("\n");
  const { git } = fakeGit(nested);
  const out = renderReviewDiff(git, { baseSha: BASE, candidateSha: CAND });
  assert.ok(out.ok);
  assert.deepEqual(out.rendering.paths, ["src/fixture.ts"]);
});

test("FG-689 D14/D15: the module has no second rendering and no placeholder string", () => {
  const source = readFileSync(fileURLToPath(new URL("./review-diff.ts", import.meta.url)), "utf8");
  const code = source
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n");

  assert.ok(
    !/could not be computed/.test(source),
    "the placeholder-diff string D15 removes must not exist anywhere in this module",
  );
  assert.ok(
    !/--name-only/.test(code),
    "the changed-path set is derived from the rendered body; a --name-only invocation is a second rendering that can disagree with it",
  );
  // The absence of a `~1` base fallback is asserted BEHAVIOURALLY above ("a missing base sha
  // refuses BY NAME"), not by grepping — the refusal text names `~1` precisely in order to
  // tell the operator that no such fallback exists.
});

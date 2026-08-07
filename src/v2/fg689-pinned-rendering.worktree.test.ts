// FG-689 step 3, worktree tier: the pinned rendering against a REAL git, REAL hostile
// ambient config, and the REAL dogfood candidate.
//
// WHY THIS TIER. The unit tier proves the parser; it cannot prove the pinning, because the
// pinning is a claim about what a git binary does when a project's config is set against it.
// `-c diff.context=10` in review-diff.ts is worth nothing if `--unified=3` does not actually
// outrank it, and the only way to know is to set the config in a real repository and compare
// the bytes. Each hostile setting below is asserted INDIVIDUALLY, so a regression names the
// setting that leaked rather than reporting "something changed".
//
// The last test measures FG-689's dogfood candidate — the numbers the plan recorded with
// DEFAULT flags — to prove the pinning introduces no delta on the change this ticket exists
// to review. It needs the forge repository's own history, so it skips (loudly, naming why)
// where that history is absent: the container scratch that `forge-test` builds deliberately
// does not copy .git.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_DIFF_RENDERING_ID, renderReviewDiff, type GitRunner } from "./review-diff.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "fg689",
  GIT_AUTHOR_EMAIL: "fg689@example.invalid",
  GIT_COMMITTER_NAME: "fg689",
  GIT_COMMITTER_EMAIL: "fg689@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  // The rendering must survive a hostile ENVIRONMENT too, not only hostile config files.
  GIT_EXTERNAL_DIFF: "/bin/false",
};

// stderr is PIPED rather than inherited: the refusal arms below drive git into real failures
// on purpose, and execFileSync still bundles the message into the thrown error, so nothing is
// lost — it just stops the expected `fatal:` lines from reading like test output.
const GIT_STDIO = ["ignore", "pipe", "pipe"] as const;

function gitIn(dir: string): GitRunner {
  return (args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: GIT_ENV,
      stdio: [...GIT_STDIO],
      maxBuffer: 64 * 1024 * 1024,
    });
}

function run(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV, stdio: [...GIT_STDIO] });
}

function write(dir: string, path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

/** A fixture carrying every change shape the acceptance names: a plain modification, an
 *  addition, a deletion, a non-ASCII path, a path with a space, and a `git mv`. */
function makeFixture(): { dir: string; baseSha: string; candidateSha: string; renamedFrom: string; renamedTo: string } {
  const dir = mkdtempSync(join(tmpdir(), "fg689-pinned-"));
  run(dir, ["init", "-q", "-b", "main"]);

  write(dir, "src/keep.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
  write(dir, "src/gone.ts", "bye\n");
  write(dir, "src/moveme.ts", "carried across\n");
  write(dir, "docs/naïve-ünïcode-日本.md", "café\n");
  write(dir, "docs/with space.md", "spaced\n");
  run(dir, ["add", "-A"]);
  run(dir, ["commit", "-qm", "base"]);
  const baseSha = run(dir, ["rev-parse", "HEAD"]).trim();

  write(dir, "src/keep.ts", "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\n");
  write(dir, "src/added.ts", "fresh\n");
  rmSync(join(dir, "src/gone.ts"));
  write(dir, "docs/naïve-ünïcode-日本.md", "CAFÉ ☕\n");
  write(dir, "docs/with space.md", "SPACED\n");
  run(dir, ["mv", "src/moveme.ts", "src/moved.ts"]);
  run(dir, ["add", "-A"]);
  run(dir, ["commit", "-qm", "candidate"]);
  const candidateSha = run(dir, ["rev-parse", "HEAD"]).trim();

  return { dir, baseSha, candidateSha, renamedFrom: "src/moveme.ts", renamedTo: "src/moved.ts" };
}

// Each of these changes the bytes `git diff` emits when it is left to ambient config. The
// first six are the settings FG-689's acceptance names by hand; the rest are the ones that
// turned up while pinning the flag set, and each is here because it was observed to leak
// before its counter-flag was added.
const HOSTILE_CONFIG: readonly [string, string][] = [
  ["diff.context", "10"],
  ["diff.noprefix", "true"],
  ["diff.renames", "copies"],
  ["core.quotepath", "true"],
  ["diff.external", "/bin/false"],
  ["core.autocrlf", "true"],
  ["diff.mnemonicPrefix", "true"],
  ["diff.suppressBlankEmpty", "true"],
  ["diff.algorithm", "histogram"],
  ["diff.indentHeuristic", "false"],
  ["core.abbrev", "40"],
  ["color.diff", "always"],
  ["color.ui", "always"],
  ["diff.wsErrorHighlight", "all"],
  ["diff.relative", "true"],
];

test("FG-689 D8: the same two shas render BYTE-IDENTICALLY under hostile ambient git config", () => {
  const fx = makeFixture();
  try {
    const git = gitIn(fx.dir);
    const pristine = renderReviewDiff(git, { baseSha: fx.baseSha, candidateSha: fx.candidateSha });
    assert.ok(pristine.ok, "the pristine rendering must succeed");
    const baseline = pristine.rendering;
    assert.ok(baseline.totalChars > 0);

    for (const [key, value] of HOSTILE_CONFIG) {
      run(fx.dir, ["config", key, value]);
      const hostile = renderReviewDiff(git, { baseSha: fx.baseSha, candidateSha: fx.candidateSha });
      assert.ok(hostile.ok, `${key}=${value} made the rendering refuse`);
      assert.deepEqual(
        hostile.rendering,
        baseline,
        `${key}=${value} perturbed the pinned rendering — the flag that counters it is missing or outranked`,
      );
      run(fx.dir, ["config", "--unset", key]);
    }

    // And with EVERY hostile setting on at once, which is the state a real project's config
    // can genuinely be in.
    for (const [key, value] of HOSTILE_CONFIG) run(fx.dir, ["config", key, value]);
    const allHostile = renderReviewDiff(git, { baseSha: fx.baseSha, candidateSha: fx.candidateSha });
    assert.ok(allHostile.ok);
    assert.deepEqual(allHostile.rendering, baseline, "the pinned rendering leaked under the full hostile config");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("FG-689 D14: `paths` is exactly the set of paths in the rendered body, for every change shape", () => {
  const fx = makeFixture();
  try {
    const out = renderReviewDiff(gitIn(fx.dir), { baseSha: fx.baseSha, candidateSha: fx.candidateSha });
    assert.ok(out.ok);
    const { paths, files } = out.rendering;

    assert.deepEqual(
      [...paths].sort(),
      [
        "docs/naïve-ünïcode-日本.md",
        "docs/with space.md",
        "src/added.ts",
        "src/gone.ts",
        "src/keep.ts",
        "src/moved.ts",
        "src/moveme.ts",
      ],
      "modification, addition, deletion, non-ASCII path, spaced path, and BOTH halves of the rename",
    );

    // Under --no-renames a `git mv` is a delete plus an add, and BOTH paths appear — which is
    // the point: a rename-detected rendering would report one path where the coverage check
    // must see two.
    assert.ok(paths.includes(fx.renamedFrom), "the rename's source path must be covered");
    assert.ok(paths.includes(fx.renamedTo), "the rename's destination path must be covered");
    assert.match(files.find((f) => f.path === fx.renamedFrom)?.body ?? "", /deleted file mode/);
    assert.match(files.find((f) => f.path === fx.renamedTo)?.body ?? "", /new file mode/);

    // The independent derivation: every `diff --git` header in the concatenated body, counted
    // straight off the bytes.
    const rendered = files.map((f) => f.body).join("");
    const headers = rendered.split("\n").filter((l) => l.startsWith("diff --git "));
    assert.equal(headers.length, paths.length, "one header per reported path, no more and no fewer");
    for (const path of paths) {
      assert.ok(
        headers.some((h) => h.includes(`a/${path} b/${path}`) || h.includes(`a/${path}" "b/${path}`)),
        `${path} must appear in a header of the body it was derived from`,
      );
    }

    // Sizes are measured off the real bytes, in both units, and the totals add up.
    assert.equal(out.rendering.totalChars, Buffer.byteLength(rendered, "utf8"));
    assert.equal(out.rendering.totalUtf16Chars, rendered.length);
    assert.equal(out.rendering.renderingId, REVIEW_DIFF_RENDERING_ID);
    assert.equal(out.rendering.unit, "utf8_bytes");
    assert.equal(out.rendering.baseSha, fx.baseSha);
    assert.equal(out.rendering.candidateSha, fx.candidateSha);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("FG-689: a path git must QUOTE round-trips through the header parser", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fg689-quoted-"));
  try {
    run(dir, ["init", "-q", "-b", "main"]);
    const awkward = 'src/qu"ote-and-back\\slash.ts';
    try {
      write(dir, awkward, "before\n");
    } catch {
      t.skip("this filesystem rejects quote/backslash filenames; the unit tier covers the parser");
      return;
    }
    run(dir, ["add", "-A"]);
    run(dir, ["commit", "-qm", "base"]);
    const baseSha = run(dir, ["rev-parse", "HEAD"]).trim();
    write(dir, awkward, "after\n");
    run(dir, ["add", "-A"]);
    run(dir, ["commit", "-qm", "candidate"]);
    const candidateSha = run(dir, ["rev-parse", "HEAD"]).trim();

    const out = renderReviewDiff(gitIn(dir), { baseSha, candidateSha });
    assert.ok(out.ok);
    assert.deepEqual(out.rendering.paths, [awkward]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FG-689 D15: a base that does not resolve refuses BY NAME against a real git", () => {
  const fx = makeFixture();
  try {
    const git = gitIn(fx.dir);

    // A 40-hex string that is not an object here. Bare `git rev-parse` echoes it back with
    // exit 0, which is precisely why commit-ness is verified rather than assumed.
    const ghost = "deadbeef".repeat(5);
    const unresolved = renderReviewDiff(git, { baseSha: ghost, candidateSha: fx.candidateSha });
    assert.ok(!unresolved.ok);
    assert.equal(unresolved.reason, "base_sha_unresolved");
    assert.match(unresolved.refusal, new RegExp(ghost));

    // A tree, not a commit: `rev-parse --verify <rev>^{commit}` must reject it.
    const tree = run(fx.dir, ["rev-parse", `${fx.candidateSha}^{tree}`]).trim();
    const notACommit = renderReviewDiff(git, { baseSha: tree, candidateSha: fx.candidateSha });
    assert.ok(!notACommit.ok);
    assert.equal(notACommit.reason, "base_sha_unresolved");

    const noBase = renderReviewDiff(git, { candidateSha: fx.candidateSha });
    assert.ok(!noBase.ok);
    assert.equal(noBase.reason, "base_sha_missing");

    // A repository git cannot read at all — the arm the removed placeholder used to swallow.
    const notARepo = mkdtempSync(join(tmpdir(), "fg689-norepo-"));
    try {
      const broken = renderReviewDiff(gitIn(notARepo), { baseSha: fx.baseSha, candidateSha: fx.candidateSha });
      assert.ok(!broken.ok);
      assert.equal(broken.reason, "base_sha_unresolved");
      assert.match(broken.refusal, /Nothing was rendered/);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

// FG-689's dogfood candidate, and the numbers the plan measured with DEFAULT flags. Asserting
// them under the PINNED flags is what proves the pinning introduces no delta on the change
// this ticket exists to be able to review.
const DOGFOOD = {
  baseSha: "11c2b561",
  candidateSha: "c4fe691a",
  paths: 46,
  // UTF-8 BYTES — `wc -c`, which is what every FG-689 measurement is denominated in. The same
  // rendering is 1,148,986 UTF-16 units; the 21,899 gap is non-ASCII diff CONTENT (no path in
  // this candidate is non-ASCII). Both are asserted so the unit can never be silently
  // reinterpreted downstream (D10).
  totalChars: 1_170_885,
  totalUtf16Chars: 1_148_986,
  largestPath: "src/cli/commands/queue.ts",
  largestChars: 80_462,
};

function forgeRepoRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

test("FG-689 AC8: the pinned rendering of the dogfood candidate matches the measured numbers", (t) => {
  const root = forgeRepoRoot();
  if (root === undefined) {
    t.skip("no .git above this file — the forge-test container scratch does not copy it");
    return;
  }
  const git = gitIn(root);
  for (const sha of [DOGFOOD.baseSha, DOGFOOD.candidateSha]) {
    try {
      git(["rev-parse", "--verify", `${sha}^{commit}`]);
    } catch {
      t.skip(`${sha} is not present in ${root} (a shallow or partial clone); the dogfood measurement needs full history`);
      return;
    }
  }

  const out = renderReviewDiff(git, { baseSha: DOGFOOD.baseSha, candidateSha: DOGFOOD.candidateSha });
  assert.ok(out.ok, "the dogfood candidate must render");
  const r = out.rendering;

  assert.equal(r.paths.length, DOGFOOD.paths, "46 changed paths");
  assert.equal(new Set(r.paths).size, r.paths.length, "no path is reported twice");
  assert.equal(r.totalChars, DOGFOOD.totalChars, "pinning must introduce no delta against the measured byte count");
  assert.equal(r.totalUtf16Chars, DOGFOOD.totalUtf16Chars);
  assert.equal(r.files.length, DOGFOOD.paths);

  const largest = [...r.files].sort((a, b) => b.chars - a.chars)[0];
  assert.ok(largest !== undefined);
  assert.equal(largest.path, DOGFOOD.largestPath);
  assert.equal(largest.chars, DOGFOOD.largestChars);

  // NO PATH IS LOST between the rendering and its per-file bodies — the property everything
  // downstream (coverage, sharding) is built on.
  assert.deepEqual(
    r.files.map((f) => f.path),
    r.paths,
  );
  assert.equal(
    r.files.reduce((n, f) => n + f.chars, 0),
    r.totalChars,
  );

  // The rendering is REPRODUCIBLE: the same two shas, again, byte for byte.
  const again = renderReviewDiff(git, { baseSha: DOGFOOD.baseSha, candidateSha: DOGFOOD.candidateSha });
  assert.ok(again.ok);
  assert.deepEqual(again.rendering, r);

  // Full shas are what the derivation records, not the abbreviations the caller supplied.
  assert.match(r.baseSha, /^[0-9a-f]{40}$/);
  assert.match(r.candidateSha, /^[0-9a-f]{40}$/);
  assert.ok(r.baseSha.startsWith(DOGFOOD.baseSha));
  assert.ok(r.candidateSha.startsWith(DOGFOOD.candidateSha));
});

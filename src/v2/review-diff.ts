// FG-689 (D8, D14): THE ONE PINNED RENDERING of a review's implementation diff.
//
// WHY THIS MODULE EXISTS. The review lifecycle asks two questions of the same change —
// "which paths changed?" (checked for lens coverage at confirmation) and "what bytes does
// each lens read?" (cut into shards at dispatch) — and until now it asked them of two
// different git invocations. `review-wiring.ts` computed the path set with
// `git diff --name-only` and no rename flag, and computed the reviewer's diff with a bare
// `git diff` and no flags at all. Two unpinned renderings of the same range can disagree:
// rename detection folds two paths into one on one side and not the other, `diff.orderFile`
// reorders, `core.quotepath` re-spells a non-ASCII path. "Every changed path is covered by
// a lens" is then true of one rendering and false of the other, and the coverage guarantee
// is vacuous.
//
// Independently pinning two renderings does NOT fix this — it makes them agree only for as
// long as nobody edits one flag list. The fix is that both answers come from ONE set of
// bytes: `paths` here is derived by splitting the rendered BODY on its `diff --git` headers.
// There is deliberately no second git invocation to disagree with. If you find yourself
// adding `--name-only` anywhere in the review path, that is the defect returning.
//
// PINNING. Every flag below is set so the rendering cannot inherit ambient git config from
// the project being reviewed. Verified against git 2.34: `diff.context`, `diff.noprefix`,
// `diff.renames`, `core.quotepath`, `diff.external`, `core.autocrlf`, `diff.mnemonicPrefix`,
// `diff.suppressBlankEmpty`, `diff.algorithm`, `diff.indentHeuristic`, `diff.orderFile`,
// `core.abbrev`, `color.diff` and `color.ui` each change the bytes `git diff` emits, and each
// is neutralised here. `renderingId` is a hash OF THE PINNED ARGV, not a hand-bumped
// constant, so editing any flag changes the id automatically and invalidates every derivation
// recorded under the old one — a flag change can never silently re-partition a review.
//
// TWO DEVIATIONS from the flag list FG-689's plan wrote down, both because the literal list
// does not run:
//   * `--find-copies=false` is not valid git ("error: invalid argument to find-copies").
//     Copy detection is only ever enabled by `-C`/`--find-copies` or `diff.renames=copies`,
//     and `--no-renames` disables rename AND copy detection together, so the intent is
//     carried by `--no-renames` plus `-c diff.renames=false`. Asserted: `diff.renames=copies`
//     in ambient config does not perturb the rendering.
//   * `-c diff.orderFile=` (empty) is a fatal error ("failed to read orderfile ''"), so the
//     neutral value is `/dev/null`.
//
// THE SIZE UNIT, and it is load-bearing (D10). FG-689's measurements — 1,170,885 for the
// whole dogfood candidate, 80,462 for its largest single file — are UTF-8 BYTE counts (`wc
// -c`), written down as "characters". They are not the same number: the same rendering is
// 1,148,986 JavaScript string units, a 21,899 gap, because the diff carries non-ASCII
// content (no non-ASCII PATHS, but non-ASCII bytes inside the bodies). Reading a byte count
// as a character count, or the reverse, is exactly the reinterpretation D10 exists to
// prevent, so this module reports BOTH and names the unit of each rather than picking one
// silently. `chars`/`totalChars` are UTF-8 bytes — the conservative measure, since bytes are
// never fewer than code points, and the one every recorded FG-689 number is denominated in.
// `utf16Chars`/`totalUtf16Chars` are what `String.prototype.length` sees. A budget compared
// against `chars` must record `REVIEW_DIFF_SIZE_UNIT` beside it.
//
// NO PLACEHOLDER, EVER (D15). A rendering that fails returns a NAMED refusal. It never
// returns a string standing in for the diff. What it replaces is the `catch`-and-substitute
// in review-wiring's lens dispatch, which handed the reviewer an apologetic sentence when git
// failed — the live instance of the failure FG-689 is about: a reviewer handed a
// not-the-diff authors an honest, schema-valid `pass` over it, discovery counts that as a
// completed outcome, and the disposition gate clears on a review that never happened. The
// placeholder sentence is deliberately not quoted anywhere in this file, so that grepping for
// it across src/ finds only the call site step 8 deletes.

import { createHash } from "node:crypto";

/** The git seam. Takes argv, returns stdout, THROWS on non-zero exit — the same shape
 *  `realGit` in review-wiring already has, so the real wiring passes itself in unchanged and
 *  the unit tier passes a fake that never spawns a process. */
export type GitRunner = (args: string[]) => string;

/** Config overrides, applied BEFORE the subcommand. Command-line `-c` outranks every config
 *  file and outranks `GIT_CONFIG_KEY_*` env injection, so this is the strongest available
 *  statement of "ignore what the project's config says". */
export const REVIEW_DIFF_CONFIG_ARGS: readonly string[] = [
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
];

/** The pinned subcommand, everything except the range. `--src-prefix`/`--dst-prefix` are
 *  restated on the command line as well as in config because they are what the header parser
 *  below depends on: it recovers a path by proving the two halves of `a/<p> b/<p>` are the
 *  same string, which requires the prefixes to be exactly `a/` and `b/`. */
export const REVIEW_DIFF_SUBCOMMAND_ARGS: readonly string[] = [
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
];

/** The unit `chars` / `totalChars` / a shard budget compared against them are denominated in.
 *  Carried so a later provider change cannot reinterpret the number (D10). */
export const REVIEW_DIFF_SIZE_UNIT = "utf8_bytes" as const;
export type ReviewDiffSizeUnit = typeof REVIEW_DIFF_SIZE_UNIT;

/** Names the pinned flag set by HASHING it. Not a constant anybody has to remember to bump:
 *  add, remove or reorder a flag above and this changes, which is what makes a recorded
 *  derivation detect a re-partition instead of silently describing a partition that no
 *  longer exists. */
export const REVIEW_DIFF_RENDERING_ID: string = `review-diff-1-${createHash("sha256")
  .update(JSON.stringify([REVIEW_DIFF_CONFIG_ARGS, REVIEW_DIFF_SUBCOMMAND_ARGS, REVIEW_DIFF_SIZE_UNIT]))
  .digest("hex")
  .slice(0, 16)}`;

/** The exact argv this module runs. Exported so a test can lock the pinning by value rather
 *  than by re-describing it. */
export function reviewDiffArgs(baseSha: string, candidateSha: string): string[] {
  return [...REVIEW_DIFF_CONFIG_ARGS, ...REVIEW_DIFF_SUBCOMMAND_ARGS, `${baseSha}..${candidateSha}`];
}

export type ReviewDiffFile = {
  path: string;
  /** This file's slice of the rendering, headers included, verbatim. */
  body: string;
  /** UTF-8 bytes — see REVIEW_DIFF_SIZE_UNIT. */
  chars: number;
  /** `body.length`, i.e. UTF-16 code units. Reported beside `chars` so the two are never
   *  confused for one another. */
  utf16Chars: number;
};

export type ReviewDiffRendering = {
  renderingId: string;
  unit: ReviewDiffSizeUnit;
  /** The RESOLVED shas, full 40-hex. The derivation records these, not whatever abbreviation
   *  or ref name the caller supplied. */
  baseSha: string;
  candidateSha: string;
  files: ReviewDiffFile[];
  /** Exactly the paths appearing in the rendered body, in rendering order. Derived from the
   *  body — never from a second git invocation. */
  paths: string[];
  totalChars: number;
  totalUtf16Chars: number;
};

export type ReviewDiffRefusalReason =
  | "base_sha_missing"
  | "base_sha_unresolved"
  | "candidate_sha_unresolved"
  | "diff_unreadable"
  | "rendering_unparsable";

export type ReviewDiffResult =
  | { ok: true; rendering: ReviewDiffRendering }
  | { ok: false; reason: ReviewDiffRefusalReason; refusal: string };

const HEADER_MARK = "diff --git ";

/** Render the review diff once, pinned, and derive the changed-path set from those same
 *  bytes.
 *
 *  `baseSha` is REQUIRED and there is no `<candidate>~1` fallback. A per-seam fallback base
 *  is how two parts of one guarantee end up describing different changes: coverage checked
 *  against the recorded base, shards cut against a synthesised one. One recorded base, or a
 *  refusal. */
export function renderReviewDiff(git: GitRunner, args: { baseSha?: string; candidateSha: string }): ReviewDiffResult {
  const baseSha = args.baseSha?.trim() ?? "";
  const candidateSha = args.candidateSha.trim();

  if (baseSha === "") {
    return {
      ok: false,
      reason: "base_sha_missing",
      refusal:
        `this review has no recorded base sha, so its implementation diff cannot be rendered. There is ` +
        `deliberately no ${candidateSha || "<candidate>"}~1 fallback: a synthesised base would let the ` +
        `coverage check and the shards describe two different changes. Record a base (forge review start ` +
        `--since <sha>) and re-enter. Nothing was rendered.`,
    };
  }

  // COMMIT-NESS IS CHECKED, NOT ASSUMED — the same idiom, and for the same reason, as
  // resolveReviewBase: bare `git rev-parse <40-hex>` echoes any 40-hex string back with exit
  // 0 without consulting the object store, so a sha that was rebased away or pasted from
  // another repo "resolves" and the diff below then dies with a raw stack trace.
  const resolve = (rev: string): string | undefined => {
    try {
      const sha = git(["rev-parse", "--verify", `${rev}^{commit}`]).trim();
      return sha === "" ? undefined : sha;
    } catch {
      return undefined;
    }
  };

  const resolvedBase = resolve(baseSha);
  if (resolvedBase === undefined) {
    return {
      ok: false,
      reason: "base_sha_unresolved",
      refusal:
        `the recorded base ${baseSha} does not name a commit in this repository, so the review's ` +
        `implementation diff cannot be rendered and no reviewer can be dispatched over it. Nothing was ` +
        `rendered.`,
    };
  }
  const resolvedCandidate = resolve(candidateSha);
  if (resolvedCandidate === undefined) {
    return {
      ok: false,
      reason: "candidate_sha_unresolved",
      refusal:
        `the candidate ${candidateSha} does not name a commit in this repository, so the review's ` +
        `implementation diff cannot be rendered and no reviewer can be dispatched over it. Nothing was ` +
        `rendered.`,
    };
  }

  let body: string;
  try {
    body = git(reviewDiffArgs(resolvedBase, resolvedCandidate));
  } catch (err) {
    return {
      ok: false,
      reason: "diff_unreadable",
      refusal:
        `git could not render ${resolvedBase}..${resolvedCandidate} (${(err as Error).message}). The ` +
        `review is NOT dispatched over a substitute: a reviewer handed anything other than the diff can ` +
        `author an honest pass over it, and that pass would clear the disposition gate. Nothing was rendered.`,
    };
  }

  const split = splitRendering(body);
  if ("error" in split) {
    return {
      ok: false,
      reason: "rendering_unparsable",
      refusal:
        `the pinned rendering of ${resolvedBase}..${resolvedCandidate} could not be split into per-file ` +
        `bodies: ${split.error}. The changed-path set is derived from these bytes, so a rendering this ` +
        `module cannot read is a coverage check it cannot make. Nothing was rendered.`,
    };
  }

  const files = split.files;
  return {
    ok: true,
    rendering: {
      renderingId: REVIEW_DIFF_RENDERING_ID,
      unit: REVIEW_DIFF_SIZE_UNIT,
      baseSha: resolvedBase,
      candidateSha: resolvedCandidate,
      files,
      paths: files.map((f) => f.path),
      totalChars: files.reduce((n, f) => n + f.chars, 0),
      totalUtf16Chars: files.reduce((n, f) => n + f.utf16Chars, 0),
    },
  };
}

/** Split the rendering into per-file bodies and recover each path FROM THE HEADER LINE.
 *
 *  Every failure here refuses. A header this cannot decode with certainty is never guessed
 *  at: a mis-recovered path is an uncovered surface reported under the wrong name, which is
 *  the coverage guarantee failing while reporting success. */
function splitRendering(body: string): { files: ReviewDiffFile[] } | { error: string } {
  if (body === "") return { files: [] };

  const starts: number[] = [];
  for (let i = body.indexOf(HEADER_MARK); i !== -1; i = body.indexOf(HEADER_MARK, i + 1)) {
    // Only at a line start. Inside a hunk every line carries a ' ', '+' or '-' prefix, so a
    // diff quoted in the reviewed content can never be mistaken for a file header.
    if (i === 0 || body[i - 1] === "\n") starts.push(i);
  }

  if (starts.length === 0 || starts[0] !== 0) {
    return { error: "the output does not begin with a 'diff --git' header" };
  }

  const files: ReviewDiffFile[] = [];
  const seen = new Set<string>();
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k] as number;
    const end = k + 1 < starts.length ? (starts[k + 1] as number) : body.length;
    const segment = body.slice(start, end);
    const nl = segment.indexOf("\n");
    const headerLine = nl === -1 ? segment : segment.slice(0, nl);
    const path = pathFromHeader(headerLine.slice(HEADER_MARK.length));
    if (path === undefined) {
      return { error: `header ${JSON.stringify(headerLine)} does not carry a recoverable path` };
    }
    if (seen.has(path)) {
      // Under --no-renames each path appears at most once. A repeat means the rendering is
      // not the shape this module reasons about, and a shard plan built over it would double-
      // count or drop bytes.
      return { error: `the path ${JSON.stringify(path)} appears in more than one file header` };
    }
    seen.add(path);
    files.push({
      path,
      body: segment,
      chars: Buffer.byteLength(segment, "utf8"),
      utf16Chars: segment.length,
    });
  }
  return { files };
}

/** Recover the path from the header line's remainder, `a/<p> b/<p>` or `"a/<p>" "b/<p>"`.
 *
 *  NOT by scanning for a space: git does not quote paths merely for containing one, so
 *  `a/my file.ts b/my file.ts` has three spaces and no way to pick the right one locally.
 *  What makes it decidable is that under `--no-renames --src-prefix=a/ --dst-prefix=b/` the
 *  two sides are always the SAME path — additions and deletions included, which name the file
 *  on both sides and put /dev/null in the ---/+++ lines. So the line is split at its exact
 *  midpoint and the halves are required to agree once the prefix letter is swapped. Anything
 *  that fails that check is unrecoverable rather than approximately recovered. */
function pathFromHeader(rest: string): string | undefined {
  if (rest.length < 5 || (rest.length - 1) % 2 !== 0) return undefined;
  const half = (rest.length - 1) / 2;
  if (rest[half] !== " ") return undefined;
  const left = rest.slice(0, half);
  const right = rest.slice(half + 1);

  const quoted = left.startsWith('"');
  if (quoted && !left.endsWith('"')) return undefined;
  const at = quoted ? 1 : 0;
  if (left[at] !== "a" || left[at + 1] !== "/") return undefined;
  if (`${left.slice(0, at)}b${left.slice(at + 1)}` !== right) return undefined;

  const inner = quoted ? left.slice(1, -1) : left;
  const spelled = inner.slice(2);
  if (spelled === "") return undefined;
  return quoted ? unquoteCStyle(spelled) : spelled;
}

const C_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  '"': '"',
};

/** Undo git's C-style path quoting. With `core.quotepath=false` non-ASCII is emitted raw, so
 *  what still arrives quoted is a path containing a quote, a backslash or a control byte.
 *  Octal escapes are collected as BYTES and decoded as UTF-8 together, because one non-ASCII
 *  code point spans several `\nnn` escapes and decoding them one at a time would mangle it.
 *  `undefined` on any escape this does not recognise — the caller refuses. */
function unquoteCStyle(spelled: string): string | undefined {
  const bytes: number[] = [];
  for (let i = 0; i < spelled.length; i++) {
    const ch = spelled[i] as string;
    if (ch !== "\\") {
      for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
      continue;
    }
    const next = spelled[i + 1];
    if (next === undefined) return undefined;
    if (next >= "0" && next <= "7") {
      const octal = spelled.slice(i + 1, i + 4);
      if (!/^[0-7]{3}$/.test(octal)) return undefined;
      bytes.push(parseInt(octal, 8));
      i += 3;
      continue;
    }
    const mapped = C_ESCAPES[next];
    if (mapped === undefined) return undefined;
    for (const b of Buffer.from(mapped, "utf8")) bytes.push(b);
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

// FG-689 step 7: a fake for `CoordinatorDeps.reviewDiff`, shared by the stage-sequencing tests.
//
// WHY A TESTKIT AND NOT A LOCAL HELPER PER FILE. `reviewDiff` replaced the coordinator's two
// old git seams (`changedPaths` and `diff`), and the harnesses in review-run.test.ts,
// fg640-shipping-review-path.test.ts, fg653-seed-discovery-context.test.ts and
// fg664-reviewer-dependency-environment.test.ts each stubbed both of them. Four hand-written
// copies of "what a rendering looks like" is four places for a fixture to drift out of the
// shape `review-diff.ts` actually produces — and the shape is load-bearing now that the
// confirmation derives its recorded path set from it.
//
// The bodies here are SYNTHETIC but structurally real: every one is a `diff --git` header
// followed by a hunk, so `paths` and the per-file `chars` line up the way the pinned renderer's
// do. Tests that need the REAL renderer (byte-identical output, path recovery, the refusal
// arms) use `renderReviewDiff` against a real repo — see fg689-pinned-rendering*.test.ts. This
// is for the tests whose subject is the stage sequencing, not the rendering.

import {
  REVIEW_DIFF_RENDERING_ID,
  REVIEW_DIFF_SIZE_UNIT,
  type ReviewDiffFile,
  type ReviewDiffRefusalReason,
  type ReviewDiffResult,
} from "./review-diff.js";

function fileOf(path: string, hunk?: string): ReviewDiffFile {
  const body =
    `diff --git a/${path} b/${path}\n` +
    `index 1111111..2222222 100644\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@ -1,1 +1,1 @@\n` +
    `-before\n` +
    `+${hunk ?? "after"}\n`;
  return { path, body, chars: Buffer.byteLength(body, "utf8"), utf16Chars: body.length };
}

/** A successful rendering over `paths`, in the shape `renderReviewDiff` returns. */
export function fakeRendering(baseSha: string, candidateSha: string, paths: readonly string[]): ReviewDiffResult {
  const files = paths.map((p) => fileOf(p));
  return {
    ok: true,
    rendering: {
      renderingId: REVIEW_DIFF_RENDERING_ID,
      unit: REVIEW_DIFF_SIZE_UNIT,
      baseSha,
      candidateSha,
      files,
      paths: files.map((f) => f.path),
      totalChars: files.reduce((n, f) => n + f.chars, 0),
      totalUtf16Chars: files.reduce((n, f) => n + f.utf16Chars, 0),
    },
  };
}

/** A `reviewDiff` seam that renders the same path set for every range. */
export function fakeReviewDiff(paths: readonly string[]): (base: string, candidate: string) => ReviewDiffResult {
  return (base, candidate) => fakeRendering(base, candidate, paths);
}

/** A `reviewDiff` seam that REFUSES. Named so a test says which refusal it is exercising. */
export function refusingReviewDiff(
  reason: ReviewDiffRefusalReason,
  refusal = "the fixture's rendering seam refused.",
): (base: string, candidate: string) => ReviewDiffResult {
  return () => ({ ok: false, reason, refusal });
}

// FG-682 (step 2) — the documentation-path classifier is the AC2 authority the bounded
// late-docs amendment consults to REFUSE a non-documentation path by name. This suite pins its
// two obligations:
//
//   1. Accept only paths it can positively vouch for as prose (docs/**, README-style *.md,
//      *.rst/.mdx/.txt), and
//   2. Refuse — by name, default-deny — source, tests, config, lockfiles, the FG-732
//      orchestrator-policy surface, and every ambiguous/hostile shape (absolute paths, `..`
//      traversal, dotfiles, extensionless files).
//
// It is a PURE function: these tests touch no git and no store, which is itself part of the
// contract (the classifier must never move a candidate or read the tree).
//
// Security framing: the classifier is an authority whose FALSE-ACCEPTS are the danger — a
// mis-accepted `.ts`/config path is code smuggled into the candidate behind a docs-only label.
// The refusal assertions below are therefore the load-bearing ones; each is a would-be bypass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAmendmentPath } from "./review-wiring.js";

const accepts = (p: string) =>
  assert.equal(classifyAmendmentPath(p), "documentation", `expected documentation: ${p}`);
const refuses = (p: string) =>
  assert.equal(classifyAmendmentPath(p), "not-documentation", `expected refusal: ${p}`);

test("accepts docs/** prose", () => {
  accepts("docs/SCHEMA-CONTRACT.md");
  accepts("docs/guide/setup.md");
  accepts("docs/api.rst");
  accepts("docs/concepts.mdx");
  accepts("docs/notes.markdown");
});

test("accepts README-style prose anywhere in the tree", () => {
  accepts("README.md");
  accepts("CHANGELOG.md");
  accepts("src/store/README.md");
  accepts("NOTICE.txt");
});

test("accepts non-orchestrator seed prose (mirrors the FG-732 :1358 carve-out, which permits other seeds)", () => {
  accepts("seeds/skills/foo.md");
  accepts("seeds/agents/reviewer.md");
});

test("refuses source by name (.ts/.js/.py) — code is never amendable documentation", () => {
  refuses("src/v2/review-run.ts");
  refuses("src/cli/commands/review.ts");
  refuses("scripts/build.js");
  refuses("tools/gen.py");
  // code that happens to live under docs/ is still code — the accept is by extension, not dir
  refuses("docs/build.sh");
});

test("refuses *.test.ts and friends by name", () => {
  refuses("src/cli/commands/review-wiring.test.ts");
  refuses("src/v2/fg682-late-docs-amendment.integration.test.ts");
  refuses("src/foo.spec.ts");
  // a prose-extension test file is still a test, not documentation
  refuses("docs/example.test.md");
});

test("refuses config and lockfiles by name — including config wearing a prose extension", () => {
  refuses("package.json");
  refuses("package-lock.json");
  refuses("tsconfig.json");
  refuses("yarn.lock");
  refuses("pnpm-lock.yaml");
  refuses(".forge/docs-surfaces.yml");
  refuses("Cargo.toml");
  // .txt dependency manifests are config, not prose — the named-basename carve-out
  refuses("requirements.txt");
  refuses("requirements-dev.txt");
  refuses("CMakeLists.txt");
});

test("refuses the FG-732 orchestrator-policy surface even though both files are markdown", () => {
  refuses("CLAUDE.md");
  refuses("seeds/orchestrator-template.md");
});

test("fails closed on ambiguous or hostile shapes (default-deny)", () => {
  refuses(""); // empty
  refuses("   "); // whitespace
  refuses("/etc/passwd"); // absolute
  refuses("/docs/x.md"); // absolute even under a docs-looking prefix
  refuses("../secrets/x.md"); // parent traversal
  refuses("docs/../../etc/x.md"); // embedded traversal
  refuses(".gitignore"); // dotfile — dot at index 0, no extension
  refuses("Makefile"); // extensionless
  refuses("README"); // extensionless prose name
  refuses("docs/logo.png"); // binary asset under docs/ is not prose
  refuses("config.yaml"); // non-prose extension
});

test("normalizes a leading ./ and backslashes before classifying", () => {
  accepts("./docs/setup.md");
  accepts("docs\\guide\\setup.md");
  refuses("./src/app.ts");
});

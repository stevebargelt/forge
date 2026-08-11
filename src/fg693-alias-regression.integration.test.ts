// FG-693 step 13 — THE CROSS-CUTTING SUITE: ONE TREE, MANY NAMES, ONE ANSWER
// EVERYWHERE; DISTINCT TREES STAY DISTINCT; AND THE PROOF THAT THE CONTRACT IS
// LOAD-BEARING RATHER THAN DECORATIVE.
//
// The twelve steps before this one each migrated a boundary and each proved its
// own boundary. What none of them can prove alone is the property the ticket is
// actually about: that the boundaries AGREE. A run created under one spelling,
// looked up under another, gated under a third and cleaned up under a fourth is
// one object or it is not, and "each consumer's own test passes" is exactly the
// evidence FG-575, FG-576 and FG-253 each had before the defect came back.
//
// Three sections, and they are three different claims.
//
//   A  THE ALIAS SWEEP (AC9, and AC5's "decide identically"). ONE fixture
//      checkout, spelled six ways, driven through every consumer seam this
//      process can reach, asserting the seams do not merely each work but
//      RETURN THE SAME ANSWER AS EACH OTHER. Every alias here is one this file
//      CREATES — a symlinked parent, a direct symlink, a trailing separator, a
//      relative spelling, a `..` segment. Nothing depends on an alias a
//      particular operating system happens to provide, which is precisely why
//      the earlier coverage was CI-green and host-red. On a host whose temp root
//      is itself reached through a link (darwin's /var -> /private/var) the
//      `as-created` spelling is a NATIVE alias too, executed rather than
//      described — and CI now synthesises that condition on Linux by pointing
//      TMPDIR at a symlink (the `fg693_alias_identity` job in
//      .github/workflows/ci.yml). No platform branch appears anywhere below.
//
//   B  THE NEGATIVE CONTROL (AC7). Distinct physical directories stay distinct
//      at every one of those seams — when their lexical paths share a prefix,
//      AND when they are two checkouts of ONE git repository. Path identity is
//      not repository identity, and a contract that collapsed aliases by
//      collapsing everything would pass section A and be worse than the defect.
//
//   C  THE FALSIFICATION (AC8). A mutation harness that replaces the canonical
//      identity comparison with RAW STRING EQUALITY at each migrated consumer,
//      one consumer at a time, against the REAL production source, and asserts
//      the regression suite goes RED for that consumer — having first asserted
//      it goes GREEN unmutated in the same tree, so "red" means the mutation and
//      not a broken scratch copy. The mutation targets CONSUMER SEAMS: every
//      regression file it runs drives a consumer's own production entry points,
//      so a mutation that only broke the primitive's unit tests would not
//      satisfy this and does not appear here.
//
// Section C is what makes sections A and B worth having. An assertion that
// cannot fail proves nothing, and the way an identity assertion silently stops
// being able to fail is that somebody restores a string comparison somewhere and
// the test still passes because it never used two spellings in the first place.

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { applyMigrations, getDb, setDbForTest } from "./store/db.js";
import { SCHEMA_SQL } from "./store/schema.js";
import { FORGE_HOME } from "./util/paths.js";
import { insertRun, listRunsForWorkspace, uniqueProjectDirs } from "./store/runs.js";
import { insertHostVerification, queryHostVerificationRows } from "./store/host-verifications.js";
import {
  listOrchestratorReceiptsAuthorizedForProject,
  listOrchestratorReceiptsForProject,
  persistPendingOrchestratorReceipt,
  type OrchestratorLaunchDecision,
} from "./store/orchestrator-receipts.js";
import { classifySelfHostDispatch } from "./v2/self-host-guard.js";
import { resolveAdapterStampForAssetRoot } from "./v2/adapter-stamp.js";
import { projectIdentity, requireProvenProjectDir } from "./v2/project-identity.js";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

// ─── fixtures ────────────────────────────────────────────────────────────────
//
//   box/
//     trees/
//       alpha/          THE checkout every section-A assertion is about
//       alpha-sibling/  a DISTINCT tree whose lexical path shares alpha's prefix
//       alpha-twin/     a DISTINCT tree that is a second checkout of alpha's repo
//     links/
//       parent -> trees        so links/parent/alpha aliases alpha
//       alpha  -> trees/alpha  a direct symlink to the checkout itself

let box: string;
let alpha: string;
let sibling: string;
let twin: string;
let alphaAsCreated: string;
let db: DatabaseInstance;
let previousDb: DatabaseInstance | null = null;
let dbPath: string;

/** Every spelling of ONE checkout that must decide identically everywhere.
 *
 *  `as-created` is not redundant with `canonical`: on a host whose temp root is
 *  reached through a link — darwin natively, Linux CI under the synthetic TMPDIR
 *  symlink — they are DIFFERENT strings naming one tree, and that is the native
 *  alias case rather than a constructed one. */
let SPELLINGS: ReadonlyArray<readonly [label: string, spelling: string]>;

before(() => {
  // realpath'd immediately so `alpha` below is the PROVEN identity and every
  // constructed alias is a genuinely different string from it.
  box = realpathSync(mkdtempSync(join(tmpdir(), "fg693-alias-regression-")));
  const trees = join(box, "trees");
  const links = join(box, "links");
  mkdirSync(trees);
  mkdirSync(links);
  for (const name of ["alpha", "alpha-sibling", "alpha-twin"]) mkdirSync(join(trees, name));
  symlinkSync(trees, join(links, "parent"));
  symlinkSync(join(trees, "alpha"), join(links, "alpha"));

  alphaAsCreated = join(trees, "alpha");
  alpha = realpathSync(alphaAsCreated);
  sibling = realpathSync(join(trees, "alpha-sibling"));
  twin = realpathSync(join(trees, "alpha-twin"));

  SPELLINGS = [
    ["canonical", alpha],
    ["as-created (a native alias wherever the temp root is itself a link)", alphaAsCreated],
    ["symlinked parent", join(links, "parent", "alpha")],
    ["direct symlink to the checkout", join(links, "alpha")],
    ["trailing separator", `${alpha}${sep}`],
    ["relative", relative(process.cwd(), alpha)],
    ["`..` segment", join(alpha, "..", "alpha")],
  ];

  dbPath = join(FORGE_HOME, "fg693-alias-regression.db");
});

after(() => {
  if (previousDb) setDbForTest(previousDb);
  try {
    db.close();
  } catch {
    // a test may already have closed it
  }
  rmSync(box, { recursive: true, force: true });
  rmSync(dbPath, { force: true });
});

beforeEach(() => {
  rmSync(dbPath, { force: true });
  db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  previousDb = setDbForTest(db) ?? previousDb ?? null;
});

// ─── the consumer seams, driven ──────────────────────────────────────────────
//
// Each of these calls a CONSUMER's own production entry points — never
// src/util/path-identity.ts. AC5 is explicit that calling the identity helper
// directly satisfies nothing, and it is right: the helper agreeing with itself
// is what every one of the three previous repairs already had.
//
// Each returns a value that is EQUAL for two spellings of one tree and UNEQUAL
// for two different trees, so section A and section B are the same table read in
// two directions.

let seq = 0;
const uniq = (p: string): string => `${p}-${++seq}`;

/** RUN CREATION AND LOOKUP (src/store/runs.ts) — a run written under `written`
 *  and asked for under `asked`: is it found? */
function runLookupFinds(written: string, asked: string): boolean {
  const id = uniq("run");
  insertRun({
    id,
    workflow: "build",
    title: "alias regression",
    status: "active",
    createdAt: new Date(1700000000000 + seq).toISOString(),
    projectDir: written,
  });
  return listRunsForWorkspace(asked).some((r) => r.id === id);
}

/** PROJECT-SCOPED STATUS (src/store/runs.ts) — how many PROJECTS do these
 *  spellings amount to? */
function projectsSeenFor(spellings: readonly string[]): number {
  spellings.forEach((dir, i) =>
    insertRun({
      id: uniq(`agg-${i}`),
      workflow: "build",
      title: "alias regression aggregate",
      status: "active",
      createdAt: new Date(1700000000000 + seq).toISOString(),
      projectDir: dir,
    }),
  );
  return uniqueProjectDirs().length;
}

/** GATE EVIDENCE (src/store/host-verifications.ts) — does a gate recorded under
 *  `written` count as covering evidence for `asked`? */
function gateEvidenceCovers(written: string, asked: string): boolean {
  const ticketId = uniq("FG-693-T");
  insertHostVerification({
    ticketId,
    projectDir: written,
    commitSha: "0f1e8ecafe",
    gateName: "npm-test",
    command: "npm test",
    exitCode: 0,
    recordedAt: new Date(1700000000000 + seq).toISOString(),
  });
  return queryHostVerificationRows(ticketId, asked, "0f1e8ecafe", "npm-test").length > 0;
}

function launchDecision(projectDir: string, sessionKey: string): OrchestratorLaunchDecision {
  return {
    sessionKey,
    projectDir,
    runtime: "node",
    provider: "anthropic",
    adapter: "claude",
    sessionOperation: "new",
  };
}

/** RECEIPT AUTHORITY (src/store/orchestrator-receipts.ts) — may `asked` act on a
 *  receipt persisted under `written`? (The ACTING half of the display/authority
 *  split; the LISTING half is asserted separately below.) */
function receiptAuthorizes(written: string, asked: string): boolean {
  const key = uniq("session");
  const receipt = persistPendingOrchestratorReceipt(launchDecision(written, key));
  return listOrchestratorReceiptsAuthorizedForProject(asked).some((r) => r.receiptId === receipt.receiptId);
}

/** SELF-HOST / READINESS AUTHORITY (src/v2/self-host-guard.ts) — the classifier
 *  both `forge dispatch` and the host-readiness refusal read. */
function selfHostRelation(project: string, sourceRoot: string): string {
  const relation = classifySelfHostDispatch(project, sourceRoot);
  return relation.kind === "overlap" ? `overlap:${relation.direction}` : relation.kind;
}

/** DOCTOR / SEED DRIFT (src/v2/adapter-stamp.ts) — the comparison FG-253 tripped
 *  over when its new doctor coverage read two spellings of one tree as two
 *  trees. */
function adapterStampBasis(root: string, runningRoot: string): string {
  return resolveAdapterStampForAssetRoot(root, runningRoot).basis;
}

/** PUBLICATION COORDINATION (src/v2/project-identity.ts) — the lane key and the
 *  mutex key are this hash; two spellings of one checkout must not take two
 *  lanes against one moving target. */
function laneKey(projectDir: string): string {
  return projectIdentity(projectDir).key;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION A — THE ALIAS SWEEP
// ═════════════════════════════════════════════════════════════════════════════

describe("FG-693 AC9/AC5 — one checkout, many spellings, one answer at every seam", () => {
  test("RUN LOOKUP: a run created under any spelling is found under every other one", () => {
    for (const [writtenLabel, written] of SPELLINGS) {
      for (const [askedLabel, asked] of SPELLINGS) {
        assert.equal(
          runLookupFinds(written, asked),
          true,
          `a run written under the ${writtenLabel} spelling was not found under the ${askedLabel} spelling`,
        );
      }
    }
  });

  test("PROJECT-SCOPED STATUS: runs recorded under every spelling aggregate to ONE project", () => {
    assert.equal(
      projectsSeenFor(SPELLINGS.map(([, spelling]) => spelling)),
      1,
      "the registry counted one checkout as several projects — the defect this aggregate had before FG-693",
    );
  });

  test("GATE EVIDENCE: a gate recorded under any spelling covers every other one", () => {
    for (const [writtenLabel, written] of SPELLINGS) {
      for (const [askedLabel, asked] of SPELLINGS) {
        assert.equal(
          gateEvidenceCovers(written, asked),
          true,
          `gate evidence recorded under the ${writtenLabel} spelling did not cover the ${askedLabel} spelling`,
        );
      }
    }
  });

  test("RECEIPT AUTHORITY: a receipt persisted under any spelling authorizes every other one", () => {
    for (const [writtenLabel, written] of SPELLINGS) {
      for (const [askedLabel, asked] of SPELLINGS) {
        assert.equal(
          receiptAuthorizes(written, asked),
          true,
          `a receipt persisted under the ${writtenLabel} spelling did not authorize the ${askedLabel} spelling`,
        );
      }
    }
  });

  test("SELF-HOST / READINESS: every spelling of the source root is recognised as the same tree", () => {
    for (const [projectLabel, project] of SPELLINGS) {
      for (const [rootLabel, root] of SPELLINGS) {
        assert.equal(
          selfHostRelation(project, root),
          "overlap:same-tree",
          `the guard did not recognise the ${projectLabel} spelling as the source root spelled ${rootLabel} — ` +
            "a guard that does not fire is an agent writing into the tree this forge is executing from",
        );
      }
    }
  });

  test("DOCTOR DRIFT: every spelling of the running tree reports the running tree — the FG-253 shape", () => {
    for (const [rootLabel, root] of SPELLINGS) {
      for (const [runningLabel, running] of SPELLINGS) {
        assert.equal(
          adapterStampBasis(root, running),
          "running-tree",
          `doctor read the ${rootLabel} spelling as foreign to the ${runningLabel} spelling of the same tree — ` +
            "this is the exact comparison FG-253 reproduced the defect with",
        );
      }
    }
  });

  test("PUBLICATION: every spelling collapses to ONE lane key and ONE mutex key", () => {
    const keys = new Set(SPELLINGS.map(([, spelling]) => laneKey(spelling)));
    assert.equal(
      keys.size,
      1,
      `${keys.size} lane keys for one checkout — two attempts on one checkout would each take a lane of their own ` +
        "and publish against the other's moving target",
    );
    for (const [label, spelling] of SPELLINGS) {
      assert.equal(
        requireProvenProjectDir(spelling, "publish"),
        alpha,
        `the ${label} spelling was admitted to the publication path under something other than its physical path`,
      );
    }
  });

  test("THE SEAMS AGREE WITH EACH OTHER — the property no single step's test can hold", () => {
    // Each seam reduces a spelling to the answer it decides on. If the seams
    // disagree, one boundary believes in a tree the next one does not, which is
    // the whole failure mode: a run created through one spelling and gated,
    // scoped or cleaned up through another.
    const perSeam = SPELLINGS.map(([label, spelling]) => ({
      label,
      lane: laneKey(spelling),
      publication: requireProvenProjectDir(spelling, "publish"),
      guard: selfHostRelation(spelling, alpha),
      doctor: adapterStampBasis(spelling, alpha),
      runLookup: runLookupFinds(spelling, alpha),
      gate: gateEvidenceCovers(spelling, alpha),
      receipt: receiptAuthorizes(spelling, alpha),
    }));
    const canonical = perSeam[0];
    for (const row of perSeam.slice(1)) {
      assert.deepEqual(
        { ...row, label: canonical!.label },
        canonical,
        `the seams disagree about the ${row.label} spelling of one checkout`,
      );
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION B — THE NEGATIVE CONTROL (AC7)
// ═════════════════════════════════════════════════════════════════════════════

describe("FG-693 AC7 — distinct physical directories stay distinct", () => {
  // `sibling` shares alpha's lexical prefix (…/trees/alpha vs …/trees/alpha-sibling)
  // and `twin` is a second checkout of ONE repository — the ticket's non-goal,
  // stated as a test rather than as prose. Neither may ever be collapsed into
  // alpha, and a contract that passed section A by collapsing everything fails
  // every assertion here.
  const OTHERS = () =>
    [
      ["a sibling whose lexical path shares alpha's prefix", sibling],
      ["a second checkout of the SAME repository", twin],
    ] as const;

  test("RUN LOOKUP does not return another tree's runs", () => {
    for (const [label, other] of OTHERS()) {
      assert.equal(runLookupFinds(alpha, other), false, `${label} was served alpha's runs`);
      assert.equal(runLookupFinds(other, alpha), false, `alpha was served ${label}'s runs`);
    }
  });

  test("PROJECT-SCOPED STATUS keeps three distinct trees as three projects, aliases and all", () => {
    assert.equal(
      projectsSeenFor([...SPELLINGS.map(([, s]) => s), sibling, twin]),
      3,
      "aliases of one checkout must collapse and distinct checkouts must not — a shared prefix or a shared " +
        "git remote is not identity",
    );
  });

  test("GATE EVIDENCE from another tree is never credited", () => {
    for (const [label, other] of OTHERS()) {
      assert.equal(gateEvidenceCovers(alpha, other), false, `${label} was credited alpha's gate evidence`);
      assert.equal(gateEvidenceCovers(other, alpha), false, `alpha was credited ${label}'s gate evidence`);
    }
  });

  test("RECEIPT AUTHORITY stops at the tree that owns the receipt", () => {
    for (const [label, other] of OTHERS()) {
      assert.equal(receiptAuthorizes(alpha, other), false, `${label} was authorized to act on alpha's receipt`);
      assert.equal(receiptAuthorizes(other, alpha), false, `alpha was authorized to act on ${label}'s receipt`);
    }
  });

  test("SELF-HOST does not fire for a proven-separate tree — an over-firing guard blocks every dispatch on a host", () => {
    for (const [label, other] of OTHERS()) {
      assert.equal(
        selfHostRelation(other, alpha),
        "distinct",
        `the guard called ${label} an overlap with alpha; a guard that fires on everything is not a guard`,
      );
    }
  });

  test("DOCTOR DRIFT still reports a foreign tree as foreign", () => {
    for (const [label, other] of OTHERS()) {
      assert.equal(adapterStampBasis(other, alpha), "foreign-tree", `${label} was read as the running tree`);
    }
  });

  test("PUBLICATION gives distinct trees distinct lanes", () => {
    const keys = [alpha, sibling, twin].map(laneKey);
    assert.equal(new Set(keys).size, 3, "two distinct checkouts sharing a repository must not share a lane");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION C — THE FALSIFICATION (AC8)
// ═════════════════════════════════════════════════════════════════════════════
//
// THE MUTATION, stated once because it is the same one everywhere. Every
// migrated consumer reaches filesystem identity through exactly one import of
// src/util/path-identity.ts. Replacing that import with a shim whose "identity"
// is the caller's own bytes — resolve nothing, compare `asWritten` — restores
// precisely the pre-FG-693 behaviour at that ONE consumer while leaving its own
// logic, and every other consumer, untouched. Applying it uniformly is what
// makes the harness reviewable: there is one rule, and the per-seam table below
// only says WHERE it is applied and WHICH regression run must then fail.
//
// It runs against the REAL production source in a scratch copy of the tree, so a
// mutation cannot drift away from the code that ships (a hand-written "what if
// it compared strings" stub proves nothing about the file it is imitating). The
// copy is why the mutation is safe to make at all: mutating in place would
// corrupt the working tree and would race every other test file in this tier.
//
// The regression runs are CONSUMER-SEAM runs. Every file listed drives its
// consumer's own production entry points, and none of them is the primitive's
// unit test — a mutation that only broke src/util/path-identity.test.ts would
// not satisfy AC8, so no such target appears.

/** The one import statement each migrated consumer reaches the contract through.
 *  Anchored to whole lines and brace-balanced, so it matches the single- and
 *  multi-line forms and cannot swallow a neighbouring import. */
const CONTRACT_IMPORT =
  /^import\s+(?:type\s+)?(?:\{[^}]*\}|\w+)\s+from\s+["'](?<spec>[^"']*path-identity\.js)["'];$/m;

/** The shim. Every export of the contract, reimplemented as byte equality on the
 *  caller's own spelling: nothing resolves, nothing is ever UNRESOLVED, and two
 *  strings name one tree exactly when they ARE one string. Deliberately supplies
 *  the whole surface rather than only what a given consumer imports, so one text
 *  serves every seam; the types are re-imported (and erased) so the consumer's
 *  own annotations still parse. */
function rawStringEqualityShim(spec: string): string {
  return [
    `import type { PathIdentity, PathIdentityInput, IdentityComparison, ResolvedPathIdentity, UnresolvedPathIdentity } from "${spec}";`,
    `/* FG-693 AC8 MUTANT: canonical identity replaced by raw string equality */`,
    `const __mutSpelling = (x: any): string => (typeof x === "string" ? x : x.asWritten);`,
    `const identify = (p: string): any => ({ kind: "resolved", physical: p, asWritten: p });`,
    `const asIdentity = (x: any): any => (typeof x === "string" ? identify(x) : x);`,
    `const compareIdentity = (a: any, b: any): any => (__mutSpelling(a) === __mutSpelling(b) ? "same" : "different");`,
    `const matchesOrIndeterminate = (a: any, b: any): boolean => compareIdentity(a, b) !== "different";`,
    `const provenSameOnly = (a: any, b: any): boolean => compareIdentity(a, b) === "same";`,
    `const provenPhysical = (x: any): string | null => __mutSpelling(x);`,
    `const describeIdentity = (x: any): string => __mutSpelling(x);`,
    `const lexicalResolutionOf = (x: any): string => __mutSpelling(x);`,
    `void [identify, asIdentity, compareIdentity, matchesOrIndeterminate, provenSameOnly, provenPhysical, describeIdentity, lexicalResolutionOf];`,
  ].join("\n");
}

/** The seam table. Machine-readable on purpose: the unit-tier sibling
 *  (src/fg693-identity-falsification.test.ts) parses this literal out of this
 *  file's SOURCE and re-checks it on every fast-tier run, so the catalogue has
 *  ONE definition and cannot drift from the consumers it names — while an import
 *  of this integration file from the unit tier, which would drag this whole
 *  suite into the fast gate, is avoided. Do not reformat the delimiters. */
export type IdentitySeam = {
  /** The consumer boundary, in AC8's own vocabulary. */
  seam: string;
  /** Production file whose contract import is replaced. */
  mutate: string;
  /** The regression run that must go RED. `pattern` narrows to one seam's tests
   *  where a single file covers two boundaries. */
  regression: string;
  pattern?: string;
};

// FG693-SEAM-CATALOGUE-BEGIN
const SEAMS: IdentitySeam[] = JSON.parse(`[
  { "seam": "run lookup and project-scoped status",
    "mutate": "src/store/runs.ts",
    "regression": "src/store/runs.test.ts" },

  { "seam": "gate-evidence attribution",
    "mutate": "src/store/host-verifications.ts",
    "regression": "src/store/fg693-legacy-attribution.integration.test.ts" },

  { "seam": "the retarget-proof decline (step 4's legacy rule)",
    "mutate": "src/store/legacy-path-attribution.ts",
    "regression": "src/store/fg693-legacy-attribution.integration.test.ts" },

  { "seam": "orchestrator-receipt authority",
    "mutate": "src/store/orchestrator-receipts.ts",
    "regression": "src/store/fg693-receipt-identity.integration.test.ts" },

  { "seam": "self-host dispatch guard",
    "mutate": "src/v2/self-host-guard.ts",
    "regression": "src/v2/fg693-self-host-identity.integration.test.ts",
    "pattern": "^FG-693 DISPATCH" },

  { "seam": "host-readiness refusal",
    "mutate": "src/v2/self-host-guard.ts",
    "regression": "src/v2/fg693-self-host-identity.integration.test.ts",
    "pattern": "^FG-693 READINESS" },

  { "seam": "doctor / adapter-stamp drift",
    "mutate": "src/v2/adapter-stamp.ts",
    "regression": "src/cli/commands/doctor.test.ts" },

  { "seam": "doctor's own project identity",
    "mutate": "src/cli/commands/doctor.ts",
    "regression": "src/cli/commands/doctor.test.ts" },

  { "seam": "publication lane and mutex keying",
    "mutate": "src/v2/project-identity.ts",
    "regression": "src/v2/fg693-publication-identity.integration.test.ts" },

  { "seam": "dispatch target and argv",
    "mutate": "src/queue/dispatch-execution.ts",
    "regression": "src/queue/fg591-dispatch.integration.test.ts",
    "pattern": "aliased spelling|recorded SPELLINGS|genuinely distinct checkouts|no longer resolves" },

  { "seam": "dashboard scope filtering",
    "mutate": "dashboard/src/queries.ts",
    "regression": "dashboard/src/fg693-scope-identity.integration.test.ts" },

  { "seam": "recovery evidence classification",
    "mutate": "src/cli/commands/recover.ts",
    "regression": "src/cli/commands/fg693-recovery-identity.integration.test.ts" },

  { "seam": "terminal-run cleanup (worktree removal)",
    "mutate": "src/v2/worktree-lifecycle.ts",
    "regression": "src/cli/commands/fg693-recovery-identity.integration.test.ts" },

  { "seam": "this suite's own cross-cutting alias sweep",
    "mutate": "src/store/runs.ts",
    "regression": "src/fg693-alias-regression.integration.test.ts",
    "pattern": "^RUN LOOKUP" }
]`);
// FG693-SEAM-CATALOGUE-END

/** A scratch copy of the tree: `src` and `dashboard` are REAL copies (they are
 *  what gets mutated), everything else is a symlink to the original, and
 *  `node_modules` is shared. ~200ms and a few tens of MB, once for the file. */
function buildScratchTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg693-falsification-"));
  const copied = new Set(["src", "dashboard", "package.json", "tsconfig.json"]);
  for (const entry of readdirSync(REPO_ROOT)) {
    if (copied.has(entry) || entry === "node_modules" || entry === ".git") continue;
    symlinkSync(join(REPO_ROOT, entry), join(dir, entry));
  }
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  for (const entry of copied) {
    cpSync(join(REPO_ROOT, entry), join(dir, entry), { recursive: true });
  }
  return dir;
}

type RunResult = { green: boolean; pass: number | null; fail: number | null; output: string };

/** Run one regression file in the scratch tree. The dashboard workspace resolves
 *  its `@forge/*` path aliases out of dashboard/tsconfig.json, which tsx finds
 *  from the CWD — so it runs from `dashboard/`, exactly as `npm test -w
 *  dashboard` does. */
function runRegression(scratch: string, seam: IdentitySeam): RunResult {
  const inDashboard = seam.regression.startsWith("dashboard/");
  const args = ["--import", "tsx"];
  if (!inDashboard) args.push("--import", "./src/test-setup.ts");
  if (seam.pattern) args.push("--test-name-pattern", seam.pattern);
  args.push("--test", inDashboard ? seam.regression.slice("dashboard/".length) : seam.regression);

  // NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID are set by the node:test runner in
  // the environment of THIS file's process. Inherited by a nested `node --test`
  // they make the grandchild believe it is already a reporting child of a runner
  // that is not listening, and it exits 0 in ~100ms having run nothing. That
  // failure mode is silent and it points the wrong way: every mutation looks
  // like it "still passed", i.e. like the production code is not identity-based.
  // Stripped here, and the control run below is what would catch it again.
  const env: NodeJS.ProcessEnv = { ...process.env, FG693_FALSIFICATION_RUN: "1" };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;

  const result = spawnSync("node", args, {
    cwd: inDashboard ? join(scratch, "dashboard") : scratch,
    encoding: "utf8",
    timeout: 180_000,
    env,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const num = (re: RegExp): number | null => {
    const m = re.exec(output);
    return m ? Number(m[1]) : null;
  };
  return { green: result.status === 0, pass: num(/^. pass (\d+)$/m), fail: num(/^. fail (\d+)$/m), output };
}

describe("FG-693 AC8 — raw string equality at any migrated consumer FAILS the regression suite", () => {
  let scratch: string;

  before(() => {
    scratch = buildScratchTree();
  });

  after(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  for (const seam of SEAMS) {
    const label = seam.pattern ? `${seam.regression} [${seam.pattern}]` : seam.regression;
    test(`MUTATION at ${seam.seam} (${seam.mutate}) turns ${label} RED`, () => {
      const target = join(scratch, seam.mutate);
      const original = readFileSync(target, "utf8");

      const match = CONTRACT_IMPORT.exec(original);
      assert.ok(
        match,
        `${seam.mutate} no longer imports src/util/path-identity.ts in a form this harness can replace. That is ` +
          "either a consumer that stopped using the one contract — AC1 — or a refactor that silently disarmed " +
          "this falsification. Both need a human; neither may pass quietly.",
      );
      const mutated = original.replace(CONTRACT_IMPORT, rawStringEqualityShim(match.groups!.spec!));
      assert.notEqual(mutated, original, "the mutation changed nothing, so it proves nothing");

      // THE CONTROL, first and in the same tree. Without it, "the suite went red"
      // is equally consistent with a scratch copy that never worked — which is
      // exactly how this harness would rot into a test that always passes.
      const control = runRegression(scratch, seam);
      assert.ok(
        control.green,
        `unmutated control run of ${label} was not green in the scratch tree (pass=${control.pass} ` +
          `fail=${control.fail}), so a red mutant run would prove nothing:\n${control.output.slice(-2000)}`,
      );

      try {
        writeFileSync(target, mutated);
        const mutant = runRegression(scratch, seam);
        assert.equal(
          mutant.green,
          false,
          `${label} still passed with ${seam.mutate} deciding path identity by raw string equality. Its ` +
            "assertions are not load-bearing: either they never compare two spellings of one tree, or the " +
            "consumer no longer decides anything from the comparison.",
        );
        assert.ok(
          (mutant.fail ?? 0) > 0,
          `${label} exited non-zero under the mutation but reported no failing test (pass=${mutant.pass} ` +
            `fail=${mutant.fail}) — that is a crash, not a falsification, and it does not satisfy AC8:\n` +
            mutant.output.slice(-2000),
        );
      } finally {
        writeFileSync(target, original);
      }
    });
  }

  test("the catalogue covers every consumer seam AC8 names", () => {
    // AC8 lists the seams by name. Keeping that list here, checked against the
    // catalogue, is what stops a seam from being quietly dropped when a file is
    // renamed or a step's coverage moves.
    const required = [
      "run lookup",
      "gate-evidence attribution",
      "retarget-proof",
      "receipt authority",
      "self-host",
      "readiness",
      "doctor",
      "publication lane",
      "dispatch",
      "dashboard scope",
      "recovery",
      "cleanup",
    ];
    const catalogue = SEAMS.map((s) => s.seam).join(" | ");
    const missing = required.filter((name) => !catalogue.includes(name));
    assert.deepEqual(missing, [], `AC8 seams with no falsification entry: ${missing.join(", ")}`);
  });
});

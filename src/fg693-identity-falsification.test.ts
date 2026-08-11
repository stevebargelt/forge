// FG-693 step 13, FAST TIER — the falsification's own preconditions, and the
// portable half of the alias/negative-control sweep.
//
// The heavy falsification lives in src/fg693-alias-regression.integration.test.ts:
// it copies the tree, replaces one consumer's identity import with raw string
// equality, and proves that consumer's regression run goes RED. That is the AC8
// evidence, and it costs a scratch copy and fourteen nested test runs, so it
// belongs in the integration tier where a subprocess is allowed at all
// (src/test-tiers.test.ts forbids one here, for the FG-495 reasons).
//
// WHAT THIS FILE IS FOR. A mutation harness has one silent failure mode: it
// stops being able to find the thing it mutates. Rename a consumer, split an
// import, move a regression file, and the harness's catalogue names something
// that is not there — and if that only surfaces in a tier the fast gate does not
// run, the invariant is unguarded for however long it takes somebody to run the
// extended gate. So the catalogue's PRECONDITIONS are checked here, on every
// push, in the tier that always runs:
//
//   * every consumer the harness mutates still exists and still reaches the
//     contract through EXACTLY ONE import statement, in the form the harness
//     replaces (a consumer that stopped importing the contract is an AC1
//     regression; a consumer that imports it twice is a mutation the harness
//     would only half-apply);
//   * every regression run the harness names still exists, and none of them is
//     the primitive's own unit test — AC8 is explicit that a mutation which only
//     breaks src/util/path-identity.test.ts does not count;
//   * every seam AC8 lists by name has an entry;
//   * CI actually carries the synthetic symlink-alias regression (AC9), rather
//     than the workflow having drifted away from it.
//
// ONE CATALOGUE, NO IMPORT. The seam table is defined once, in the integration
// file, and read here out of that file's SOURCE between two delimiters. Importing
// the integration module instead would register its whole suite — scratch copy,
// fourteen nested runs — into the fast gate, which is the one thing this tier
// must not do. Parsing is cheap and the parse itself is asserted, so a
// well-meaning reformat of the catalogue fails loudly here rather than quietly
// disarming the check.
//
// PORTABLE BY CONSTRUCTION. Every alias below is one this file creates. No case
// depends on an alias an operating system happens to provide, and there is no
// platform branch — the native cases are executed on darwin, and on Linux CI by
// the `fg693_alias_identity` job pointing TMPDIR at a symlink.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { classifySelfHostDispatch } from "./v2/self-host-guard.js";
import { resolveAdapterStampForAssetRoot } from "./v2/adapter-stamp.js";
import { projectIdentity, requireProvenProjectDir } from "./v2/project-identity.js";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const HARNESS = "src/fg693-alias-regression.integration.test.ts";
const CONTRACT = "src/util/path-identity.ts";

// ── the catalogue, read out of the harness's source ──────────────────────────

type IdentitySeam = { seam: string; mutate: string; regression: string; pattern?: string };

function readSeamCatalogue(): IdentitySeam[] {
  const source = readFileSync(join(REPO_ROOT, HARNESS), "utf8");
  const block = /FG693-SEAM-CATALOGUE-BEGIN\n([\s\S]*?)\n\/\/ FG693-SEAM-CATALOGUE-END/.exec(source);
  assert.ok(
    block,
    `${HARNESS} no longer carries a delimited seam catalogue. It is the single definition of which consumer ` +
      "boundaries AC8 falsifies, and this file re-checks it on every fast-tier run; restore the delimiters " +
      "rather than deleting the check.",
  );
  const literal = /JSON\.parse\(`([\s\S]*?)`\)/.exec(block[1]!);
  assert.ok(literal, "the seam catalogue is no longer a JSON literal this file can read without importing the suite");
  return JSON.parse(literal[1]!) as IdentitySeam[];
}

/** The harness's own regex, restated. Restated rather than shared for the same
 *  reason the catalogue is not imported — and if the two ever diverge, the
 *  "exactly one import" assertion below is what goes red. */
const CONTRACT_IMPORT_GLOBAL =
  /^import\s+(?:type\s+)?(?:\{[^}]*\}|\w+)\s+from\s+["'][^"']*path-identity\.js["'];$/gm;

describe("FG-693 AC8 — the falsification harness can still reach what it falsifies", () => {
  const seams = readSeamCatalogue();

  test("the catalogue is non-empty and every entry is well-formed", () => {
    assert.ok(seams.length >= 12, `only ${seams.length} seams catalogued; AC8 names more than that`);
    for (const seam of seams) {
      assert.ok(seam.seam && seam.mutate && seam.regression, `malformed catalogue entry: ${JSON.stringify(seam)}`);
    }
  });

  test("every mutated consumer exists and reaches the contract through EXACTLY ONE import", () => {
    for (const mutate of new Set(seams.map((s) => s.mutate))) {
      const full = join(REPO_ROOT, mutate);
      assert.ok(existsSync(full), `${mutate} is catalogued for mutation but does not exist`);
      const imports = readFileSync(full, "utf8").match(CONTRACT_IMPORT_GLOBAL) ?? [];
      assert.equal(
        imports.length,
        1,
        `${mutate} has ${imports.length} import statements from ${CONTRACT} in the form the harness replaces. ` +
          "Zero means this consumer no longer uses the one contract (AC1) or has grown a private canonicalizer " +
          "again; two means the mutation would be applied to only one of them and the seam would look falsified " +
          "when it was not.",
      );
    }
  });

  test("every regression run exists, and none of them is the primitive's own unit test", () => {
    for (const seam of seams) {
      assert.ok(
        existsSync(join(REPO_ROOT, seam.regression)),
        `${seam.regression} is catalogued as the regression run for "${seam.seam}" but does not exist`,
      );
      assert.notEqual(
        seam.regression,
        "src/util/path-identity.test.ts",
        `"${seam.seam}" points at the primitive's own unit test. AC8 rules that out by name: a mutation that ` +
          "only breaks the contract's own tests proves nothing about whether any consumer reads it.",
      );
    }
  });

  test("every consumer seam AC8 names by hand has a catalogue entry", () => {
    // The same list the integration file checks. Duplicated deliberately: this is
    // the tier that always runs, and a seam silently dropped from the catalogue
    // must not wait for the extended gate to be noticed.
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
    const catalogue = seams.map((s) => s.seam).join(" | ");
    assert.deepEqual(
      required.filter((name) => !catalogue.includes(name)),
      [],
      `AC8 seams with no falsification entry. Catalogued: ${catalogue}`,
    );
  });
});

// ── AC9: CI carries the alias class, rather than describing it ──────────────

describe("FG-693 AC9 — Linux CI carries the synthetic symlink-alias regression", () => {
  const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");

  test("a dedicated alias-identity job exists and runs the FG-693 suite under a SYMLINKED temp root", () => {
    assert.match(
      workflow,
      /^ {2}fg693_alias_identity:$/m,
      "the FG-693 alias-identity job is gone from CI. Linux is where this ticket is green and darwin is where it " +
        "fails; without a job that synthesises the alias condition on Linux, CI carries none of it.",
    );
    // The MECHANISM matters, not just the job: pointing TMPDIR at a symlink is
    // what makes every fixture built under os.tmpdir() reachable by two names on
    // a filesystem that provides no such alias of its own. Enumerating alias
    // prefixes instead would be the thing AC1 forbids.
    assert.match(workflow, /TMPDIR=/, "the alias job no longer redirects TMPDIR, so nothing is aliased on Linux");
    assert.match(workflow, /ln -s/, "the alias job no longer creates the symlink its TMPDIR points at");
  });

  test("the alias job is a dependency of the fail-closed extended gate", () => {
    const needs = /^ {4}needs: \[([^\]]*)\]$/m.exec(workflow);
    assert.ok(needs, "the extended gate's `needs` list could not be read");
    assert.ok(
      needs[1]!.includes("fg693_alias_identity"),
      "the alias job runs but nothing requires it to pass. `test-extended` is the required check and it fails " +
        `closed on its dependencies; a job outside that list is advisory. Current needs: ${needs[1]}`,
    );
    // The aggregate reads each dependency's result explicitly, so a job added to
    // `needs` but not to the results string is still not gating.
    assert.match(
      workflow,
      /needs\.fg693_alias_identity\.result/,
      "the extended gate's aggregate does not read the alias job's result, so a failed alias job would still " +
        "produce a green required check",
    );
  });
});

// ── the portable sweep over the pure consumer seams ─────────────────────────
//
// The store-backed seams (runs, gate evidence, receipts, dashboard scope,
// recovery) need a database and live in the integration file. These three decide
// from paths alone, so the fast gate can carry them — and they are the three
// whose failure is worst: the self-host guard stands in front of an agent writing
// into the tree this forge executes from, the publication key stands in front of
// two attempts publishing against each other, and the adapter-stamp comparison is
// the exact one FG-253 reproduced the defect with.

const box = realpathSync(mkdtempSync(join(tmpdir(), "fg693-falsification-unit-")));
const trees = join(box, "trees");
mkdirSync(trees);
for (const name of ["alpha", "alpha-sibling"]) mkdirSync(join(trees, name));
symlinkSync(trees, join(box, "parent-link"));
symlinkSync(join(trees, "alpha"), join(box, "alpha-link"));

const alpha = realpathSync(join(trees, "alpha"));
const sibling = realpathSync(join(trees, "alpha-sibling"));

/** Spellings of ONE checkout. `as-created` is a genuinely different string from
 *  `canonical` wherever the temp root is itself reached through a link — darwin
 *  natively, Linux under the alias job's TMPDIR — so it is the native case,
 *  executed rather than described. */
const SPELLINGS: ReadonlyArray<readonly [string, string]> = [
  ["canonical", alpha],
  ["as-created", join(trees, "alpha")],
  ["symlinked parent", join(box, "parent-link", "alpha")],
  ["direct symlink", join(box, "alpha-link")],
  ["trailing separator", `${alpha}${sep}`],
  ["relative", relative(process.cwd(), alpha)],
  ["`..` segment", join(alpha, "..", "alpha")],
];

after(() => {
  rmSync(box, { recursive: true, force: true });
});

describe("FG-693 AC2/AC5 — the path-only consumer seams decide identically for every spelling", () => {
  test("SELF-HOST GUARD: every spelling of the source root is the source root", () => {
    for (const [label, spelling] of SPELLINGS) {
      const relation = classifySelfHostDispatch(spelling, alpha);
      assert.equal(
        relation.kind === "overlap" ? relation.direction : relation.kind,
        "same-tree",
        `the guard did not recognise the ${label} spelling as the source root — a guard that does not fire is ` +
          "an agent writing into the tree this forge is executing from",
      );
    }
  });

  test("PUBLICATION: every spelling collapses to ONE lane key and admits under the physical path", () => {
    const keys = new Set(SPELLINGS.map(([, spelling]) => projectIdentity(spelling).key));
    assert.equal(keys.size, 1, `${keys.size} lane keys for one checkout — two attempts would each take a lane`);
    for (const [label, spelling] of SPELLINGS) {
      assert.equal(requireProvenProjectDir(spelling, "publish"), alpha, `the ${label} spelling was not collapsed`);
    }
  });

  test("DOCTOR DRIFT: every spelling of the running tree reads as the running tree — the FG-253 shape", () => {
    for (const [label, spelling] of SPELLINGS) {
      assert.equal(
        resolveAdapterStampForAssetRoot(spelling, alpha).basis,
        "running-tree",
        `the ${label} spelling was read as foreign to the same tree — the comparison FG-253 tripped over`,
      );
    }
  });
});

describe("FG-693 AC7 — a shared lexical prefix is not identity", () => {
  test("SELF-HOST GUARD keeps a prefix-sharing sibling distinct", () => {
    assert.equal(
      classifySelfHostDispatch(sibling, alpha).kind,
      "distinct",
      "a guard that fires on a prefix-sharing sibling blocks every dispatch on the host",
    );
  });

  test("PUBLICATION gives a prefix-sharing sibling its own lane", () => {
    assert.notEqual(projectIdentity(sibling).key, projectIdentity(alpha).key);
  });

  test("DOCTOR DRIFT still calls a prefix-sharing sibling foreign", () => {
    assert.equal(resolveAdapterStampForAssetRoot(sibling, alpha).basis, "foreign-tree");
  });
});

// ── AC1, restated where it can be checked cheaply ───────────────────────────

/** Platform branches that are NOT about path identity, listed with the reason so
 *  a reader can disagree with a specific line rather than with a blanket
 *  exemption — and CHECKED FOR STALENESS below, so this never decays into a list
 *  nobody rereads. Both are about whether worktree isolation is AVAILABLE on a
 *  host, a question that predates FG-693 and has no aliasing content. */
const PLATFORM_BRANCH_NOT_ABOUT_IDENTITY: Record<string, string> = {
  "src/v2/self-host-guard.ts": "remediation() prints host-specific advice about arming worktree isolation",
  "src/v2/worktree-lifecycle.ts": "worktree mode's default and its permanent Linux non-support (macOS-only orchestrator)",
};

test("FG-693 AC1: no consumer this harness mutates special-cases an alias prefix or branches on platform for identity", () => {
  // src/util/fg693-single-canonicalizer.test.ts owns the repo-wide realpath scan.
  // This is the narrower claim for exactly the files AC8 falsifies, kept beside
  // the catalogue so the two cannot drift: a consumer that grew a `/private`
  // branch would still pass its own regression run on Linux and fail on darwin,
  // which is the shape of every previous repair of this defect.
  //
  // The alias prefixes are matched as QUOTED string literals. A comment may name
  // `/private/var` — several of these files explain the defect in prose, and they
  // should — but no consumer may carry one as a value it compares against.
  const aliasLiteral = /["'`][^"'`\n]*\/(?:private|tmp|var)\//;
  const platformBranch = /process\.platform|os\.platform\(\)/;

  const offenders: string[] = [];
  const mutated = [...new Set(readSeamCatalogue().map((s) => s.mutate))].sort();
  for (const mutate of mutated) {
    const source = readFileSync(join(REPO_ROOT, mutate), "utf8");
    // Strip line and block comments before the literal scan: prose about the
    // defect is not a special case OF the defect.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    if (aliasLiteral.test(code)) offenders.push(`${mutate}: carries an alias prefix as a string literal`);
    if (platformBranch.test(code) && !(mutate in PLATFORM_BRANCH_NOT_ABOUT_IDENTITY)) {
      offenders.push(`${mutate}: branches on the platform with no declared non-identity reason`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `consumers special-casing an alias prefix or a platform:\n${offenders.join("\n")}\n\n` +
      "A consumer that needs a platform branch for a reason unrelated to path identity declares it in " +
      "PLATFORM_BRANCH_NOT_ABOUT_IDENTITY with that reason. There is no exemption for an alias prefix.",
  );

  // Staleness: an exemption whose file no longer branches on the platform is a
  // line nobody has reread, and it would silently cover a NEW branch later.
  const stale = Object.keys(PLATFORM_BRANCH_NOT_ABOUT_IDENTITY).filter(
    (file) => !platformBranch.test(readFileSync(join(REPO_ROOT, file), "utf8")),
  );
  assert.deepEqual(stale, [], `exempted files that no longer branch on the platform — delete these entries: ${stale}`);
});

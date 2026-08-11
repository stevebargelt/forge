// FG-693 — CAN A PRE-CHANGE GATE ROW BE CREDITED TO THE WRONG CHECKOUT?
//
// AC6 requires pre-change durable records to stay READABLE and ATTRIBUTABLE
// through the canonical spelling without rewriting audit evidence. The obvious
// way to deliver that — resolve the stored spelling at read time and compare —
// is the thing this file exists to prove is not enough.
//
// A pre-change row records a SPELLING, not a tree. Resolving that spelling later
// establishes at most that it resolves TODAY. It never establishes that it
// resolves to the tree the row was written against. A `/projects/current`-style
// symlink that pointed at checkout A when the row was written still resolves
// after being repointed at checkout B — so a reader asking about B resolves the
// stored spelling, gets B, and credits A's green gate to B. A gate that never
// ran against B reports as covered. Nothing in the row can contradict it: its
// canonical column is NULL precisely because identity was never proven.
//
// So the claim "read-time resolution's worst case is a redundant gate run and
// never a false pass" is FALSE of read-time resolution alone. It becomes true
// only once the retarget-proof predicate in ./legacy-path-attribution.ts gates
// attribution, and test (1) below is what makes that gate real rather than
// asserted — including its mutation, which flips the predicate to "accept any
// resolvable legacy row" IN THE PRODUCTION SOURCE and shows the false pass
// appear.
//
// WRITE-SIDE FIDELITY. Every legacy row here is written the way the PRE-change
// code wrote it — a direct INSERT of the columns that existed then, with
// project_dir carrying `path.resolve`'s lexical output and no canonical column
// at all — and read back through the POST-change lookup. A test that wrote and
// read through new code on both halves could not detect the defect it is aimed
// at, and would not satisfy AC6.
//
// HOST NOTE (darwin). `mkdtemp` under `/var/folders/...` is itself the /var vs
// /private/var alias, so on darwin the "recorded under an alias" cases fire
// natively on the plain temp spelling; on Linux the same class is reached with a
// test-created symlink. Both platforms therefore execute both directions, which
// is the point of AC9 — this must not be Linux-green/macOS-red again.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import {
  findCoveringGateEvidence,
  insertHostVerification,
  queryHostVerificationRowsForGate,
  type LegacyDeclineReport,
} from "./host-verifications.js";
import { attributeLegacyRow, retargetProofIdentity } from "./legacy-path-attribution.js";

const GATE_CMD = "npm run test:all";
const GATE_SHA = "abc123def456abc123def456abc123def456abc";
const TICKET = "FG-693-LEGACY";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let root: string;
/** two real, distinct checkouts. Sibling paths sharing a lexical prefix, so the
 *  negative controls cannot pass by accident of string comparison. */
let checkoutA: string;
let checkoutB: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  root = realpathSync(mkdtempSync(join(tmpdir(), "fg693-legacy-")));
  checkoutA = join(root, "checkout");
  checkoutB = join(root, "checkout-b");
  mkdirSync(checkoutA);
  mkdirSync(checkoutB);
  // A per-project CI workflow that does NOT run the gate, so every lookup below
  // fails the CI pairing precondition and can only ever be satisfied by a host
  // row. Otherwise a null result would be ambiguous between "the row was
  // declined" and "CI happened to answer".
  const workflows = join(checkoutA, ".github", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(workflows, "ci.yml"), "name: CI\njobs:\n  test:\n    steps:\n      - run: npm run something-else\n");
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** THE PRE-CHANGE WRITER, reproduced exactly: the columns that existed before
 *  FG-693, project_dir carrying `path.resolve`'s output (the old
 *  canonicalizeProjectDir), and no canonical column — so the row reads back with
 *  project_dir_canonical NULL, which is what every aged row on every machine
 *  looks like. */
function insertPreChangeRow(opts: { ticketId?: string; projectDirAsWritten: string; sha?: string; gate?: string; exitCode?: number }): number {
  const info = db
    .prepare(
      `INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at, source, ci_url)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'host', NULL)`
    )
    .run(
      opts.ticketId ?? TICKET,
      resolve(opts.projectDirAsWritten),
      opts.sha ?? GATE_SHA,
      opts.gate ?? GATE_CMD,
      opts.gate ?? GATE_CMD,
      opts.exitCode ?? 0,
      "2026-01-01T00:00:00Z"
    );
  const id = Number(info.lastInsertRowid);
  const written = db.prepare("SELECT project_dir_canonical FROM host_verifications WHERE id = ?").get(id) as {
    project_dir_canonical: string | null;
  };
  assert.equal(written.project_dir_canonical, null, "fixture check: a pre-change row must carry a NULL canonical identity");
  return id;
}

function storedProjectDir(id: number): string {
  return (db.prepare("SELECT project_dir FROM host_verifications WHERE id = ?").get(id) as { project_dir: string }).project_dir;
}

function lookup(projectDir: string, onLegacyDeclines?: (r: LegacyDeclineReport) => void) {
  return findCoveringGateEvidence({
    ticketId: TICKET,
    projectDir,
    sha: GATE_SHA,
    command: GATE_CMD,
    checkStatusProvider: () => null,
    ...(onLegacyDeclines ? { onLegacyDeclines } : {}),
  });
}

// ── (1) THE RETARGETING TEST ────────────────────────────────────────────────

describe("a pre-change row recorded through a symlink that was later repointed", () => {
  test("is NOT credited to the checkout the symlink points at TODAY — and the decline is counted legacy-alias-unprovable", () => {
    const link = join(root, "current");
    symlinkSync(checkoutA, link);
    const rowId = insertPreChangeRow({ projectDirAsWritten: link });
    const bytesAtWrite = storedProjectDir(rowId);

    // The retarget. Everything the row can say about itself is unchanged.
    unlinkSync(link);
    symlinkSync(checkoutB, link);
    assert.equal(realpathSync(link), checkoutB, "fixture check: the stored spelling now resolves to a DIFFERENT checkout");

    const declines: LegacyDeclineReport[] = [];
    const evidence = lookup(checkoutB, (r) => declines.push(r));

    assert.equal(
      evidence,
      null,
      "checkout A's gate evidence must not be credited to checkout B. Read-time resolution of the stored spelling yields B and would say yes; that is the false pass the retarget-proof predicate exists to refuse"
    );
    assert.equal(declines.length, 1, "the refusal must be REPORTED at the point the gate is about to re-run, not silently swallowed");
    assert.equal(declines[0]!.declines["legacy-alias-unprovable"], 1);
    assert.equal(declines[0]!.declines["legacy-unresolved"], 0);
    assert.match(declines[0]!.message, /legacy-alias-unprovable/);
    assert.equal(storedProjectDir(rowId), bytesAtWrite, "the read rewrote nothing — project_dir is byte-identical");
  });

  test("is not credited to the checkout it was written against either — the row cannot prove which one that was", () => {
    const link = join(root, "current");
    symlinkSync(checkoutA, link);
    insertPreChangeRow({ projectDirAsWritten: link });
    unlinkSync(link);
    symlinkSync(checkoutB, link);

    assert.equal(
      lookup(checkoutA),
      null,
      "the point is not that B is wrong and A is right — a spelling that went through a link cannot state its write-time target at all, in either direction"
    );
  });

  test("a symlinked spelling that was NEVER retargeted is declined too — the row cannot tell the two situations apart, and refusing costs only a re-run", () => {
    const link = join(root, "current");
    symlinkSync(checkoutA, link);
    insertPreChangeRow({ projectDirAsWritten: link });

    const declines: LegacyDeclineReport[] = [];
    assert.equal(lookup(checkoutA, (r) => declines.push(r)), null);
    assert.equal(declines[0]!.declines["legacy-alias-unprovable"], 1, "a traversed link is unprovable whether or not it actually moved");
  });
});

// ── THE MUTATION: the predicate must be load-bearing, not decorative ────────
//
// A required part of this step (FG-693 step 4 acceptance): flip
// legacy-path-attribution.ts to "accept any resolvable legacy row" and the
// retargeting test above must go red. Done against the REAL production source —
// the file is read, one predicate is replaced, and the mutant is loaded and
// driven — so the mutation cannot silently stop corresponding to the code that
// ships. Nothing is written into src/: the mutant lives in a temp directory with
// its relative imports rewritten to absolute paths of the real modules.

const STORE_DIR = dirname(fileURLToPath(import.meta.url));

/** Rewrite every import specifier to an absolute one — relative ones to the real
 *  production `.ts` files, bare ones to their resolved package entry — so a copy
 *  can live in a temp directory and still import exactly what the original did.
 *  Builtins are left alone. */
function absolutizeImports(source: string, originalDir: string): string {
  const requireFrom = createRequire(join(originalDir, "noop.ts"));
  // Only a real import/export tail: a quoted, space-free specifier terminated by
  // `";`. Prose in a comment can contain `from "…"` too (host-verifications.ts
  // has one), and rewriting that would corrupt the mutant.
  return source.replace(/\bfrom "([^"\s]+)";/g, (whole, spec: string) => {
    if (spec.startsWith("node:")) return whole;
    const target = spec.startsWith(".")
      ? resolve(originalDir, spec).replace(/\.js$/, ".ts")
      : requireFrom.resolve(spec);
    return `from ${JSON.stringify(pathToFileURL(target).href)};`;
  });
}

test("MUTATION: accepting any resolvable legacy row reintroduces the false pass — so the retarget-proof predicate is what prevents it", async () => {
  const mutantDir = mkdtempSync(join(tmpdir(), "fg693-mutant-"));
  const dbPath = join(mutantDir, "forge.db");
  try {
    // The same fixture as the retargeting test, on a FILE-backed store so the
    // mutant graph (its own module instances) can open the identical rows.
    const link = join(root, "current");
    symlinkSync(checkoutA, link);

    // Build the store shape the same way every other store test does, then seed
    // the pre-change row through raw SQL.
    const seed = new Database(dbPath);
    const { SCHEMA_SQL } = await import("./schema.js");
    const { applyMigrations } = await import("./db.js");
    seed.pragma("foreign_keys = ON");
    seed.exec(SCHEMA_SQL);
    applyMigrations(seed);
    seed
      .prepare(
        `INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at, source, ci_url)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'host', NULL)`
      )
      .run(TICKET, resolve(link), GATE_SHA, GATE_CMD, GATE_CMD, 0, "2026-01-01T00:00:00Z");
    seed.close();

    // The retarget.
    unlinkSync(link);
    symlinkSync(checkoutB, link);

    // Production, against this exact store: declines.
    const prodDb = new Database(dbPath);
    const restoreProd = setDbForTest(prodDb);
    let productionEvidence;
    try {
      productionEvidence = lookup(checkoutB);
    } finally {
      setDbForTest(restoreProd as DatabaseInstance);
      prodDb.close();
    }
    assert.equal(productionEvidence, null, "control: production must decline before the mutation can mean anything");

    // THE MUTATION. `retargetProofIdentity` stops proving anything and accepts
    // every resolvable legacy row — precisely the "just resolve it at read time"
    // rule this step rejects.
    const attributionSrc = readFileSync(join(STORE_DIR, "legacy-path-attribution.ts"), "utf8");
    const MARKER = `  if (identity.kind !== "resolved") return { provable: false, reason: "legacy-unresolved" };`;
    assert.ok(
      attributionSrc.includes(MARKER),
      "the mutation must keep pointing at the real predicate — if this marker moved, re-aim the mutation rather than deleting it"
    );
    const mutatedAttribution = absolutizeImports(
      attributionSrc.replace(
        MARKER,
        `${MARKER}\n  if (identity.kind === "resolved") return { provable: true, identity }; // MUTANT: accept any resolvable legacy row`
      ),
      STORE_DIR
    );
    const mutantAttributionPath = join(mutantDir, "legacy-path-attribution.ts");
    writeFileSync(mutantAttributionPath, mutatedAttribution);

    const hostSrc = readFileSync(join(STORE_DIR, "host-verifications.ts"), "utf8");
    const mutantHost = absolutizeImports(hostSrc, STORE_DIR).replace(
      new RegExp(`from ${JSON.stringify(pathToFileURL(join(STORE_DIR, "legacy-path-attribution.ts")).href)}`, "g"),
      `from ${JSON.stringify(pathToFileURL(mutantAttributionPath).href)}`
    );
    const mutantHostPath = join(mutantDir, "host-verifications.ts");
    writeFileSync(mutantHostPath, mutantHost);
    assert.notEqual(mutantHost, hostSrc, "the mutant consumer must actually be wired to the mutant predicate");

    // A driver INSIDE the mutant's own module graph, so the store handle the
    // mutant reads through is unambiguously the one pointed at this fixture —
    // no assumption that a rewritten specifier lands on the same module
    // instance the test itself holds.
    const driverPath = join(mutantDir, "driver.ts");
    writeFileSync(
      driverPath,
      absolutizeImports(
        `import Database from "better-sqlite3";\n` +
          `import { setDbForTest } from "./db.js";\n` +
          `export function run(dbPath: string, opts: any): unknown {\n` +
          `  const handle = new Database(dbPath);\n` +
          `  const restore = setDbForTest(handle);\n` +
          `  try { return findCoveringGateEvidence(opts); } finally { setDbForTest(restore); handle.close(); }\n` +
          `}\n`,
        STORE_DIR
      ).replace(
        "export function run",
        `import { findCoveringGateEvidence } from ${JSON.stringify(pathToFileURL(mutantHostPath).href)};\nexport function run`
      )
    );

    const driver = (await import(pathToFileURL(driverPath).href)) as { run: (dbPath: string, opts: unknown) => unknown };
    const mutantEvidence = driver.run(dbPath, {
      ticketId: TICKET,
      projectDir: checkoutB,
      sha: GATE_SHA,
      command: GATE_CMD,
      checkStatusProvider: () => null,
      onLegacyDeclines: () => {},
    }) as { source?: string } | null;

    assert.ok(
      mutantEvidence,
      "THE MUTANT MUST FALSELY PASS. If it does not, this fixture no longer reaches the retargeting path and the green above proves nothing"
    );
    assert.equal(mutantEvidence!.source, "host_row", "and it falsely passes by crediting checkout A's row to checkout B");
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
});

// ── (2) THE RETARGET-PROOF POSITIVE: AC6 attributability is not vacuous ─────

test("a pre-change row whose stored spelling traversed NO symlink is credited through the canonical spelling", () => {
  const rowId = insertPreChangeRow({ projectDirAsWritten: checkoutA });
  const bytesAtWrite = storedProjectDir(rowId);

  const evidence = lookup(checkoutA);
  assert.ok(evidence, "a link-free legacy spelling is retarget-proof — retargeting cannot have intervened, so the row is attributable");
  assert.equal(evidence!.source, "host_row");
  assert.equal((evidence as { row: { id?: number } }).row.id, rowId);
  assert.equal(storedProjectDir(rowId), bytesAtWrite, "no silent rewrite of audit evidence");
  assert.equal(
    (db.prepare("SELECT project_dir_canonical FROM host_verifications WHERE id = ?").get(rowId) as { project_dir_canonical: string | null })
      .project_dir_canonical,
    null,
    "and the read did NOT opportunistically backfill the canonical column — reads are write-free"
  );
});

test("that same retarget-proof row is found through an ALIASED spelling of the caller's checkout", () => {
  insertPreChangeRow({ projectDirAsWritten: checkoutA });
  const aliasRoot = join(root, "alias");
  symlinkSync(root, aliasRoot);

  assert.ok(
    lookup(join(aliasRoot, "checkout")),
    "the CALLER's spelling may be an alias — it is resolved to a proven identity; only the ROW's unproven spelling is restricted"
  );
  assert.ok(lookup(`${checkoutA}/`), "trailing separator");
  assert.ok(lookup(`${root}/./checkout`), "a `.` segment");
});

test("negative control: a retarget-proof legacy row is not credited to a DIFFERENT checkout sharing its lexical prefix", () => {
  insertPreChangeRow({ projectDirAsWritten: checkoutA });
  assert.ok(checkoutB.startsWith(checkoutA), "fixture check: the two paths really do share a lexical prefix");
  assert.equal(lookup(checkoutB), null);
});

// ── (3) A LEGACY ROW WHOSE DIRECTORY IS GONE ────────────────────────────────

test("a pre-change row whose directory no longer exists stays fully readable, is never rewritten, and is not attributable (counted legacy-unresolved)", () => {
  const disposable = join(root, "disposable-worktree");
  mkdirSync(disposable);
  const rowId = insertPreChangeRow({ projectDirAsWritten: disposable });
  const bytesAtWrite = storedProjectDir(rowId);
  rmSync(disposable, { recursive: true, force: true });

  // READABLE: the shape every audit and listing read uses — plain SQL over the
  // table, no identity filter — still returns the row, verbatim.
  const listed = db.prepare("SELECT * FROM host_verifications WHERE ticket_id = ? ORDER BY recorded_at DESC").all(TICKET) as {
    id: number;
    project_dir: string;
    exit_code: number;
  }[];
  assert.equal(listed.length, 1, "an audit/listing read must never filter a row out for being unattributable");
  assert.equal(listed[0]!.project_dir, bytesAtWrite, "returned verbatim — never rewritten, never re-attributed");
  assert.equal(listed[0]!.exit_code, 0, "the recorded result itself is untouched");

  // NOT ATTRIBUTABLE, with the reason named. Asked from a checkout that DOES
  // resolve, so the decline is genuinely about the row and not about the caller.
  const declines: LegacyDeclineReport[] = [];
  assert.equal(lookup(checkoutA, (r) => declines.push(r)), null);
  assert.equal(declines[0]!.declines["legacy-unresolved"], 1);
  assert.equal(declines[0]!.declines["legacy-alias-unprovable"], 0);
  assert.equal(storedProjectDir(rowId), bytesAtWrite);
});

test("an UNRESOLVABLE caller (its own checkout is gone) is refused rather than matched against a byte-identical stored spelling", () => {
  const disposable = join(root, "disposable-worktree");
  mkdirSync(disposable);
  insertPreChangeRow({ projectDirAsWritten: disposable });
  rmSync(disposable, { recursive: true, force: true });

  assert.equal(
    queryHostVerificationRowsForGate(TICKET, disposable, GATE_CMD).length,
    0,
    "two identical UNPROVEN spellings are not evidence of one tree — they may be two worktrees that took turns at one path"
  );
});

// ── (4)/(5) WRITE PRE-CHANGE, READ POST-CHANGE; MIXED POPULATIONS ───────────

test("post-change rows and legacy rows coexist: a proven row covers even when a declined legacy row sits beside it", () => {
  insertPreChangeRow({ projectDirAsWritten: join(root, "gone") });
  insertHostVerification({
    ticketId: TICKET,
    projectDir: checkoutA,
    commitSha: GATE_SHA,
    gateName: GATE_CMD,
    command: GATE_CMD,
    exitCode: 0,
    recordedAt: "2026-01-02T00:00:00Z",
  });

  const evidence = lookup(checkoutA);
  assert.ok(evidence, "a proven post-change row covers regardless of what the legacy population says");
  assert.equal(evidence!.source, "host_row");
  assert.equal((evidence as { row: { projectDirCanonical?: string | null } }).row.projectDirCanonical, checkoutA);
});

test("rows from both populations come back in recorded_at order, as the query has always promised", () => {
  insertPreChangeRow({ projectDirAsWritten: checkoutA, sha: "sha-legacy" });
  insertHostVerification({
    ticketId: TICKET,
    projectDir: checkoutA,
    commitSha: "sha-post",
    gateName: GATE_CMD,
    command: GATE_CMD,
    exitCode: 0,
    recordedAt: "2026-01-02T00:00:00Z",
  });

  const rows = queryHostVerificationRowsForGate(TICKET, checkoutA, GATE_CMD);
  assert.deepEqual(
    rows.map((r) => r.commitSha),
    ["sha-legacy", "sha-post"],
    "the legacy row was recorded first and must come first — the merge of the two SQL narrowings is re-sorted, not concatenated"
  );
});

// ── The predicate itself, at close range ────────────────────────────────────

describe("retargetProofIdentity", () => {
  test("a link-free absolute spelling is provable", () => {
    const proof = retargetProofIdentity(checkoutA);
    assert.equal(proof.provable, true);
    assert.equal((proof as { identity: { physical: string } }).identity.physical, checkoutA);
  });

  test("a spelling through a symlink is not", () => {
    const link = join(root, "current");
    symlinkSync(checkoutA, link);
    assert.deepEqual(retargetProofIdentity(link), { provable: false, reason: "legacy-alias-unprovable" });
  });

  test("a `..` segment is declined even when it resolves to the physical path — `..` collapses lexically without following the link it passed through", () => {
    // `${root}/checkout-b/../checkout` realpaths to `${root}/checkout` and
    // `resolve()`s to the same bytes, so plain byte-equality would call it
    // provable. It is not: swap `checkout-b` for a symlink and the SAME
    // lexical answer comes back while realpath has followed a link that could
    // since have moved. `..` is the one segment with that property.
    assert.deepEqual(retargetProofIdentity(`${root}/checkout-b/../checkout`), {
      provable: false,
      reason: "legacy-alias-unprovable",
    });

    const linkedSibling = join(root, "sibling-link");
    symlinkSync(checkoutB, linkedSibling);
    assert.equal(realpathSync(`${linkedSibling}/../checkout`), checkoutA, "fixture check: it really does resolve to checkout A");
    assert.equal(resolve(`${linkedSibling}/../checkout`), checkoutA, "…and lexically too — which is exactly why byte-equality alone is not enough");
    assert.equal(retargetProofIdentity(`${linkedSibling}/../checkout`).provable, false);
  });

  test("a gone directory is legacy-unresolved, distinctly from an alias", () => {
    assert.deepEqual(retargetProofIdentity(join(root, "never-existed")), { provable: false, reason: "legacy-unresolved" });
  });

  test("attributeLegacyRow refuses when the CALLER's path is unproven, and says so distinctly from a decline about the row", () => {
    assert.deepEqual(attributeLegacyRow(checkoutA, join(root, "gone")), { outcome: "unproven_target" });
    assert.deepEqual(attributeLegacyRow(checkoutA, checkoutB), { outcome: "other_project", physical: checkoutA });
    assert.deepEqual(attributeLegacyRow(checkoutA, checkoutA), { outcome: "attributed", physical: checkoutA });
  });
});

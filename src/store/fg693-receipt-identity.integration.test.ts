// FG-693 step 6 — ORCHESTRATOR RECEIPTS UNDER THE CANONICAL IDENTITY CONTRACT.
//
// Proven by EXECUTION against a real SQLite file and real directories, symlinks and
// deletions, through the store's own production write and read entry points. Nothing
// here calls src/util/path-identity.ts to make its point: an assertion that the
// identity helper agrees with itself would satisfy none of the acceptance criteria
// this file exists for (AC5 requires each consumer's own argument-production seam).
//
// What is proven:
//
//   1  THE RETARGETING CASE. A NULL-canonical (pre-change) receipt recorded under a
//      symlink spelling that pointed at checkout A does NOT authorize anything for
//      checkout B after that symlink is repointed — even though read-time resolution
//      of its stored spelling now lands squarely on B. The decline is counted
//      legacy-alias-unprovable.
//   2  AND IT IS STILL VISIBLE. That same declined receipt is still listed under the
//      project, carrying the unproven-spelling label. FG-576's property — a live
//      orchestrator never silently vanishes from `forge show` — is preserved, which
//      is what makes the display/authority split load-bearing rather than cosmetic.
//   3  RETARGET-PROOF LEGACY ROWS STILL WORK. A legacy receipt whose stored spelling
//      traversed no symlink attributes normally and authorizes normally, so AC6's
//      attributability is real and not vacuous.
//   4  POST-CHANGE ALIAS EQUIVALENCE. A receipt written through one spelling is found
//      through a symlinked parent, a trailing separator, a relative spelling — and,
//      where the host's own temp directory is an alias (darwin's /var -> /private/var),
//      through that native alias too, with no platform branch anywhere in this file.
//   5  NOTHING IS REWRITTEN AND NOTHING IS WRITTEN. project_dir bytes are identical
//      before and after every read, and every project read completes against a
//      READ-ONLY store handle.
//   6  NEGATIVE CONTROL. Distinct physical directories stay distinct even when their
//      lexical paths share a prefix.
//
// Every DB here lives under the per-process temp FORGE_HOME the harness installs
// (src/test-setup.ts) — never the operator's ~/.forge/forge.db.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { applyMigrations, getDb, setDbForTest } from "./db.js";
import { SCHEMA_SQL } from "./schema.js";
import { FORGE_HOME } from "../util/paths.js";
import {
  ORCHESTRATOR_RECEIPT_COLUMNS,
  OrchestratorReceiptAuthorityError,
  closeOrchestratorReceipt,
  listOrchestratorReceiptsAuthorizedForProject,
  listOrchestratorReceiptsForProject,
  markOrchestratorReceiptRunning,
  persistPendingOrchestratorReceipt,
  type OrchestratorLaunchDecision,
  type OrchestratorReceipt,
  type ReceiptLegacyDeclineReport,
} from "./orchestrator-receipts.js";
import { newLegacyDeclineTally } from "./legacy-path-attribution.js";

// ─── fixture ────────────────────────────────────────────────────────────────

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let dbPath: string;

/** A real file (not :memory:) so the read-only-handle case is a real read-only open.
 *  Rollback journalling rather than WAL, so a second handle needs no -shm write. */
function openStore(readonly = false): DatabaseInstance {
  const handle = new Database(dbPath, readonly ? { readonly: true } : {});
  if (!readonly) {
    handle.pragma("foreign_keys = ON");
    handle.exec(SCHEMA_SQL);
    applyMigrations(handle);
  }
  return handle;
}

/** base/
 *    checkout-a/          a real checkout
 *    checkout-a-sibling/  a DIFFERENT checkout whose lexical path shares a prefix
 *    checkout-b/          a second real checkout
 *    current -> …         the repointable spelling the retargeting case turns on
 *    link-to-a -> …       a stable alias of checkout-a  */
let base: string;
let checkoutA: string;
let checkoutASibling: string;
let checkoutB: string;
let current: string;
let linkToA: string;

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "fg693-receipt-identity-")));
  checkoutA = join(base, "checkout-a");
  checkoutASibling = join(base, "checkout-a-sibling");
  checkoutB = join(base, "checkout-b");
  current = join(base, "current");
  linkToA = join(base, "link-to-a");
  for (const dir of [checkoutA, checkoutASibling, checkoutB]) mkdirSync(dir);
  symlinkSync(checkoutA, current);
  symlinkSync(checkoutA, linkToA);
  dbPath = join(FORGE_HOME, "fg693-receipts.db");
});

after(() => {
  if (prev) setDbForTest(prev);
  try {
    db.close();
  } catch {
    // already closed by a test that swapped in its own handle
  }
  rmSync(base, { recursive: true, force: true });
  rmSync(dbPath, { force: true });
});

beforeEach(() => {
  rmSync(dbPath, { force: true });
  db = openStore();
  prev = setDbForTest(db) ?? prev ?? null;
  // Every test starts from the fixture's original wiring, whatever a previous test
  // repointed. `current` is the whole point of this file, so its state is never
  // inherited across tests.
  unlinkSync(current);
  symlinkSync(checkoutA, current);
});

const DECISION: OrchestratorLaunchDecision = {
  sessionKey: "11111111-2222-3333-4444-555555555555",
  projectDir: "/replaced-per-test",
  runtime: "claude-code",
  provider: "anthropic",
  adapter: "claude",
  sessionOperation: "new",
  createdAt: "2026-08-10T10:00:00.000Z",
};

/** THE PRE-CHANGE WRITE PATH, verbatim: the historical column projection, which does
 *  not name project_dir_canonical, so the row lands NULL-canonical exactly as every
 *  receipt written before FG-693 did.
 *
 *  A symlink spelling in project_dir is a REAL legacy value, not a contrived one:
 *  FG-576's canonicalizer fell back to a lexically resolved path whenever realpath
 *  failed, and rows written before FG-576 stored whatever the launcher held. That is
 *  precisely why the canonical column is NULL for them — nothing ever proved what
 *  they named. */
function seedLegacyReceipt(
  receiptId: string,
  storedSpelling: string,
  state: "pending" | "running",
  createdAt = "2026-07-01T10:00:00.000Z",
): void {
  getDb()
    .prepare(
      `INSERT INTO orchestrator_receipts (${ORCHESTRATOR_RECEIPT_COLUMNS})
       VALUES (@receipt_id, @session_key, @state, @created_at, @updated_at, @project_dir, @project_name,
               @resolved_profile, @runtime, @provider, @model, @auth_mode, @resolved_by, @adapter,
               @session_operation, @session_target, @provider_session_id, @identity_strength,
               @identity_basis, @carrier_generation, @carrier_path, @carrier_acceptance,
               @carrier_evidence, @limitations, @task_id, @launcher_pid, @launcher_identity,
               @started_at, @closed_at, @exit_code, @exit_signal, @failure_reason)`,
    )
    .run({
      receipt_id: receiptId,
      session_key: `sk-${receiptId}`,
      state,
      created_at: createdAt,
      updated_at: createdAt,
      project_dir: storedSpelling,
      project_name: null,
      resolved_profile: null,
      runtime: "claude-code",
      provider: "anthropic",
      model: null,
      auth_mode: null,
      resolved_by: null,
      adapter: "claude",
      session_operation: "new",
      session_target: null,
      provider_session_id: null,
      identity_strength: "unknown",
      identity_basis: null,
      carrier_generation: null,
      carrier_path: null,
      carrier_acceptance: "unproven",
      carrier_evidence: null,
      limitations: "[]",
      task_id: null,
      launcher_pid: null,
      launcher_identity: null,
      started_at: state === "running" ? "2026-07-01T10:00:01.000Z" : null,
      closed_at: null,
      exit_code: null,
      exit_signal: null,
      failure_reason: null,
    });
}

function storedProjectDirs(): { receipt_id: string; project_dir: string; project_dir_canonical: string | null }[] {
  return getDb()
    .prepare(`SELECT receipt_id, project_dir, project_dir_canonical FROM orchestrator_receipts ORDER BY receipt_id`)
    .all() as { receipt_id: string; project_dir: string; project_dir_canonical: string | null }[];
}

function ids(receipts: OrchestratorReceipt[]): string[] {
  return receipts.map((r) => r.receiptId).sort();
}

function retargetCurrentTo(target: string): void {
  unlinkSync(current);
  symlinkSync(target, current);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE RETARGETING CASE — the reason read-time resolution alone is not enough
// ═══════════════════════════════════════════════════════════════════════════

test("a NULL-canonical receipt recorded through a repointed symlink authorizes NOTHING for the tree it now resolves to", () => {
  seedLegacyReceipt("orx-legacy-pending", current, "pending");
  seedLegacyReceipt("orx-legacy-running", current, "running");

  retargetCurrentTo(checkoutB);

  // PRECONDITION, so the test cannot pass vacuously: the naive compatibility
  // projection — resolve the stored spelling at read time and compare — WOULD credit
  // these receipts to checkout B right now. That is the false pass being closed.
  assert.equal(realpathSync(current), realpathSync(checkoutB), "precondition: the stored spelling now lands on B");

  const declines = newLegacyDeclineTally();
  const reports: ReceiptLegacyDeclineReport[] = [];
  const authorized = listOrchestratorReceiptsAuthorizedForProject(checkoutB, 200, {
    declines,
    onLegacyDeclines: (report) => reports.push(report),
  });

  assert.deepEqual(ids(authorized), [], "checkout B may not act on a receipt written against checkout A");
  assert.equal(declines["legacy-alias-unprovable"], 2, "both declines are counted under the shared reason code");
  assert.equal(declines["legacy-unresolved"], 0, "the spelling resolves — it just cannot be vouched for");
  assert.equal(reports.length, 1, "the operator is told why receipts are listed that nothing will act on");
  assert.match(reports[0]!.message, /legacy-alias-unprovable/);

  // …and neither does the receipt's OWN checkout get to act on it: the row cannot
  // say where its spelling pointed when it was written, so it proves nothing for
  // anyone. A decline is not a re-attribution.
  assert.deepEqual(ids(listOrchestratorReceiptsAuthorizedForProject(checkoutA, 200, {})), []);
});

test("a lifecycle write scoped to a project it cannot prove ownership of is REFUSED by name", () => {
  seedLegacyReceipt("orx-legacy-pending", current, "pending");
  seedLegacyReceipt("orx-legacy-running", current, "running");
  retargetCurrentTo(checkoutB);

  const declined: ReceiptLegacyDeclineReport[] = [];
  assert.throws(
    () => markOrchestratorReceiptRunning("orx-legacy-pending", {}, { project: checkoutB, onDecline: (r) => declined.push(r) }),
    (e: unknown) =>
      e instanceof OrchestratorReceiptAuthorityError &&
      e.reason === "legacy-alias-unprovable" &&
      /cannot be acted on/.test(e.message),
    "an orphan adoption for checkout B must not move a receipt checkout B cannot prove is its",
  );
  assert.equal(declined.length, 1, "the refusal is counted, not just thrown");

  assert.throws(
    () => closeOrchestratorReceipt("orx-legacy-running", { state: "orphaned" }, { project: checkoutB }),
    (e: unknown) => e instanceof OrchestratorReceiptAuthorityError && e.reason === "legacy-alias-unprovable",
    "nor may a project-scoped cleanup close it",
  );

  // The refusals are refusals: nothing moved.
  assert.deepEqual(
    getDb().prepare(`SELECT receipt_id, state FROM orchestrator_receipts ORDER BY receipt_id`).all(),
    [
      { receipt_id: "orx-legacy-pending", state: "pending" },
      { receipt_id: "orx-legacy-running", state: "running" },
    ],
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. …AND IT IS STILL VISIBLE (the FG-576 property the split protects)
// ═══════════════════════════════════════════════════════════════════════════

test("the declined receipt is still LISTED under the project, labelled as attributed by an unproven spelling", () => {
  seedLegacyReceipt("orx-legacy-running", current, "running");
  retargetCurrentTo(checkoutB);

  const listed = listOrchestratorReceiptsForProject(checkoutB);
  assert.deepEqual(ids(listed), ["orx-legacy-running"], "a legacy receipt never silently disappears from `forge show`");

  const attribution = listed[0]!.projectAttribution;
  assert.equal(attribution?.kind, "unproven", "display is not authority: it is shown, and it is labelled");
  assert.equal(attribution?.kind === "unproven" ? attribution.reason : null, "legacy-alias-unprovable");
  assert.match(
    attribution?.kind === "unproven" ? attribution.label : "",
    /unproven spelling/,
    "the label says WHY, in the operator's terms",
  );
  assert.equal(listed[0]!.projectDirCanonical, null, "and the row is still honestly NULL-canonical");

  // The same receipt, through the display path, is absent from the acting path.
  assert.deepEqual(ids(listOrchestratorReceiptsAuthorizedForProject(checkoutB, 200, {})), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. RETARGET-PROOF LEGACY ROWS ATTRIBUTE AND AUTHORIZE NORMALLY
// ═══════════════════════════════════════════════════════════════════════════

test("a legacy receipt whose stored spelling traversed no symlink is attributed AND authorizes", () => {
  seedLegacyReceipt("orx-legacy-proof", checkoutA, "pending");

  const listed = listOrchestratorReceiptsForProject(checkoutA);
  assert.deepEqual(ids(listed), ["orx-legacy-proof"]);
  assert.equal(listed[0]!.projectAttribution?.kind, "proven", "the recorded bytes ARE the physical path");

  const declines = newLegacyDeclineTally();
  assert.deepEqual(ids(listOrchestratorReceiptsAuthorizedForProject(checkoutA, 200, { declines })), ["orx-legacy-proof"]);
  assert.equal(declines["legacy-alias-unprovable"] + declines["legacy-unresolved"], 0, "nothing was declined");

  // AC5 for the legacy population: an ALIASED spelling of the same checkout decides
  // identically to the canonical one.
  assert.deepEqual(ids(listOrchestratorReceiptsAuthorizedForProject(linkToA, 200, {})), ["orx-legacy-proof"]);
  assert.deepEqual(ids(listOrchestratorReceiptsAuthorizedForProject(`${checkoutA}/`, 200, {})), ["orx-legacy-proof"]);

  const moved = markOrchestratorReceiptRunning("orx-legacy-proof", {}, { project: linkToA });
  assert.equal(moved.state, "running", "a proven legacy receipt is actionable through any spelling of its project");

  // Negative control, same row: a genuinely different checkout is refused — and
  // refused as OTHER-PROJECT, not as an unprovable legacy row.
  assert.throws(
    () => closeOrchestratorReceipt("orx-legacy-proof", { state: "exited", exitCode: 0 }, { project: checkoutB }),
    (e: unknown) => e instanceof OrchestratorReceiptAuthorityError && e.reason === "other-project",
  );
});

// FG-693 (fix batch): THE LEGACY SCAN'S CAP WAS ITSELF A SILENT TRUNCATION.
//
// It read the newest 2,000 NULL-canonical rows and only then asked which project they
// belonged to, so a store holding more newer legacy receipts for OTHER projects hid an
// older in-scope one from the listing AND from the authorized read — reported as "there
// are none", which is the same empty-board defect the dashboard's `LIMIT 2000` was
// removed for. The population is now narrowed by the identity question itself, asked
// once per DISTINCT recorded spelling, and the only limit left is the caller's own.
test("an in-scope legacy receipt past the old scan cap is still listed AND still authorizes", () => {
  // The requested project's receipt is the OLDEST row in the store, and link-free, so
  // it is retarget-proof: it must both list as proven and authorize.
  seedLegacyReceipt("orx-in-scope", checkoutA, "running", "2026-06-01T00:00:00.000Z");
  const FILLER = 2400;
  for (let i = 0; i < FILLER; i++) {
    seedLegacyReceipt(
      `orx-filler-${String(i).padStart(5, "0")}`,
      join(base, "_elsewhere", `checkout-${String(i).padStart(5, "0")}`),
      "pending",
      new Date(Date.UTC(2026, 6, 1) + i * 1000).toISOString(),
    );
  }

  // NOT vacuous: the pre-fix scan, restated, never reached this row.
  const capped = getDb()
    .prepare(
      `SELECT receipt_id FROM orchestrator_receipts WHERE project_dir_canonical IS NULL
        ORDER BY created_at DESC, receipt_id DESC LIMIT 2000`,
    )
    .all() as Array<{ receipt_id: string }>;
  assert.equal(
    capped.some((r) => r.receipt_id === "orx-in-scope"),
    false,
    "fixture: the capped scan stopped 400 rows short of this project's receipt",
  );

  assert.deepEqual(ids(listOrchestratorReceiptsForProject(checkoutA)), ["orx-in-scope"]);
  assert.deepEqual(ids(listOrchestratorReceiptsAuthorizedForProject(checkoutA, 200, {})), ["orx-in-scope"]);

  // And removing the cap widened nothing: 2,400 other checkouts' receipts are still
  // not this project's, and a different real checkout still claims none of them.
  assert.deepEqual(ids(listOrchestratorReceiptsForProject(checkoutB)), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. POST-CHANGE ALIAS EQUIVALENCE, THROUGH THE PRODUCTION WRITE AND READ
// ═══════════════════════════════════════════════════════════════════════════

test("a receipt written through one spelling is found through every other spelling of the same checkout", () => {
  // Written through a SYMLINKED PARENT — the spelling class the ticket is about.
  persistPendingOrchestratorReceipt({ ...DECISION, receiptId: "orx-post", projectDir: linkToA });

  assert.deepEqual(
    storedProjectDirs(),
    [{ receipt_id: "orx-post", project_dir: linkToA, project_dir_canonical: checkoutA }],
    "the launcher's bytes are kept VERBATIM; the PROVEN identity is a separate column",
  );

  for (const spelling of [checkoutA, linkToA, `${checkoutA}/`, `${linkToA}/`, current, join(base, "checkout-a", ".")]) {
    assert.deepEqual(
      ids(listOrchestratorReceiptsAuthorizedForProject(spelling, 200, {})),
      ["orx-post"],
      `a receipt must be actionable through ${spelling}`,
    );
    assert.equal(listOrchestratorReceiptsForProject(spelling)[0]?.projectAttribution?.kind, "proven");
  }

  // A RELATIVE spelling, resolved against the process's working directory — the
  // fourth alias class, and the one no amount of string rewriting can normalize.
  const cwd = process.cwd();
  try {
    process.chdir(base);
    assert.deepEqual(ids(listOrchestratorReceiptsAuthorizedForProject("checkout-a", 200, {})), ["orx-post"]);
    assert.deepEqual(ids(listOrchestratorReceiptsAuthorizedForProject("./checkout-a/", 200, {})), ["orx-post"]);
  } finally {
    process.chdir(cwd);
  }
});

test("where the host's own temp directory is an alias, the native alias case is exercised for real", () => {
  // No platform branch and no enumerated prefix: this asks the FILESYSTEM whether
  // mkdtemp's answer is already physical. On darwin it is not (/var -> /private/var),
  // so the two spellings below are the native alias pair the ticket was filed over;
  // on a host where they coincide there is no alias to exercise and the case is
  // reported as not applicable rather than silently passing.
  const rawBase = mkdtempSync(join(tmpdir(), "fg693-receipt-native-alias-"));
  const physicalBase = realpathSync(rawBase);
  try {
    if (rawBase === physicalBase) {
      assert.ok(true, "host temp dir is already physical — no native alias to exercise here");
      return;
    }
    const rawProject = join(rawBase, "checkout");
    const physicalProject = join(physicalBase, "checkout");
    mkdirSync(rawProject);

    persistPendingOrchestratorReceipt({ ...DECISION, receiptId: "orx-native", projectDir: rawProject });

    assert.deepEqual(
      storedProjectDirs(),
      [{ receipt_id: "orx-native", project_dir: rawProject, project_dir_canonical: physicalProject }],
      "the operator's spelling is preserved; identity is proven",
    );
    assert.deepEqual(
      ids(listOrchestratorReceiptsAuthorizedForProject(physicalProject, 200, {})),
      ["orx-native"],
      "the receipt is actionable through the host's physical spelling of the same directory",
    );
    assert.deepEqual(ids(listOrchestratorReceiptsAuthorizedForProject(rawProject, 200, {})), ["orx-native"]);
  } finally {
    rmSync(physicalBase, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE READ REWRITES NOTHING AND WRITES NOTHING
// ═══════════════════════════════════════════════════════════════════════════

test("every project read leaves project_dir byte-identical and completes against a READ-ONLY handle", () => {
  seedLegacyReceipt("orx-legacy-current", current, "running");
  seedLegacyReceipt("orx-legacy-proof", checkoutA, "running");
  seedLegacyReceipt("orx-legacy-gone", join(base, "deleted-checkout"), "running");
  persistPendingOrchestratorReceipt({ ...DECISION, receiptId: "orx-post", projectDir: linkToA });

  const before = storedProjectDirs();
  assert.deepEqual(
    before.map((r) => r.project_dir),
    [current, join(base, "deleted-checkout"), checkoutA, linkToA],
    "precondition: four DIFFERENT recorded spellings, each kept exactly as written",
  );

  db.close();
  const readonly = openStore(true);
  setDbForTest(readonly);
  try {
    for (const spelling of [checkoutA, linkToA, checkoutB, `${checkoutA}/`, join(base, "deleted-checkout")]) {
      listOrchestratorReceiptsForProject(spelling);
      listOrchestratorReceiptsAuthorizedForProject(spelling, 200, { onLegacyDeclines: () => {} });
    }
    assert.deepEqual(storedProjectDirs(), before, "no read rewrote, backfilled or converged a single byte");
  } finally {
    readonly.close();
    db = openStore();
    setDbForTest(db);
  }
});

test("a receipt whose project directory is GONE is still listed and still authorizes nothing", () => {
  const doomed = join(base, "doomed-checkout");
  mkdirSync(doomed);
  persistPendingOrchestratorReceipt({ ...DECISION, receiptId: "orx-doomed", projectDir: doomed });
  rmSync(doomed, { recursive: true, force: true });

  const listed = listOrchestratorReceiptsForProject(doomed);
  assert.deepEqual(ids(listed), ["orx-doomed"], "FG-576: an operator read of a deleted project never throws or empties");
  assert.equal(listed[0]!.projectAttribution?.kind, "unproven", "nothing can be proven about a path that is gone");
  assert.deepEqual(ids(listOrchestratorReceiptsAuthorizedForProject(doomed, 200, {})), []);
  assert.throws(
    () => markOrchestratorReceiptRunning("orx-doomed", {}, { project: doomed }),
    (e: unknown) => e instanceof OrchestratorReceiptAuthorityError && e.reason === "unproven-target",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. NEGATIVE CONTROL (AC7)
// ═══════════════════════════════════════════════════════════════════════════

test("distinct physical directories stay distinct, including when their lexical paths share a prefix", () => {
  persistPendingOrchestratorReceipt({ ...DECISION, receiptId: "orx-a", projectDir: checkoutA });
  persistPendingOrchestratorReceipt({ ...DECISION, receiptId: "orx-sibling", projectDir: checkoutASibling });
  persistPendingOrchestratorReceipt({ ...DECISION, receiptId: "orx-b", projectDir: checkoutB });

  assert.deepEqual(ids(listOrchestratorReceiptsForProject(checkoutA)), ["orx-a"], "`checkout-a` is not `checkout-a-sibling`");
  assert.deepEqual(ids(listOrchestratorReceiptsForProject(checkoutASibling)), ["orx-sibling"]);
  assert.deepEqual(ids(listOrchestratorReceiptsForProject(checkoutB)), ["orx-b"]);
  assert.deepEqual(ids(listOrchestratorReceiptsForProject(base)), [], "and a parent is never widened into its children");
});

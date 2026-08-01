// FG-548: the construction guard. A write transaction that BEGINs DEFERRED and
// then upgrades to a writer is the SQLITE_BUSY bug — busy_timeout cannot rescue a
// stale read snapshot. The fix only stays fixed if a new deferred write txn can't
// be added without failing the suite, so this test is the enforcement, not the
// convention.
//
// The rule, repo-wide: every `.transaction(` in src/ must be terminated by
// `.immediate()` (BEGIN IMMEDIATE) or `.deferred()` (an explicit declaration that
// the txn only READS — taking the write lock to read is a pessimization). Anything
// else must route through writeTransaction() in db.ts, which is immediate by
// construction. This generalizes FG-425's publications.ts-only guard.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction, getDb } from "./db.js";
import { insertRun, completeRun } from "./runs.js";
import { nowIso } from "../util/ids.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Source with comment bodies and string/template CONTENT removed, so a
 *  `.transaction(` or `.immediate()` written inside a comment or a string can
 *  neither trip the guard nor excuse a real offender. Template EXPRESSIONS
 *  (`${...}`) keep their code — a transaction can't hide in one, but a stray
 *  paren in one would otherwise unbalance the site scan below. */
export function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;
  // Backtick nesting: `a ${ `b` } c` is legal, so template state is a stack.
  const templates: boolean[] = [];
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < source.length && source[i] !== c) i += source[i] === "\\" ? 2 : 1;
      i++;
      out += '""';
      continue;
    }
    if (c === "`") {
      // Skip template text, but step back INTO code at each ${...}.
      i++;
      out += '""';
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === "`") { i++; break; }
        if (source[i] === "$" && source[i + 1] === "{") {
          templates.push(true);
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "}" && templates.length > 0) {
      // Close the ${...} expression and resume skipping the template's text.
      templates.pop();
      i++;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === "`") { i++; break; }
        if (source[i] === "$" && source[i + 1] === "{") {
          templates.push(true);
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Index just past the `(` that closes the call opened at `open`, or -1 if the
 *  parens never balance (which the guard treats as undeclared — it fails closed). */
function closeOf(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** The guard itself. Returns the number of `.transaction(...)` CALL SITES in
 *  `source` that are not immediately terminated by `.immediate()` or
 *  `.deferred()` — i.e. sites that get better-sqlite3's silent deferred default.
 *
 *  Per-SITE, deliberately, not a count of `.transaction(` minus a count of
 *  declarations: a tally is defeated by any stray `.immediate()` token elsewhere
 *  in the file (a string, an unrelated method) silently cancelling out a real
 *  deferred write txn. The declaration must be attached to the site it declares. */
export function unmarkedTransactions(source: string): number {
  const code = stripCommentsAndStrings(source);
  let unmarked = 0;
  for (const m of code.matchAll(/\.transaction\s*\(/g)) {
    const close = closeOf(code, m.index + m[0].length - 1);
    if (close < 0 || !/^\s*\.\s*(immediate|deferred)\s*\(\s*\)/.test(code.slice(close + 1))) unmarked++;
  }
  return unmarked;
}

/** How many `.transaction(...)` call sites the guard can SEE in `source`. A
 *  stripping bug that swallowed real code would show up here as sites going
 *  missing — an unmarked count of 0 would otherwise look like compliance. */
export function transactionSites(source: string): number {
  return [...stripCommentsAndStrings(source).matchAll(/\.transaction\s*\(/g)].length;
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

test("FG-548 (guard): no source file in src/ opens a transaction without declaring immediate or deferred", () => {
  const offenders: string[] = [];
  for (const file of tsFilesUnder(SRC)) {
    const unmarked = unmarkedTransactions(readFileSync(file, "utf8"));
    if (unmarked > 0) offenders.push(`${relative(SRC, file)} (${unmarked})`);
  }
  assert.deepEqual(
    offenders,
    [],
    `these files open a transaction with better-sqlite3's DEFERRED default: ${offenders.join(", ")}. ` +
      "Under multi-process WAL a deferred txn that reads and then writes throws SQLITE_BUSY the instant another " +
      "process has committed — busy_timeout does not apply to a snapshot upgrade (FG-548). Route the write through " +
      "writeTransaction() in store/db.ts (BEGIN IMMEDIATE), or, if the txn genuinely only READS, say so with an " +
      "explicit .deferred().",
  );
});

test("FG-548 (guard fires): the guard catches a deferred write txn, and passes the safe forms", () => {
  assert.equal(
    unmarkedTransactions(`const { applied } = getDb().transaction(() => {
      const prev = getDb().prepare("SELECT status FROM runs WHERE id = ?").get(id);
      getDb().prepare("UPDATE runs SET status = 'complete' WHERE id = ?").run(id);
      return { applied: true, prev };
    })();`),
    1,
    "the exact shape of the FG-548 bug (completeRun's original read-then-write) must be caught",
  );

  assert.equal(unmarkedTransactions(`writeTransaction(() => { db.prepare("UPDATE runs SET status = 'complete'").run(); });`), 0);
  assert.equal(unmarkedTransactions(`db.transaction(() => { ins.run(row); }).immediate();`), 0);
  assert.equal(unmarkedTransactions(`db.transaction(() => rows.map(read)).deferred();`), 0);
  assert.equal(
    unmarkedTransactions(`// getDb().transaction(() => {}) in a comment is not code\n/* nor getDb().transaction( here */`),
    0,
    "comments describing the old shape must not trip the guard",
  );
});

test("FG-548: writeTransaction is the shared helper the store's write paths route through", () => {
  const db = readFileSync(join(SRC, "store", "db.ts"), "utf8");
  assert.match(stripCommentsAndStrings(db), /export function writeTransaction[\s\S]*\.transaction\(fn\)\.immediate\(\)/);

  for (const file of ["runs.ts", "model-calls.ts"]) {
    const source = stripCommentsAndStrings(readFileSync(join(SRC, "store", file), "utf8"));
    assert.doesNotMatch(source, /\.transaction\(/, `${file} must not open a raw transaction — use writeTransaction()`);
    assert.match(source, /writeTransaction\(/, `${file} still has write transactions; they must route through the helper`);
  }
});

// FG-654 RF-12: BEGIN IMMEDIATE only protects a read-modify-write if the READ is
// inside it. `lens_outcomes_json` is a whole column three writers now serialize
// wholesale, and recordAgentProtocol appends on a coordinator/background path: with the
// read taken before the transaction, a concurrent `forge review accept-lens` landing in
// the window is blindly overwritten by the stale array — a reviewer-authored outcome or
// an operator acceptance dropped to record an INDEX of one. Single-threaded tests cannot
// interleave two writers on one connection, so the guard is over the construction.
test("FG-654 RF-12: recordAgentProtocol takes its lens_outcomes_json READ inside the write transaction", () => {
  const source = stripCommentsAndStrings(readFileSync(join(SRC, "store", "reviews.ts"), "utf8"));
  const start = source.indexOf("export function recordAgentProtocol");
  assert.ok(start > 0, "recordAgentProtocol must still exist — if it was renamed, update this guard");
  const end = source.indexOf("export function", start + 1);
  const body = source.slice(start, end > 0 ? end : undefined);

  const txn = body.indexOf("writeTransaction(");
  const read = body.indexOf("getReview(");
  assert.ok(txn > 0, "the append must still run in a write transaction");
  assert.ok(read > txn, "the read must be INSIDE writeTransaction, not before it — a read outside the write lock is the lost update");
});

// ── can the guard itself be defeated? ────────────────────────────────────────
//
// The guard is the only thing stopping a new deferred write txn from landing, so
// it is load-bearing code and gets the same adversarial treatment as the fix.
//
// The defeat that matters: the guard used to be a TALLY — count `.transaction(`,
// subtract every `.immediate()`/`.deferred()` token in the file. Any stray token
// anywhere (in a string, on an unrelated object, attached to a DIFFERENT
// transaction) silently paid for a real deferred write txn and the guard went
// green. It is now a per-SITE scan: each `.transaction(...)` call carries its own
// declaration or it is reported. These are what keep it that way.

describe("guard, adversarial", () => {
  test("FG-548 (guard, adversarial): a declaration in a STRING cannot excuse a real deferred write txn", () => {
    assert.equal(
      unmarkedTransactions(`
        const HINT = "write transactions must end in .immediate()";
        const applied = getDb().transaction(() => {
          const prev = getDb().prepare("SELECT status FROM runs WHERE id = ?").get(id);
          getDb().prepare("UPDATE runs SET status = 'complete' WHERE id = ?").run(id);
          return prev;
        })();
      `),
      1,
      "a .immediate() inside a string literal must not count as a declaration",
    );

    assert.equal(
      unmarkedTransactions("const HINT = `use .deferred() for reads`;\ndb.transaction(() => ins.run(row))();"),
      1,
      "…nor one inside a template literal",
    );

    assert.equal(
      unmarkedTransactions(`
        // Route writes through writeTransaction() — never .immediate() by hand.
        db.transaction(() => ins.run(row))();
      `),
      1,
      "…nor one inside a comment",
    );
  });

  test("FG-548 (guard, adversarial): a declaration on an UNRELATED call cannot excuse a deferred write txn", () => {
    assert.equal(
      unmarkedTransactions(`
        scheduler.immediate();
        db.transaction(() => ins.run(row))();
      `),
      1,
      "an .immediate() on some other object is not a transaction declaration",
    );

    assert.equal(
      unmarkedTransactions(`
        db.transaction(() => ins.run(a)).immediate();
        db.transaction(() => ins.run(b))();
      `),
      1,
      "a declared transaction elsewhere in the file must not cover an undeclared one",
    );

    assert.equal(
      unmarkedTransactions(`
        db.transaction(() => ins.run(a))();
        db.transaction(() => ins.run(b))();
        db.transaction(() => ins.run(c)).immediate();
      `),
      2,
      "every undeclared site is reported, not just the first",
    );
  });

  test("FG-548 (guard, adversarial): a DETACHED declaration does not count — it must be attached to the site", () => {
    // `const tx = db.transaction(fn)` hands the transaction around as a value and
    // the guard cannot follow it, so it must not assume the best. Fails closed:
    // route it through writeTransaction(), or declare it at the site.
    assert.equal(
      unmarkedTransactions(`
        const tx = db.transaction(() => ins.run(row));
        tx.immediate();
      `),
      1,
      "a declaration reached through a variable is not something the guard can verify",
    );
  });

  test("FG-548 (guard, adversarial): the safe forms still pass — the hardening does not cry wolf", () => {
    assert.equal(unmarkedTransactions(`return getDb().transaction(fn).immediate();`), 0);
    assert.equal(
      unmarkedTransactions(`
        const applied = db.transaction((): LaneEntry => {
          const row = read(db, "SELECT (1)");    // parens and quotes in the body
          ins.run(\`lane \${row.id} (queued\`);    // an unbalanced "(" inside a template
          return row;
        }).immediate();
      `),
      0,
      "a multi-line, generic-typed, template-carrying body must not confuse the site scan",
    );
    assert.equal(
      unmarkedTransactions("db\n  .transaction(() => ins.run(row))\n  .immediate();"),
      0,
      "the declaration may sit on its own line",
    );
    assert.equal(unmarkedTransactions(`db.transaction(fn) .immediate() ;`), 0);
    assert.equal(unmarkedTransactions(`writeTransaction(() => ins.run(row));`), 0, "the helper is the sanctioned form");
    assert.equal(unmarkedTransactions(`db.transaction(() => rows.map(read)).deferred();`), 0, "an explicit read-only declaration is allowed");
  });

  test("FG-548 (guard, adversarial): the stripper does not swallow real code — the transaction sites in src/ are still SEEN", () => {
    // A stripping bug that ate part of a file would make offenders vanish and turn
    // the repo-wide test green for the wrong reason. Pin the floor.
    assert.equal(
      transactionSites(readFileSync(join(SRC, "store", "db.ts"), "utf8")),
      3,
      "db.ts has three sites: the writeTransaction helper, the FG-563 dispatch-key convergence, and the FG-608 ticket_events shape rebuild (all .immediate())",
    );
    assert.ok(
      transactionSites(readFileSync(join(SRC, "store", "publications.ts"), "utf8")) >= 8,
      "publications.ts's FG-425 immediate transactions must still be visible to the guard",
    );
    const seen = tsFilesUnder(SRC).reduce((n, f) => n + transactionSites(readFileSync(f, "utf8")), 0);
    assert.ok(seen >= 9, `the guard sees only ${seen} transaction sites across src/ — the stripper is eating code`);

    const stripped = stripCommentsAndStrings("const msg = `run ${db.transaction(fn).immediate()} done`;");
    assert.match(stripped, /\.transaction\(fn\)\.immediate\(\)/, "code inside a ${...} expression is code, and must survive stripping");
    assert.equal(unmarkedTransactions("const msg = `run ${db.transaction(fn)} done`;"), 1, "…so a deferred txn cannot hide in one");
  });

  test("FG-548 (guard, boundary): the guard checks CONSTRUCTION, not honesty — .deferred() is a claim it trusts", () => {
    // `.deferred()` means "this transaction only READS". Nothing static can tell a
    // truthful declaration from a lying one, so the guard takes the author at their
    // word — and this test watches the word: no file in src/ declares one today, and
    // a new one has to be argued for here rather than slipped in.
    assert.equal(unmarkedTransactions(`db.transaction(() => ins.run(row)).deferred();`), 0);

    const deferredUsers = tsFilesUnder(SRC)
      .filter((f) => /\.deferred\(\)/.test(stripCommentsAndStrings(readFileSync(f, "utf8"))))
      .map((f) => relative(SRC, f));
    // THE ARGUMENT FOR THE ONE ENTRY BELOW (FG-608 F8). buildSnapshot reads
    // tickets, ticket_relations and blocker_evidence and writes NOTHING to that
    // connection — every INSERT it performs goes to a SEPARATE output database
    // handle, opened on the file it is building. Un-transacted, its three SELECTs
    // could each observe a different committed state and publish an artifact that
    // mixes them (a ticket whose 'blocked' status lost the blocker_evidence row
    // that justified it). Read-only is exactly what makes .deferred() correct here:
    // BEGIN IMMEDIATE would take the write lock for the duration of a read that
    // runs on the tail of every ticket write.
    assert.deepEqual(
      deferredUsers,
      ["backlog/snapshot.ts"],
      `these files declare a .deferred() transaction: ${deferredUsers.join(", ")}. That declaration claims the txn ONLY ` +
        "READS, which the guard cannot verify. If it's true, keep it and update this test; if the txn writes, it is the " +
        "FG-548 bug wearing a label.",
    );
  });
});

// ── :memory: behavior is unchanged (acceptance criterion 3) ──────────────────
// A single-connection in-memory DB has nothing to contend with — SQLite's
// BEGIN IMMEDIATE takes the write lock uncontested, so semantics and cost are
// the same as the deferred default. These assert exactly that.
describe(":memory:", () => {
  let db: DatabaseInstance;
  let prev: DatabaseInstance | null;

  beforeEach(() => {
    db = makeInMemoryDb();
    prev = setDbForTest(db);
  });

  afterEach(() => {
    setDbForTest(prev as DatabaseInstance);
    db.close();
  });

  test("FG-548 (:memory:): writeTransaction commits, returns its value, and rolls back on throw", () => {
    insertRun({ id: "r1", workflow: "feature", title: "t", status: "active", createdAt: nowIso() });

    const value = writeTransaction(() => {
      getDb().prepare(`UPDATE runs SET title = 'committed' WHERE id = 'r1'`).run();
      return 42;
    });
    assert.equal(value, 42);
    assert.equal((getDb().prepare(`SELECT title FROM runs WHERE id = 'r1'`).get() as { title: string }).title, "committed");

    assert.throws(() =>
      writeTransaction(() => {
        getDb().prepare(`UPDATE runs SET title = 'rolled-back' WHERE id = 'r1'`).run();
        throw new Error("boom");
      }),
    );
    assert.equal((getDb().prepare(`SELECT title FROM runs WHERE id = 'r1'`).get() as { title: string }).title, "committed");
  });

  test("FG-548 (:memory:): completeRun's CAS behavior is unchanged by BEGIN IMMEDIATE", () => {
    insertRun({ id: "r2", workflow: "feature", title: "t", status: "active", createdAt: nowIso() });
    assert.equal(completeRun("r2"), true, "the first completion applies");
    assert.equal(completeRun("r2"), false, "a redundant re-completion is still refused");
  });

  test("FG-548 (:memory:): immediate write txns are not meaningfully slower on a single connection", () => {
    for (let i = 0; i < 200; i++) {
      insertRun({ id: `perf-${i}`, workflow: "feature", title: "t", status: "active", createdAt: nowIso() });
    }
    const started = Date.now();
    for (let i = 0; i < 200; i++) completeRun(`perf-${i}`);
    assert.ok(Date.now() - started < 2000, "200 immediate write txns on :memory: should be near-instant");
  });
});

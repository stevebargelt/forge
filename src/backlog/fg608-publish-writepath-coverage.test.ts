// FG-608 (acceptance 2): PUBLISHER OWNERSHIP, enforced rather than conventional.
//
// This is the test the architecture-gate red finding demanded: "the proposed
// push-snapshot design leaves the only mechanism that can satisfy post-start
// amendment visibility unowned and unspecified". A write path that forgets to
// publish leaves a running container SILENTLY STALE — the exact failure mode the
// mandate exists to prevent. So the wiring is asserted by scanning the source, and
// this test FAILS when someone adds a new authoritative ticket write without it.
//
// Unit tier: pure source scanning, no subprocess, no clock, no DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

const TICKETS_TS = SRC("../store/tickets.ts");
const STRUCTURED_TS = SRC("./structured.ts");
const IMPORT_TS = SRC("../store/backlog-import.ts");
const DB_TS = SRC("../store/db.ts");

/** Split a TypeScript module into top-level exported function bodies, by brace
 *  depth. Crude on purpose: it needs to be obviously correct at a glance, and the
 *  files it scans are ordinary top-level function declarations. */
function exportedFunctionBodies(path: string): Map<string, string> {
  const src = readFileSync(path, "utf8");
  const lines = src.split("\n");
  const out = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^export function (\w+)/.exec(lines[i]!);
    if (!m) continue;
    let depth = 0;
    let started = false;
    const body: string[] = [];
    for (let j = i; j < lines.length; j++) {
      const line = lines[j]!;
      body.push(line);
      for (const ch of line) {
        if (ch === "{") {
          depth++;
          started = true;
        } else if (ch === "}") depth--;
      }
      if (started && depth === 0) break;
    }
    out.set(m[1]!, body.join("\n"));
  }
  return out;
}

// Every statement that MUTATES a backlog table. If a function in tickets.ts runs
// one of these, it is an authoritative ticket write path and must publish.
const MUTATION_RE =
  /(INSERT INTO|UPDATE|DELETE FROM)\s+(tickets|ticket_relations|ticket_events|blocker_evidence)\b/i;

// Writers that are deliberately NOT publication points, each with its reason.
// Listed by NAME so adding a new writer cannot silently inherit an exemption.
const EXEMPT: Record<string, string> = {
  // Membership/provenance bookkeeping — it changes no ticket CONTENT a container
  // could read, and it is always immediately followed by a content write in the
  // same transaction (whose publication covers it).
  replaceSourceMembership: "membership bookkeeping only; no container-visible content changes",
  recordMembership: "membership bookkeeping only; no container-visible content changes",
  // Records WHICH revision was dispatched. It is evidence about a container, not
  // ticket content, and publishing on it would be a self-referential loop
  // (spawn.ts publishes, then records evidence, which would publish again).
  recordDispatchEvidence: "dispatch evidence is about a task, not ticket content",
};

test("FG-608 publisher ownership: every authoritative ticket write in tickets.ts publishes", () => {
  const fns = exportedFunctionBodies(TICKETS_TS);
  assert.ok(fns.size > 10, `precondition: the scanner found functions in tickets.ts (got ${fns.size})`);

  const writers = [...fns].filter(([, body]) => MUTATION_RE.test(body));
  assert.ok(
    writers.length >= 7,
    `precondition: the scanner found the known ticket writers (got ${writers.length}). If this ` +
      `dropped, the scan stopped guarding and would pass vacuously.`,
  );

  const missing = writers
    .filter(([name]) => !(name in EXEMPT))
    .filter(([, body]) => !body.includes("markBacklogDirty("))
    .map(([name]) => name);

  assert.deepEqual(
    missing,
    [],
    `these authoritative ticket write paths do NOT publish a snapshot. A container holding a ` +
      `read-only mount would keep reading the pre-write state with no indication anything changed. ` +
      `Call markBacklogDirty(projectKey) at the end of each, or add it to EXEMPT with the reason it ` +
      `changes nothing a container can read.`,
  );

  // The known write set, spelled out. A rename that silently drops one from the
  // scan would otherwise pass.
  for (const expected of [
    "upsertTicket",
    "upsertSeamTicket",
    "upsertTicketRelation",
    "deleteTicketRelations",
    "upsertTicketEvent",
    "upsertBlockerEvidence",
    "deleteBlockerEvidence",
    "deleteTicketRow",
    "deleteTicketRelation",
  ]) {
    const body = fns.get(expected);
    assert.ok(body, `expected ticket writer ${expected} to exist in tickets.ts`);
    assert.ok(body!.includes("markBacklogDirty("), `${expected} must publish`);
  }
});

test("FG-608 publisher ownership: the seam's writers all funnel through the store writers", () => {
  // The structured.ts seam is where writeTicket / closeTicket / retitleTicket /
  // moveTicket / fillClosedCommit / fileNewTicket live. None of them may write the
  // tickets table directly — they go through writeTicketRow, which calls
  // upsertSeamTicket (covered above). A direct SQL write here would bypass
  // publication entirely.
  const src = readFileSync(STRUCTURED_TS, "utf8");
  assert.ok(src.length > 0);
  assert.equal(
    MUTATION_RE.test(src),
    false,
    "structured.ts must not contain raw ticket-table SQL — every write goes through store/tickets.ts",
  );
  for (const seamWriter of [
    "writeTicket",
    "closeTicket",
    "retitleTicket",
    "moveTicket",
    "fillClosedCommit",
    "fileNewTicket",
  ]) {
    assert.match(
      src,
      new RegExp(`export function ${seamWriter}\\b`),
      `seam writer ${seamWriter} must still exist (if it was renamed, update this coverage list)`,
    );
  }
  assert.match(src, /function writeTicketRow\b/, "the single db write path must still exist");
  assert.match(src, /upsertSeamTicket\(/, "writeTicketRow must still go through the publishing writer");
});

test("FG-608 publisher ownership: importBacklog writes only through the publishing store writers", () => {
  const src = readFileSync(IMPORT_TS, "utf8");
  assert.ok(src.length > 0);
  assert.equal(
    MUTATION_RE.test(src),
    false,
    "backlog-import.ts must not contain raw ticket-table SQL — every write goes through store/tickets.ts",
  );
});

test("FG-608 publisher ownership: the publish barrier is installed and post-commit", () => {
  const dbSrc = readFileSync(DB_TS, "utf8");
  assert.match(dbSrc, /beginPublishBarrier\(\)/, "writeTransaction must open the barrier");
  assert.match(dbSrc, /endPublishBarrier\(committed\)/, "and close it with the commit outcome");
  // Ordering matters: publication must be OUTSIDE the transaction. Assert the
  // barrier close is in a finally block after the transaction call, not inside fn.
  const idxTxn = dbSrc.indexOf("getDb().transaction(fn).immediate()");
  const idxEnd = dbSrc.indexOf("endPublishBarrier(committed)");
  assert.ok(idxTxn > 0 && idxEnd > idxTxn, "the fan-out must run AFTER the transaction returns");

  const ticketsSrc = readFileSync(TICKETS_TS, "utf8");
  assert.match(
    ticketsSrc,
    /registerPublishBarrier\(\{\s*beginPublishBarrier,\s*endPublishBarrier\s*\}\)/,
    "store/tickets.ts must arm the barrier at module eval — importing any ticket writer arms publication",
  );
});

// FG-785 (external kanban projection, OUTBOUND-ONLY) — AC6 CREDENTIAL-EXCLUSION negative test.
//
// THREAT MODEL. A provider credential is a host secret: it authenticates Forge to an external
// kanban board. The attacker we defend against here is anyone who can read a surface the sync
// PRODUCES — a persisted row in the shared ~/.forge/forge.db, a log/error line, a run/task
// artifact, an exported debug bundle, or the redacted card content that reaches the external
// board and (via the FG-781 seal) the browser. If the credential reaches ANY of those, it has
// escaped the host edge it is supposed to live and die on. The capability this test denies the
// attacker: reading the credential out of anything the sync writes or prints.
//
// THE GUARANTEE (AC6). The credential is read ONLY at the host edge (cli-entry.readProviderCredential),
// handed to the provider factory, and dropped. The pure sync engine and the two @forge store
// accessors it writes through never see it; the FG-781 projection that produces card content never
// carries it. So a full outbound sync — create, update, archive, a retried transient fault, and a
// recorded external-drift conflict — must leave the credential absent from every surface it touches.
//
// HOW THIS PROVES IT. We seed a sentinel credential in the host env, then drive a full multi-op
// sync through the REAL credential edge (runKanbanSyncEntry, the function `forge kanban sync` shells
// into) against the deterministic FakeKanbanProvider, writing the REAL @forge store on a real
// on-disk forge.db. The provider factory records the credential it is handed — so the test is NOT
// vacuous: the edge genuinely reads the secret. We then assert the sentinel is absent from:
//   • every SyncResult (this JSON is exactly what `forge kanban sync` prints to stdout),
//   • every captured log / error line,
//   • the persisted map + conflict rows (via the accessors AND the raw forge.db bytes),
//   • the entire FORGE_HOME tree (catches any run/task artifact the sync could have written),
//   • an exported debug bundle assembled over a sync-adjacent run, and
//   • the FG-781 redaction output (which actively scrubs a credential-shaped token from free text).
// A negative-control asserts the scanner itself trips on a planted sentinel, so a broken scan can
// never pass this test green.
//
// FG-789 (RF-5). The high-entropy SENTINEL above is caught by the generic 24+-char redaction rule.
// A real Authorization header commonly carries a SHORT credential ("Bearer s3cr3tk3y") the generic
// rule cannot see; the scheme-consuming rule is what scrubs it. SHORT_BEARER exercises that path.
//
// TIER. Store-touching + process-spawning (git for the project checkout) by definition, so this is
// *.integration.test.ts, not unit.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A credential-shaped, high-entropy sentinel. Deliberately matches the FG-781 free-text redaction
// pattern (24+ chars mixing letters + digits) so we can also prove the seal would scrub it. Unique
// enough that a substring match anywhere is a real leak, never a coincidence.
const SENTINEL = "kanbanProviderSecret0Aa1Bb2Cc3Dd4Ee5Ff6Gg7";

// A SHORT credential (9 chars) — below the generic high-entropy rule's 24-char floor and carrying
// no known provider prefix, so ONLY the FG-789 Authorization/Bearer scheme-consuming rule scrubs it.
const SHORT_BEARER = "s3cr3tk3y";

// ─── FORGE_HOME / scan roots BEFORE any import that evaluates src/util/paths.ts ──────
const root = mkdtempSync(join(tmpdir(), "fg785-credleak-"));
const forgeHome = join(root, "forge-home");
mkdirSync(forgeHome, { recursive: true });
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = join(root, "scan-roots");
mkdirSync(process.env.FORGE_PROJECT_SCAN_ROOTS, { recursive: true });

// Seed the sentinel credential in the HOST ENVIRONMENT — the ONLY place a credential is meant to
// live. `forge kanban sync fake` reads FORGE_KANBAN_FAKE_TOKEN at the edge (readProviderCredential).
process.env.FORGE_KANBAN_FAKE_TOKEN = SENTINEL;

const { DB_PATH } = await import("../../../src/util/paths.js");
const { getDb } = await import("../../../src/store/db.js");
const { repositoryCheckoutIdentity } = await import("../../../src/util/repository-identity.js");
const kanban = await import("../../../src/store/kanban-projection.js");
const { insertRun } = await import("../../../src/store/runs.js");
const { insertTask } = await import("../../../src/store/tasks.js");
const { taskDir } = await import("../../../src/util/paths.js");
const { assembleBundle } = await import("../../../src/v2/bundle.js");
const { projectsForDashboard } = await import("../queries.js");
const { assembleRemoteBoard, redactRemoteFreeText } = await import("../remote/projection.js");
const { FakeKanbanProvider } = await import("./fake-provider.js");
const { readProviderCredential, runKanbanSyncEntry } = await import("./cli-entry.js");
const { syncBoardOutbound } = await import("./sync.js");
import type { RemoteBoard } from "../remote/projection.js";
import type { KanbanProvider } from "./adapter.js";
import type { KanbanSyncStore, SyncConfig, SyncResult } from "./sync.js";
import type { ProviderFactory } from "./cli-entry.js";

// ─── a project the FG-781 projection can assemble a real board for ───────────────────

const AT = "2026-09-08T00:00:00Z";
const trees = join(root, "trees");
mkdirSync(trees, { recursive: true });

function checkout(name: string, remote: string): string {
  const dir = join(trees, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, stdio: "ignore" });
  return realpathSync(dir);
}

const projDir = checkout("alpha", "git@github.com:example/fg785-credleak.git");
const REPO_KEY = repositoryCheckoutIdentity(projDir).key;
const PK = "pk-fg785-credleak";

// The real @forge store port (single getDb singleton — the same module the engine writes through
// and we read back from). Injected into the edge so there is exactly one on-disk store in play.
const store: KanbanSyncStore = {
  getProjectionMap: kanban.getProjectionMap,
  listProjectionMap: kanban.listProjectionMap,
  upsertProjectionMap: kanban.upsertProjectionMap,
  insertConflict: kanban.insertConflict,
  getConflict: kanban.getConflict,
};

const syncConfig: Partial<Pick<SyncConfig, "now" | "retry" | "sleep" | "projectedBy" | "detectedBy">> = {
  now: () => AT,
  retry: { maxAttempts: 4, baseDelayMs: 1, factor: 2, maxDelayMs: 5 },
  sleep: async () => {},
  projectedBy: "kanban-sync",
  detectedBy: "kanban-sync",
};

function assembleBoard(): RemoteBoard {
  const project = projectsForDashboard().find((p) => p.key === REPO_KEY);
  assert.ok(project, "the seeded project must resolve from the dashboard registry");
  const envelope = assembleRemoteBoard({ project: project!, memberDirs: project!.projectDirs });
  assert.ok(envelope.board, "a live board is assembled");
  return envelope.board!;
}

/** Clone a board and drop one backlog ticket (drives an ARCHIVE — the ticket left the board). */
function boardWithout(board: RemoteBoard, ticketId: string): RemoteBoard {
  const clone = structuredClone(board);
  clone.backlog.tickets = clone.backlog.tickets.filter((t) => t.id !== ticketId);
  return clone;
}

/** Clone a board and retitle one backlog ticket (drives an UPDATE — the content hash changes). */
function boardRetitled(board: RemoteBoard, ticketId: string, title: string): RemoteBoard {
  const clone = structuredClone(board);
  const ticket = clone.backlog.tickets.find((t) => t.id === ticketId);
  assert.ok(ticket, `ticket ${ticketId} must be on the board to retitle`);
  ticket!.title = title;
  return clone;
}

// ─── aftermath collected once, asserted by many tests ───────────────────────────────

let board0: RemoteBoard;
let projectArg: string;
const syncResults: SyncResult[] = [];
const capturedLogs: string[] = [];
const seenCredentials: Array<string | undefined> = [];
let bundleRoot: string;
let bundleDir: string;

before(async () => {
  // A fresh production open materializes the full real schema (both FG-785 tables + the full
  // runs/tasks tables the bundle reads). Migration safety is step 4's proof; here we want a clean
  // real store to scan. Seed a project + three active tickets so the FG-781 board is genuine.
  const db = getDb();
  db.prepare(
    `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,'remote',?)`,
  ).run(PK, REPO_KEY, AT);
  db.prepare(`INSERT INTO ticket_storage_mode (project_key, mode, updated_at) VALUES (?,?,?)`).run(PK, "db", AT);
  const insertTicket = db.prepare(
    `INSERT INTO tickets (project_key,ticket_id,type,status,title,body,created,closed,closed_commit,epic,frontmatter,imported_at,imported_from)
     VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?,NULL,?,NULL)`,
  );
  insertTicket.run(PK, "FG-A1", "story", "active", "Alpha one", "body one", null, AT);
  insertTicket.run(PK, "FG-A2", "story", "active", "Alpha two", "body two", null, AT);
  insertTicket.run(PK, "FG-A3", "story", "active", "Alpha three", "body three", null, AT);

  // A run whose project_dir is the seeded checkout registers the project with the dashboard
  // registry (its checkout exists on disk), so projectsForDashboard resolves it and the FG-781
  // board assembles. This same run is the sync-adjacent run the debug bundle is exported over.
  insertRun({ id: "run-kanban-sync", workflow: "feature", title: "kanban outbound sync run", status: "complete", createdAt: AT, projectDir: projDir });

  board0 = assembleBoard();
  projectArg = board0.projectSummary.projectKey; // the edge keys the sync to the board's own project
  assert.ok(board0.backlog.tickets.length >= 3, "the seeded board carries the three tickets");

  // ONE persistent fake across every pass (cross-pass convergence lives in the durable map table).
  // The factory records the credential the edge hands it — the non-vacuous proof the secret is read.
  const fake = new FakeKanbanProvider({ name: "fake" });
  const factories: Record<string, ProviderFactory> = {
    fake: ({ credential }): KanbanProvider => {
      seenCredentials.push(credential);
      return fake;
    },
  };

  const runOnce = (boardSource: () => RemoteBoard): Promise<SyncResult> =>
    runKanbanSyncEntry(
      { project: projectArg, provider: "fake" },
      { boardSource, providerFactories: factories, store, config: syncConfig },
    );

  // Capture EVERY log/error surface for the duration of the full sync. runKanbanSyncEntry and the
  // pure engine are quiet by design, so this is defensive — but a future log line that echoed the
  // credential would be caught here. Tee to the originals so the test reporter still prints.
  const origConsole = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const record =
    (orig: (...a: never[]) => unknown) =>
    (...args: unknown[]): boolean => {
      capturedLogs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      return (orig as (...a: unknown[]) => boolean)(...args);
    };
  console.log = record(origConsole.log as never) as never;
  console.error = record(origConsole.error as never) as never;
  console.warn = record(origConsole.warn as never) as never;
  console.info = record(origConsole.info as never) as never;
  (process.stdout as { write: unknown }).write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    capturedLogs.push(String(chunk));
    return (origOut as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as never;
  (process.stderr as { write: unknown }).write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    capturedLogs.push(String(chunk));
    return (origErr as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as never;

  try {
    // P1 — CREATE (with a retried TRANSIENT fault). Inject a fault so the first outbound op retries.
    fake.injectFault({ kind: "transient", message: "injected transient fault" });
    syncResults.push(await runOnce(() => board0));

    // P2 — UPDATE FG-A1 (retitle → its content hash changes; A2/A3 skip as unchanged).
    const p2Board = boardRetitled(board0, "FG-A1", "Alpha one — revised");
    syncResults.push(await runOnce(() => p2Board));

    // P3 — ARCHIVE FG-A2 (it leaves the board; A1 keeps its P2 title so it skips).
    const p3Board = boardWithout(p2Board, "FG-A2");
    syncResults.push(await runOnce(() => p3Board));

    // P4 — CONFLICT on FG-A3 (an external actor moves the card out of band; the engine records a
    // conflict carrying both versions and applies NOTHING).
    const a3 = fake.snapshot().find((c) => c.identity.ticketId === "FG-A3");
    assert.ok(a3, "FG-A3 must have been projected as a card");
    fake.externallyMove(a3!.externalId, "done");
    syncResults.push(await runOnce(() => p3Board));
  } finally {
    console.log = origConsole.log;
    console.error = origConsole.error;
    console.warn = origConsole.warn;
    console.info = origConsole.info;
    (process.stdout as { write: unknown }).write = origOut;
    (process.stderr as { write: unknown }).write = origErr;
  }

  // An EXPORTED DEBUG BUNDLE over the sync-adjacent run — the bundle surface AC6 names.
  insertTask({
    id: "task-sync-1",
    runId: "run-kanban-sync",
    phase: "build",
    agentRole: "backend",
    status: "complete",
    taskPackage: { taskId: "task-sync-1", runId: "run-kanban-sync", phase: "build", role: "backend", inputs: {}, composedSystemPrompt: "" },
    createdAt: AT,
  });
  const tdir = taskDir("run-kanban-sync", "task-sync-1");
  mkdirSync(tdir, { recursive: true });
  writeFileSync(join(tdir, "result.json"), JSON.stringify({ status: "complete", diff_summary: "kanban outbound sync" }));
  bundleRoot = mkdtempSync(join(tmpdir(), "fg785-credleak-bundle-"));
  bundleDir = assembleBundle("run-kanban-sync", bundleRoot).bundleDir;
});

// ─── scan helpers ────────────────────────────────────────────────────────────────

/** The single point of truth for "did the sentinel leak here". Read as bytes (latin1) so no
 *  encoding hides an occurrence. */
function containsSentinel(text: string): boolean {
  return text.includes(SENTINEL);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

// ─── non-vacuous: the edge really reads the secret ──────────────────────────────────

test("AC6 (non-vacuous): the host edge reads the sentinel credential from the environment", () => {
  // If the edge did NOT read the credential, every absence assertion below would be trivially
  // true. Prove the subject is real: the reader returns it, and the factory was handed it.
  assert.equal(readProviderCredential("fake"), SENTINEL, "readProviderCredential reads the host env var");
  assert.ok(seenCredentials.length >= 4, "the edge invoked the provider factory once per sync pass");
  assert.ok(
    seenCredentials.every((c) => c === SENTINEL),
    "the edge handed the real credential to the provider factory on every pass",
  );
});

// ─── the sync genuinely exercised every op (so the absence assertions mean something) ─

test("AC6 (coverage): the driven sync exercised create, retry, update, archive, and conflict", () => {
  const [p1, p2, p3, p4] = syncResults;
  assert.equal(p1!.created, 3, "P1 created a card per board ticket");
  assert.ok(
    p1!.outcomes.some((o) => (o.attempts ?? 0) >= 2),
    "P1 retried the injected transient fault (an outbound op took >1 attempt)",
  );
  assert.equal(p2!.updated, 1, "P2 updated the retitled ticket");
  assert.equal(p3!.archived, 1, "P3 archived the ticket that left the board");
  assert.equal(p4!.conflicts, 1, "P4 recorded the external-move conflict");

  // The conflict is OPEN in the real store and carries BOTH versions — a persisted surface we scan.
  const open = kanban.listOpenConflicts({ projectIdentity: projectArg, provider: "fake" });
  assert.equal(open.length, 1, "the external move is one open conflict in the real store");
  assert.ok(open[0]!.forgeVersion && open[0]!.externalVersion, "both versions were recorded");
});

// ─── the sentinel is absent from every surface the sync produces ────────────────────

test("AC6: the sentinel is absent from every SyncResult (the exact JSON `forge kanban sync` prints)", () => {
  for (const [i, res] of syncResults.entries()) {
    assert.ok(!containsSentinel(JSON.stringify(res)), `sync pass ${i + 1} result carries no credential`);
  }
});

test("AC6: the sentinel is absent from every captured log / error line", () => {
  const joined = capturedLogs.join("\n");
  assert.ok(!containsSentinel(joined), "no log/error line the sync produced echoed the credential");
});

test("AC6: the sentinel is absent from the persisted map + conflict rows (via the accessors)", () => {
  const rows = kanban.listProjectionMap(projectArg, "fake");
  assert.ok(rows.length >= 3, "the sync persisted the identity map rows");
  assert.ok(!containsSentinel(JSON.stringify(rows)), "no projected map row carries the credential");

  // Every conflict, open or resolved — read the row directly and scan its full payload.
  const conflicts = kanban.listOpenConflicts({ projectIdentity: projectArg, provider: "fake" });
  assert.ok(!containsSentinel(JSON.stringify(conflicts)), "no conflict row carries the credential");
});

test("AC6: the sentinel is absent from the raw forge.db bytes and the whole FORGE_HOME tree", () => {
  // The strongest persisted-surface check: scan the on-disk store byte-for-byte, then every file
  // anywhere under FORGE_HOME — catching any run/task artifact the sync could have written.
  assert.ok(!containsSentinel(readFileSync(DB_PATH, "latin1")), "the credential is not in the forge.db bytes");
  for (const file of walk(forgeHome)) {
    assert.ok(!containsSentinel(readFileSync(file, "latin1")), `the credential leaked into a FORGE_HOME artifact: ${file}`);
  }
});

test("AC6: the sentinel is absent from an exported debug bundle assembled over a sync-adjacent run", () => {
  const files = walk(bundleDir);
  assert.ok(files.length > 0, "the bundle materialized files to scan");
  for (const file of files) {
    assert.ok(!containsSentinel(readFileSync(file, "latin1")), `the credential leaked into the bundle: ${file}`);
  }
});

test("AC6: the FG-781 redaction seal scrubs a credential-shaped token from free text", () => {
  // The card content that reaches the external board (and, via the seal, the browser) is redacted.
  // The board the sync projected carries no credential — and even if a credential-shaped token ever
  // reached a free-text field, the seal scrubs it, so the redaction OUTPUT never carries it.
  assert.ok(!containsSentinel(JSON.stringify(board0)), "the projected board carries no credential");
  const redacted = redactRemoteFreeText(`external card note ${SENTINEL} trailing`);
  assert.ok(!containsSentinel(redacted), "redactRemoteFreeText removes a credential-shaped token");
});

test("AC6/RF-4: a provider error echoing the credential is redacted before it enters the SyncResult", async () => {
  // The adapter permits arbitrary provider-supplied error text, and the engine copies it into
  // SyncResult, which cli-entry serializes verbatim to stdout. A provider (or an intermediary it
  // speaks to) that reflects the host Authorization header in an error would otherwise place the
  // credential in command output, its captured logs, and any run/task artifact. Prove it is scrubbed
  // at the engine boundary. A distinct provider name keeps these rows out of the other passes' scans.
  const provider = new FakeKanbanProvider({ name: "fake-errleak" });
  provider.injectFault({ kind: "permanent", message: `upstream 401 rejected Authorization: Bearer ${SENTINEL}` });
  const cfg: SyncConfig = {
    projectIdentity: projectArg,
    provider: "fake-errleak",
    projectedBy: "kanban-sync",
    detectedBy: "kanban-sync",
    now: () => AT,
    retry: { maxAttempts: 1, baseDelayMs: 1, factor: 2, maxDelayMs: 5 },
    sleep: async () => {},
  };
  const res = await syncBoardOutbound(board0, provider, store, cfg);

  const errored = res.outcomes.find((o) => o.action === "error");
  assert.ok(errored, "the provider's permanent error surfaced as an error outcome (non-vacuous)");
  assert.ok(errored!.message?.includes("[redacted]"), "the provider message was passed through the redactor");
  assert.ok(!containsSentinel(JSON.stringify(res)), "the credential never reaches the SyncResult printed to stdout");
});

test("AC6/RF-4/FG-789: a provider error echoing a SHORT bearer token is redacted out of the SyncResult", async () => {
  // The realistic leak: a provider (or an upstream it proxies) reflects the host Authorization
  // header in an error — "Authorization: Bearer s3cr3tk3y". The token is SHORT, so the generic
  // high-entropy rule never sees it; only the FG-789 scheme-consuming rule scrubs the scheme word
  // AND the credential. Assert it never reaches the SyncResult (the JSON `forge kanban sync` prints
  // verbatim to stdout, and the captured-log surface derived from it).
  const provider = new FakeKanbanProvider({ name: "fake-shortbearer" });
  provider.injectFault({ kind: "permanent", message: `upstream 401 rejected Authorization: Bearer ${SHORT_BEARER}` });
  const cfg: SyncConfig = {
    projectIdentity: projectArg,
    provider: "fake-shortbearer",
    projectedBy: "kanban-sync",
    detectedBy: "kanban-sync",
    now: () => AT,
    retry: { maxAttempts: 1, baseDelayMs: 1, factor: 2, maxDelayMs: 5 },
    sleep: async () => {},
  };
  const res = await syncBoardOutbound(board0, provider, store, cfg);

  const errored = res.outcomes.find((o) => o.action === "error");
  assert.ok(errored, "the provider's permanent error surfaced as an error outcome (non-vacuous)");
  assert.ok(errored!.message?.includes("[redacted]"), "the short-bearer message was passed through the redactor");
  assert.ok(!errored!.message?.includes(SHORT_BEARER), "no fragment of the short bearer token survives in the outcome");
  const serialized = JSON.stringify(res);
  assert.ok(!serialized.includes(SHORT_BEARER), "the short bearer token never reaches the SyncResult printed to stdout");
});

// ─── negative control: a broken scanner cannot pass this test green ─────────────────

test("AC6 (negative control): the scanner detects a planted sentinel", () => {
  // If containsSentinel ever stopped matching, every assertion above would pass vacuously. Prove
  // the scanner still trips on the sentinel — and does NOT trip on unrelated text.
  assert.equal(containsSentinel(`leaked -> ${SENTINEL} <- here`), true, "the scanner detects a planted sentinel");
  assert.equal(containsSentinel("no secret in this line"), false, "the scanner does not false-positive");
});

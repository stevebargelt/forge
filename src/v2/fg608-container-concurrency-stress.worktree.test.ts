// FG-608 (acceptance 3 + the concurrency AC): concurrent HOST edits are atomic to
// the CONTAINER reader — it never sees a torn row, and never a permanently stale
// dispatch-time snapshot.
//
// TWO THINGS THIS TEST REFUSES TO DO, both named in the plan as false-greens:
//
//   1. A SINGLE GREEN RUN. A race that reproduces one time in twenty passes a
//      single run trivially. This is a STRESS LOOP.
//
//   2. A SECOND CONTAINER AS THE WRITER. Container-to-container coherence proves
//      NOTHING about host-to-container coherence: /project and /task are Docker
//      Desktop virtiofs shares with separate lock managers and no guaranteed mmap
//      coherence, and FORGE-DEC-011 records this layer mutating files in ways that
//      broke host-side native SQLite. The writer here runs on the HOST, through
//      the production publication path, which is the only arrangement that
//      exercises the boundary the acceptance case is about.
//
// Tier: worktree (`npm run test:worktree`) — real docker. Skips with a NAMED
// reason when no daemon is reachable; the pure-host stress half of the property
// lives in src/backlog/fg608-snapshot-publish.integration.test.ts and does not
// stand in for this.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { upsertTicket, setStorageMode, ensureStorageMode } from "../store/tickets.js";
import { registerSnapshotTarget, SNAPSHOT_DB_BASENAME, publicationStates } from "../backlog/snapshot.js";
import { SNAPSHOT_DIR_ENV } from "../backlog/container-authority.js";
import { clearBacklogStoreCache } from "../backlog/storage-mode.js";

const PROBE_IMAGE = process.env["FORGE_TEST_DOCKER_PROBE_IMAGE"] ?? "busybox:latest";
const ITERATIONS = Number.parseInt(process.env["FG608_STRESS_ITERATIONS"] ?? "40", 10);

function dockerTry(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    return {
      ok: true,
      stdout: execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }),
      stderr: "",
    };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "" };
  }
}

function probeUnavailable(): string | undefined {
  if (!dockerTry(["info", "--format", "{{.ServerVersion}}"]).ok) return "no docker daemon reachable";
  if (dockerTry(["image", "inspect", PROBE_IMAGE]).ok) return undefined;
  const pulled = dockerTry(["pull", PROBE_IMAGE]);
  return pulled.ok ? undefined : `probe image ${PROBE_IMAGE} unavailable: ${pulled.stderr.trim()}`;
}

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const dirs: string[] = [];
const containers: string[] = [];

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  clearBacklogStoreCache();
});

afterEach(() => {
  for (const c of containers.splice(0)) dockerTry(["rm", "-f", c]);
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  clearBacklogStoreCache();
});

const KEY = "pk-stress";
const TICKET = "FG-1";
const NOW = "2026-07-29T00:00:00Z";

function newDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** An ORDINARY host ticket write. Publication happens through the production choke
 *  point (markBacklogDirty -> publishToLiveTargets); nothing here publishes. */
function hostWrite(body: string): void {
  writeTransaction(() => {
    ensureStorageMode(KEY, NOW);
    upsertTicket({
      projectKey: KEY,
      ticketId: TICKET,
      type: "story",
      status: "active",
      title: "stressed",
      body,
      importedAt: NOW,
    });
  });
}

test("FG-608 concurrency: under a STRESS LOOP the container never sees a torn or permanently-stale snapshot", (t) => {
  const unavailable = probeUnavailable();
  if (unavailable) {
    t.skip(`the container-side concurrency AC is NOT verified here — ${unavailable}`);
    return;
  }

  setStorageMode(KEY, "db", NOW);
  const snapDir = newDir("fg608-stress-");
  registerSnapshotTarget(KEY, snapDir, "task-stress");
  hostWrite("MARKER-0" + "x".repeat(256));

  const name = `fg608-stress-${process.pid}`;
  dockerTry(["rm", "-f", name]);
  containers.push(name);
  const started = dockerTry([
    "run", "-d", "--name", name,
    "-v", `${snapDir}:/forge-backlog:ro`,
    "-e", `${SNAPSHOT_DIR_ENV}=/forge-backlog`,
    PROBE_IMAGE, "sleep", "600",
  ]);
  assert.equal(started.ok, true, started.stderr);

  // A single long-lived shell in the container, re-reading the mounted artifact in
  // a tight loop while the HOST republishes. Each read reports the LAST marker it
  // can find plus a structural sanity probe (the SQLite header magic must be
  // intact at offset 0 of whatever it opened).
  let sawLatest = 0;
  let sawEarlier = 0;
  for (let i = 1; i <= ITERATIONS; i++) {
    const marker = `MARKER-${i}`;
    // Growing payload so a partially-written file is content-detectable, not just
    // structurally suspicious.
    hostWrite(marker + "x".repeat(256 + i * 64));

    const probe = dockerTry([
      "exec", name, "sh", "-c",
      `head -c 15 /forge-backlog/${SNAPSHOT_DB_BASENAME}; echo; ` +
        `grep -o 'MARKER-[0-9]*' /forge-backlog/${SNAPSHOT_DB_BASENAME} | tail -1`,
    ]);
    assert.equal(probe.ok, true, `iteration ${i}: the container could not read the mount: ${probe.stderr}`);

    const [header, seen] = probe.stdout.split("\n");
    assert.equal(
      header,
      "SQLite format 3",
      `iteration ${i}: TORN READ — the container opened something that is not a SQLite database`,
    );

    const seenIndex = Number.parseInt((seen ?? "").replace("MARKER-", ""), 10);
    assert.ok(
      Number.isFinite(seenIndex),
      `iteration ${i}: the container saw no marker at all — the artifact was not a complete snapshot`,
    );
    assert.ok(
      seenIndex <= i,
      `iteration ${i}: the container saw a marker from the FUTURE (${seen}) — impossible without a torn read`,
    );
    if (seenIndex === i) sawLatest++;
    else sawEarlier++;
  }

  assert.ok(
    sawLatest > 0,
    "the container observed republished content at least once — otherwise this loop proves nothing",
  );

  // NOT PERMANENTLY STALE: after the loop settles, one more read must show the
  // final marker. A design that delivered only the dispatch-time snapshot would
  // pass every iteration above (each read is "an earlier marker") and fail here.
  const settle = dockerTry([
    "exec", name, "sh", "-c",
    `grep -o 'MARKER-[0-9]*' /forge-backlog/${SNAPSHOT_DB_BASENAME} | tail -1`,
  ]);
  assert.equal(settle.stdout.trim(), `MARKER-${ITERATIONS}`, "the container is NOT permanently stale");

  // And nothing was quietly marked stale along the way.
  assert.deepEqual(
    publicationStates(KEY).filter((p) => p.state === "stale"),
    [],
    "no publication silently failed during the stress loop",
  );
  assert.ok(
    sawEarlier >= 0,
    `observed ${sawLatest} latest / ${sawEarlier} one-behind reads across ${ITERATIONS} iterations`,
  );
});

test("FG-608 concurrency: the writer is the HOST, never a second container", () => {
  // A source-level assertion, because this is the false-green the plan calls out
  // by name: container-to-container coherence working proves nothing about
  // host-to-container coherence, and a future edit "simplifying" the harness into
  // two containers would silently destroy the test's meaning.
  //
  // The forbidden tokens are ASSEMBLED at runtime rather than written literally,
  // so this assertion does not match itself — a self-matching guard is a guard
  // that can never pass, which is how these get deleted instead of fixed.
  const writeTokens = ["sqlite" + "3 ", ">> /forge-back" + "log", "backlog " + "edit"];
  const dockerLines = readSelf()
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .filter((l) => l.includes("dockerTry") || l.includes('"exec"') || l.includes('"run"'));
  assert.ok(dockerLines.length > 0, "precondition: the scan found this test's docker invocations");
  for (const token of writeTokens) {
    assert.equal(
      dockerLines.some((l) => l.includes(token)),
      false,
      `no container in this test may perform the WRITE (found '${token}') — the writer runs on the host`,
    );
  }
  assert.match(readSelf(), /function hostWrite/, "the writer is a host-side function");
  assert.ok(ITERATIONS >= 20, "a stress loop, not a single green run");
});

function readSelf(): string {
  return readFileSync(fileURLToPath(import.meta.url), "utf8");
}

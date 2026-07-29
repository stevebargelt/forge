// FG-608 (acceptance 5 + 6): the CONTAINER READ SURFACE — mutation refusal and
// project isolation, both as NEGATIVE tests (the enforcement half).
//
// TWO BOUNDARIES, TESTED SEPARATELY AND NEITHER STANDING IN FOR THE OTHER:
//
//   (a) THE MOUNT. Agents have passwordless root — agent-dev-worker.Dockerfile
//       creates `agent` with NOPASSWD:ALL and no `--user` is ever passed — so a
//       CLI-level refusal is not an enforcement primitive: sudo undoes it. The
//       docker `:ro` bind is the ONE primitive sudo cannot undo, and the
//       mutation-refusal assertions below run a write attempt WITH sudo against
//       the mounted path in a REAL container.
//
//   (b) THE CLI. `forge backlog file/edit/close/...` must refuse EXPLICITLY —
//       non-zero exit, no local write. This is asserted separately, and it is
//       deliberately not accepted as evidence for (a).
//
// The negative assertions are "an explicit refusal happened", NOT "the host DB is
// unchanged". The weaker form would pass while a write succeeded against the
// shared forge-claude-oauth named volume — leaking state into the next container
// of ANY project on this host.
//
// Tier: worktree (`npm run test:worktree`) — real docker. The daemon-dependent
// cases SKIP with a named reason when no daemon is reachable rather than
// silently passing; the host-side mount-plan assertions always run.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { upsertTicket, setStorageMode, ensureStorageMode } from "../store/tickets.js";
import { publishSnapshotOnce, SNAPSHOT_DB_BASENAME } from "../backlog/snapshot.js";
import { SNAPSHOT_DIR_ENV, writeAuthorityMarker } from "../backlog/container-authority.js";
import { prepareBacklogSnapshotMount, backlogSnapshotHostDir } from "./spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const PROBE_IMAGE = process.env["FORGE_TEST_DOCKER_PROBE_IMAGE"] ?? "busybox:latest";

function dockerTry(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { ok: true, stdout, stderr: "" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "" };
  }
}

/** Named reason the real-container half cannot run here, or undefined. Never
 *  swallowed into a silent pass — t.skip() prints it. */
function dockerUnavailable(): string | undefined {
  if (!dockerTry(["info", "--format", "{{.ServerVersion}}"]).ok) return "no docker daemon reachable";
  if (dockerTry(["image", "inspect", PROBE_IMAGE]).ok) return undefined;
  const pulled = dockerTry(["pull", PROBE_IMAGE]);
  return pulled.ok ? undefined : `probe image ${PROBE_IMAGE} unavailable: ${pulled.stderr.trim()}`;
}

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const dirs: string[] = [];

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const KEY = "pk-container";
const OTHER_KEY = "pk-other-project";
const NOW = "2026-07-29T00:00:00Z";

function newDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function seed(projectKey: string, id: string, body: string): void {
  writeTransaction(() => {
    ensureStorageMode(projectKey, NOW);
    upsertTicket({
      projectKey,
      ticketId: id,
      type: "story",
      status: "active",
      title: `title ${id}`,
      body,
      importedAt: NOW,
    });
  });
}

// ─── the mount SHAPE is a requirement, not an implementation detail ──────────

test("FG-608: the snapshot mount is a read-only DIRECTORY, never a file bind", () => {
  seed(KEY, "FG-1", "b");
  setStorageMode(KEY, "db", NOW);
  const snapDir = newDir("fg608-mount-");
  publishSnapshotOnce(KEY, snapDir);

  // A FILE bind pins the inode at container start, so a host-side atomic replace
  // (write-temp + rename allocates a NEW inode) would be invisible for the
  // container's whole life — and forge containers are one-per-task, long-lived and
  // never restarted. Mounting the DIRECTORY is what makes the rename visible.
  const spec = `${snapDir}:/forge-backlog:ro`;
  const [host, container, mode] = spec.split(":");
  assert.equal(host, snapDir);
  assert.equal(container, "/forge-backlog");
  assert.equal(mode, "ro");
  assert.equal(existsSync(join(snapDir, SNAPSHOT_DB_BASENAME)), true, "the artifact is INSIDE the mount");
});

test("FG-608: the snapshot host dir is NOT under the task dir (which is mounted rw)", () => {
  const dir = backlogSnapshotHostDir("task-abc");
  assert.match(dir, /backlog-snapshots[/\\]task-abc$/);
  assert.equal(
    dir.includes(`${"runs"}/`),
    false,
    "a snapshot inside the rw-mounted task dir would be agent-writable, making the refusal vacuous",
  );
});

test("FG-608: a markdown-mode project gets the MARKER but no snapshot", () => {
  const projectDir = newDir("fg608-md-proj-");
  mkdirSync(join(projectDir, "backlog"), { recursive: true });
  const mount = prepareBacklogSnapshotMount(projectDir, "task-1");
  dirs.push(mount.hostDir);

  // F1/F2 changed this: EVERY dispatch carries the unforgeable marker, because
  // "there is no snapshot" is exactly the case a container must be unable to talk
  // its way out of (unsetting the pointer used to make it look like a host
  // process, whose resolver reaches the shared oauth volume's forge.db).
  assert.equal(mount.mode, "markdown");
  assert.equal(existsSync(join(mount.hostDir, "authority.json")), true, "the marker is unconditional");
  assert.equal(
    existsSync(join(mount.hostDir, SNAPSHOT_DB_BASENAME)),
    false,
    "but publishing a snapshot for every markdown project would put a publication on every dispatch",
  );
});

// ─── (b) THE CLI half: an explicit refusal, non-zero exit ───────────────────

test("FG-608 (CLI half): every mutating verb refuses under a mounted authority", () => {
  seed(KEY, "FG-1", "mounted body");
  setStorageMode(KEY, "db", NOW);
  const snapDir = newDir("fg608-cli-mount-");
  publishSnapshotOnce(KEY, snapDir);

  const entry = resolve(here, "..", "cli", "index.ts");
  const localTsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");
  const tsx = existsSync(localTsx) ? localTsx : "tsx";
  const projectDir = newDir("fg608-cli-proj-");

  const run = (args: string[], env: Record<string, string>) => {
    try {
      const stdout = execFileSync(tsx, [entry, ...args], {
        cwd: projectDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
      });
      return { status: 0, stdout, stderr: "" };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  };

  const mounted = { [SNAPSHOT_DIR_ENV]: snapDir };

  // Reads WORK against the mount — the surface is live, not merely locked down.
  const shown = run(["backlog", "show", "FG-1"], mounted);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /mounted body/);

  for (const verb of [
    ["backlog", "file", "new ticket"],
    ["backlog", "edit", "FG-1", "--body", "x"],
    ["backlog", "close", "FG-1"],
    ["backlog", "move", "FG-1", "epic"],
    ["backlog", "retitle", "FG-1", "x"],
  ]) {
    const res = run(verb, mounted);
    assert.notEqual(res.status, 0, `${verb.join(" ")} must exit non-zero`);
    assert.match(res.stderr, /refusing/, `${verb.join(" ")} must refuse EXPLICITLY, not silently no-op`);
    assert.match(res.stderr, /READ-ONLY mounted/);
  }

  // SNAPSHOT ABSENT UNDER A CONTAINER MARKER: refuse, never fall back. This is the
  // measured hazard (F1) — with FORGE_HOME unset a container's resolveDbPath()
  // lands on the SHARED forge-claude-oauth volume's forge.db, which already
  // carries a full ticket schema for unrelated projects. A silent success there is
  // the vacuous pass. The marker is what makes "I am a container" undeniable, so
  // the refusal cannot be escaped by clearing the pointer.
  const markerOnly = newDir("fg608-marker-only-");
  writeAuthorityMarker(markerOnly, { mode: "db", projectKey: KEY, taskId: "task-1" });
  const noSnapshot = run(["backlog", "show", "FG-1"], {
    [SNAPSHOT_DIR_ENV]: markerOnly,
    FORGE_HOME: newDir("fg608-empty-home-"),
  });
  assert.notEqual(noSnapshot.status, 0, "a dispatched container with no snapshot must REFUSE");
  assert.match(noSnapshot.stderr, /refusing to read the backlog/);

  const noPointer = run(["backlog", "show", "FG-1"], { FORGE_HOME: newDir("fg608-empty-home-") });
  assert.notEqual(noPointer.status, 0, "with no mounted authority a read must not answer");
});

// ─── (a) THE MOUNT half: a real container, a write attempted WITH sudo ──────

test("FG-608 (mount half): a sudo write against the :ro mount fails in a REAL container", (t) => {
  const unavailable = dockerUnavailable();
  if (unavailable) {
    t.skip(`the mount-boundary enforcement half is NOT verified here — ${unavailable}`);
    return;
  }

  seed(KEY, "FG-1", "b");
  setStorageMode(KEY, "db", NOW);
  const snapDir = newDir("fg608-ro-mount-");
  publishSnapshotOnce(KEY, snapDir);
  const before = readFileSync(join(snapDir, SNAPSHOT_DB_BASENAME));

  // Run as ROOT (the default for the probe image, and the effective privilege an
  // agent has via NOPASSWD sudo). If the mount is enforced, even root cannot write.
  const write = dockerTry([
    "run", "--rm", "-v", `${snapDir}:/forge-backlog:ro`, PROBE_IMAGE,
    "sh", "-c", `printf corrupt >> /forge-backlog/${SNAPSHOT_DB_BASENAME}`,
  ]);
  assert.equal(write.ok, false, "a root write against a :ro bind must FAIL — this is the enforcement half");
  assert.match(write.stderr, /[Rr]ead-only file system/);

  const truncate = dockerTry([
    "run", "--rm", "-v", `${snapDir}:/forge-backlog:ro`, PROBE_IMAGE,
    "sh", "-c", `rm -f /forge-backlog/${SNAPSHOT_DB_BASENAME}`,
  ]);
  assert.equal(truncate.ok, false, "nor can root delete the artifact");

  const create = dockerTry([
    "run", "--rm", "-v", `${snapDir}:/forge-backlog:ro`, PROBE_IMAGE,
    "sh", "-c", "touch /forge-backlog/sneaky.db",
  ]);
  assert.equal(create.ok, false, "nor create a sibling file inside the mounted directory");

  assert.deepEqual(
    readFileSync(join(snapDir, SNAPSHOT_DB_BASENAME)),
    before,
    "and the host artifact is byte-identical",
  );
});

test("FG-608 (mount half): the container CAN read the mounted artifact (the mount is live, not just locked)", (t) => {
  const unavailable = dockerUnavailable();
  if (unavailable) {
    t.skip(`not verified here — ${unavailable}`);
    return;
  }
  seed(KEY, "FG-1", "b");
  setStorageMode(KEY, "db", NOW);
  const snapDir = newDir("fg608-ro-read-");
  publishSnapshotOnce(KEY, snapDir);

  const read = dockerTry([
    "run", "--rm", "-v", `${snapDir}:/forge-backlog:ro`, PROBE_IMAGE,
    "sh", "-c", `wc -c < /forge-backlog/${SNAPSHOT_DB_BASENAME}`,
  ]);
  assert.equal(read.ok, true, `the snapshot must be readable: ${read.stderr}`);
  assert.ok(Number.parseInt(read.stdout.trim(), 10) > 0);
});

// ─── (acceptance 6) PROJECT ISOLATION, as a negative test ───────────────────

test("FG-608: the mounted authority contains ONLY the selected project_key's backlog", () => {
  seed(KEY, "FG-1", "mine");
  seed(OTHER_KEY, "FG-99", "another project's ticket");
  setStorageMode(KEY, "db", NOW);

  const snapDir = newDir("fg608-isolation-");
  publishSnapshotOnce(KEY, snapDir);

  // Read the published file the way a container would: a plain SQLite open.
  const snap = new Database(join(snapDir, SNAPSHOT_DB_BASENAME), { readonly: true });
  try {
    assert.deepEqual(
      (snap.prepare(`SELECT ticket_id FROM tickets`).all() as { ticket_id: string }[]).map((r) => r.ticket_id),
      ["FG-1"],
      "another project's ticket is ABSENT — not filtered, absent",
    );
    for (const unreachable of ["runs", "tasks", "events", "gates", "verdicts", "campaigns", "project_identity", "model_calls"]) {
      assert.throws(
        () => snap.prepare(`SELECT * FROM ${unreachable} LIMIT 1`).get(),
        /no such table/,
        `${unreachable} must be unreachable from a container`,
      );
    }
  } finally {
    snap.close();
  }
});

test("FG-608: the full host forge.db is NEVER among a container's mounts", (t) => {
  const unavailable = dockerUnavailable();
  if (unavailable) {
    t.skip(`the live mount inspection is NOT verified here — ${unavailable}`);
    return;
  }
  seed(KEY, "FG-1", "b");
  setStorageMode(KEY, "db", NOW);
  const snapDir = newDir("fg608-nohostdb-");
  publishSnapshotOnce(KEY, snapDir);

  const name = `fg608-mounts-${process.pid}`;
  dockerTry(["rm", "-f", name]);
  const created = dockerTry([
    "create", "--name", name, "-v", `${snapDir}:/forge-backlog:ro`, PROBE_IMAGE, "true",
  ]);
  assert.equal(created.ok, true, created.stderr);
  try {
    const inspected = dockerTry(["inspect", "--format", "{{json .Mounts}}", name]);
    assert.equal(inspected.ok, true, inspected.stderr);
    const mounts = JSON.parse(inspected.stdout) as { Source: string; Destination: string; RW: boolean }[];
    assert.equal(mounts.length, 1, "exactly one backlog mount");
    assert.equal(mounts[0]!.RW, false, "and it is read-only at the daemon level");
    for (const m of mounts) {
      assert.equal(
        /forge\.db$/.test(m.Source),
        false,
        "the full ~/.forge/forge.db must never be a mount source",
      );
    }
  } finally {
    dockerTry(["rm", "-f", name]);
  }
});

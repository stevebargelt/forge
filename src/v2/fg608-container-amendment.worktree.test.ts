// FG-608 (acceptance 4) — MANDATE 5, PROPERTY (ii): ACTUAL END-TO-END DELIVERY.
//
// This file is DISTINCT from src/backlog/fg608-snapshot-publish.integration.test.ts,
// and the distinction is the whole point of the mandate:
//
//   property (i)  ATOMIC SNAPSHOT REPLACEMENT — rename atomicity, no torn reads.
//                 Tested there, on the host, under a stress loop. IT IS NOT
//                 EVIDENCE FOR (ii). A perfectly atomic rename that no container
//                 ever observes satisfies (i) completely and delivers nothing.
//
//   property (ii) DELIVERY — an authoritative host write reaching an ALREADY-
//                 RUNNING container's next read, through the PRODUCTION fan-out.
//                 Tested here.
//
// THE FG-628 AMENDMENT SHAPE, exactly: start a container against a clone whose
// Markdown lacks an amendment; edit the DB ticket ON THE HOST after container
// start; a subsequent read in that SAME container returns the amended body and the
// current revision. The container is never restarted — forge containers are
// one-per-task and long-lived (retry.ts mints a FRESH container rather than
// restarting one), which is precisely why a dispatch-time injection cannot satisfy
// this and why a FILE bind-mount (pinned inode) cannot either.
//
// NO TEST-RIGGED REPUBLISH. The host side performs an ORDINARY ticket write
// through the seam/store. publishSnapshotOnce is never called after the container
// starts — if the production choke point (markBacklogDirty -> publishToLiveTargets)
// is not wired, this test fails, which is the point.
//
// Tier: worktree (`npm run test:worktree`) — real docker. Skips with a NAMED
// reason when no daemon is reachable, never silently passes.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import {
  upsertTicket,
  setStorageMode,
  ensureStorageMode,
  getTicket,
  bumpIdSequence,
  dispatchEvidenceForTask,
} from "../store/tickets.js";
import { SNAPSHOT_DB_BASENAME } from "../backlog/snapshot.js";
import { computeRepositoryEvidence } from "../store/project-registry.js";
import { SNAPSHOT_DIR_ENV, DISPATCHED_TICKET_ENV } from "../backlog/container-authority.js";
import { writeTicket, readTicket } from "../backlog/structured.js";
import { clearBacklogStoreCache } from "../backlog/storage-mode.js";
import { buildDockerArgs, prepareBacklogSnapshotMount } from "./spawn.js";
import type { SpawnContext } from "./spawn.js";
import type { Runtime } from "./schema.js";


const PROBE_IMAGE = process.env["FORGE_TEST_DOCKER_PROBE_IMAGE"] ?? "busybox:latest";
// The real agent image, when this host has one built. Only IT can run the actual
// `forge backlog show` half of the acceptance case — that is an IMAGE change
// (the agent image ships no forge CLI today and adding one drags better-sqlite3's
// native build in). Absent, the delivery half below still runs against the probe
// image and is asserted at the byte level.
const AGENT_IMAGE = process.env["FORGE_TEST_AGENT_IMAGE"] ?? "agent-dev-worker:latest";

const RUNTIME: Runtime = {
  name: "fg608-amend-cli",
  description: "FG-608 amendment-delivery test runtime stub",
  image: AGENT_IMAGE,
  models: { default: "test-model" },
  auth: { mode: "oauth-volume" },
  env: {},
  mounts: [
    { host: "${TASK_DIR}", container: "/task", mode: "rw", optional: false },
    { host: "${PROJECT_DIR}", container: "/project", mode: "${PROJECT_MODE:-rw}", optional: false },
  ],
  invocation: { command: "claude", args: ["--model", "${MODEL}"] },
  container: { name: "forge-${TASK_ID}", remove_on_exit: true, idle_timeout_seconds: 300 },
  result: { file: "/task/result.json", stdout_log: "container.stdout.log", stderr_log: "container.stderr.log" },
};


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

function agentImageUnavailable(): string | undefined {
  const probe = probeUnavailable();
  if (probe) return probe;
  if (dockerTry(["image", "inspect", AGENT_IMAGE]).ok) return undefined;
  return `agent image ${AGENT_IMAGE} is not built on this host (set FORGE_TEST_AGENT_IMAGE)`;
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

const NOW = "2026-07-29T00:00:00Z";

function newDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A project CLONE whose backlog/*.md carries the PRE-amendment text, cut over to
 *  db mode. The Markdown deliberately stays stale for the whole test — that is the
 *  FG-628 shape: the checkout the container can see does not have the amendment,
 *  so anything the container reports about it must have come over the mount. */
function stalCloneInDbMode(projectKey: string, ticketId: string, originalBody: string): string {
  const projectDir = newDir("fg608-amend-proj-");
  const stories = join(projectDir, "backlog", "stories");
  mkdirSync(stories, { recursive: true });
  writeFileSync(
    join(stories, `${ticketId}-slug.md`),
    `---\nid: ${ticketId}\ntype: story\nstatus: active\ntitle: amendable\n---\n\n${originalBody}\n`,
  );
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), `project_key: ${projectKey}\n`);

  writeTransaction(() => {
    ensureStorageMode(projectKey, NOW);
    bumpIdSequence(projectKey, "FG", 100);
    upsertTicket({
      projectKey,
      ticketId,
      type: "story",
      status: "active",
      title: "amendable",
      body: originalBody,
      importedAt: NOW,
    });
  });
  setStorageMode(projectKey, "db", NOW);
  clearBacklogStoreCache();
  return projectDir;
}

/** Register the checkout's identity so the seam resolves the same project_key the
 *  snapshot is published under (production does this at import/migrate time). */
function registerIdentity(projectKey: string, projectDir: string): void {
  const evidence = computeRepositoryEvidence(projectDir);
  db.prepare(
    `INSERT OR REPLACE INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(projectKey, evidence.key, evidence.source, NOW);
  clearBacklogStoreCache();
}

// ─── PROPERTY (ii): delivery to an ALREADY-RUNNING container ─────────────────

test("FG-608 property (ii): a host amendment reaches an ALREADY-RUNNING container's next read", (t) => {
  const unavailable = probeUnavailable();
  if (unavailable) {
    t.skip(`END-TO-END DELIVERY IS NOT VERIFIED HERE — ${unavailable}. The atomic-replacement tests do NOT cover this.`);
    return;
  }

  const KEY = "pk-amendment";
  const TICKET = "FG-1";
  const ORIGINAL = "ORIGINAL-BODY-BEFORE-AMENDMENT";
  const AMENDED = "AMENDED-BODY-ADDED-WHILE-THE-CONTAINER-WAS-RUNNING";

  const projectDir = stalCloneInDbMode(KEY, TICKET, ORIGINAL);
  registerIdentity(KEY, projectDir);

  // Dispatch-time preparation, through the PRODUCTION path: publish the first
  // snapshot and REGISTER the target so subsequent host writes fan out to it.
  const mount = prepareBacklogSnapshotMount(projectDir, "task-amend", TICKET);
  assert.ok(mount, "a db-mode project must get a snapshot mount");
  assert.ok(mount!.dispatchedTicket, "dispatch evidence is recorded at dispatch time");

  // START the container. It stays up for the rest of the test and is NEVER
  // restarted — restarting it would make this test prove nothing.
  const name = `fg608-amend-${process.pid}`;
  dockerTry(["rm", "-f", name]);
  containers.push(name);
  const started = dockerTry([
    "run", "-d", "--name", name,
    "-v", `${mount!.hostDir}:${mount!.containerDir}:ro`,
    "-e", `${SNAPSHOT_DIR_ENV}=${mount!.containerDir}`,
    "-e", `${DISPATCHED_TICKET_ENV}=${mount!.dispatchedTicket}`,
    PROBE_IMAGE, "sleep", "300",
  ]);
  assert.equal(started.ok, true, started.stderr);

  const readInContainer = (needle: string): boolean => {
    const r = dockerTry([
      "exec", name, "sh", "-c",
      `grep -c ${needle} ${mount!.containerDir}/${SNAPSHOT_DB_BASENAME} || true`,
    ]);
    assert.equal(r.ok, true, r.stderr);
    return Number.parseInt(r.stdout.trim() || "0", 10) > 0;
  };

  assert.equal(readInContainer(ORIGINAL), true, "the running container sees the pre-amendment ticket");
  assert.equal(readInContainer(AMENDED), false, "and does not yet see the amendment");

  // THE AMENDMENT, on the HOST, AFTER the container started. An ORDINARY seam
  // write — the production path. Nothing here republishes explicitly.
  writeTicket(projectDir, { ...readTicket(projectDir, TICKET), body: AMENDED });

  const live = getTicket(KEY, TICKET)!;
  assert.equal(live.body, AMENDED);
  assert.ok(live.revision! > 1, "the monotonic revision advanced on the host");

  // THE DELIVERY. Same container, next read.
  assert.equal(
    readInContainer(AMENDED),
    true,
    "the amendment reached the ALREADY-RUNNING container through the production fan-out — " +
      "no republish was performed by this test",
  );
  assert.equal(
    dockerTry(["inspect", "--format", "{{.State.Running}}", name]).stdout.trim(),
    "true",
    "the container was never restarted",
  );

  // And the checkout's Markdown never changed — everything above came over the mount.
  const markdown = readFileSync(join(projectDir, "backlog", "stories", `${TICKET}-slug.md`), "utf8");
  assert.ok(markdown.includes(ORIGINAL));
  assert.equal(markdown.includes(AMENDED), false, "the mounted checkout is still stale — as in FG-628");
});

test("FG-608 property (ii): `forge backlog show` in that SAME container returns the amended body and current revision", (t) => {
  const unavailable = agentImageUnavailable();
  if (unavailable) {
    t.skip(`the in-container CLI half is NOT verified here — ${unavailable}`);
    return;
  }

  const KEY = "pk-amendment-cli";
  const TICKET = "FG-1";
  const ORIGINAL = "ORIGINAL-BODY";
  const AMENDED = "AMENDED-BODY";

  const projectDir = stalCloneInDbMode(KEY, TICKET, ORIGINAL);
  registerIdentity(KEY, projectDir);
  const mount = prepareBacklogSnapshotMount(projectDir, "task-amend-cli", TICKET)!;

  // FG-608 F3: the container is the one buildDockerArgs PRODUCES — same mounts,
  // same env, and NO /forge-src bind of the host checkout. That bind is what made
  // the old version of this test prove nothing about production, which mounts only
  // the project and the authority directory.
  const { args, imageIndex } = buildDockerArgs(RUNTIME, {
    TASK_ID: "task-amend-cli",
    TASK_DIR: newDir("fg608-amend-task-"),
    PROJECT_DIR: projectDir,
    PROJECT_MODE: "rw",
    MODEL: "test-model",
    SYSTEM_PROMPT: "system",
    TASK_PACKAGE_MARKDOWN: "# Task\n",
    TICKET_ID: TICKET,
  } as SpawnContext);
  assert.deepEqual(
    args.filter((a) => a.includes("/forge-src")),
    [],
    "production creates no source mount — the reader must be shipped, not borrowed from the host checkout",
  );

  const name = `fg608-amend-cli-${process.pid}`;
  dockerTry(["rm", "-f", name]);
  containers.push(name);
  const prefix = args.slice(0, imageIndex).map((a, i) => (args[i - 1] === "--name" ? name : a));
  const started = dockerTry([...prefix, AGENT_IMAGE, "sleep", "600"]);
  assert.equal(started.ok, true, started.stderr);

  const showInContainer = () => dockerTry(["exec", name, "forge", "backlog", "show", TICKET]);

  const before = showInContainer();
  assert.equal(before.ok, true, before.stderr);
  assert.match(before.stdout, new RegExp(ORIGINAL));
  assert.match(before.stdout, /revision 1/);

  // Host amendment through the production seam path.
  writeTicket(projectDir, { ...readTicket(projectDir, TICKET), body: AMENDED });

  const after = showInContainer();
  assert.equal(after.ok, true, after.stderr);
  assert.match(after.stdout, new RegExp(AMENDED), "the amended body");
  assert.match(after.stdout, /revision 2/, "and the CURRENT revision");
  // Acceptance 7: BOTH records surface, neither overwriting the other.
  assert.match(after.stderr, /dispatched revision 1/);
  assert.match(after.stderr, /current revision 2/);
});

// ─── acceptance 7: dispatch evidence, host-side ─────────────────────────────

test("FG-608: dispatch evidence records the monotonic revision + body hash, and never overwrites live authority", () => {
  const KEY = "pk-dispatch-evidence";
  const TICKET = "FG-1";
  const projectDir = stalCloneInDbMode(KEY, TICKET, "v1");
  registerIdentity(KEY, projectDir);

  const mount = prepareBacklogSnapshotMount(projectDir, "task-ev", TICKET)!;
  const [id, revision, hash] = mount.dispatchedTicket!.split(":");
  assert.equal(id, TICKET);
  assert.equal(revision, "1");
  assert.equal(hash, getTicket(KEY, TICKET)!.bodyHash);

  const durable = dispatchEvidenceForTask("task-ev")!;
  assert.equal(durable.revision, 1);

  // The live ticket advances. The dispatch record must NOT move.
  writeTicket(projectDir, { ...readTicket(projectDir, TICKET), body: "v2" });
  assert.equal(getTicket(KEY, TICKET)!.revision, 2, "live authority advanced");
  assert.equal(
    dispatchEvidenceForTask("task-ev")!.revision,
    1,
    "the dispatched record is untouched — no silent reconciliation in either direction",
  );

  // And an edit-and-REVERT still shows advancement: the counter backs this AC,
  // not the hash.
  const revertedTo = "v1\n";
  writeTicket(projectDir, { ...readTicket(projectDir, TICKET), body: revertedTo });
  const reverted = getTicket(KEY, TICKET)!;
  assert.equal(reverted.revision, 3, "advancement is visible even though the content came back");
});

// FG-645 AC 4: the container-authority test seam is OPT-IN, and nothing else moved.
//
// The sweep gave 27 spawn helpers a preload that repoints the compiled-in authority
// probe. The obvious way to get that wrong is to make it AMBIENT — a variable, or a
// module read on some production path, that a dispatched agent could set for itself.
// This suite is the negative space around the seam: every arm below spawns a REAL
// forge CLI child and asserts what it resolves.
//
// The arms are written so they mean the SAME THING on a host and inside an agent
// container. Where the answer genuinely differs — a child with no authority signals
// at all — both branches assert, because "this environment carries a real marker" is
// a fact worth pinning rather than a reason to stop testing.
//
// Nothing here is a skip. The one place environment is consulted (does this process
// carry a real /forge-backlog marker) selects WHICH assertion runs, never whether.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { ensureStorageMode, setStorageMode, upsertTicket } from "../store/tickets.js";
import { publishSnapshotOnce } from "./snapshot.js";
import {
  AUTHORITY_MARKER_BASENAME,
  CONTAINER_AUTHORITY_MOUNT,
  SNAPSHOT_DIR_ENV,
  writeAuthorityMarker,
} from "./container-authority.js";
import { neutralAuthorityMount, withAuthorityTestkit } from "./container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");
const entry = resolve(REPO_ROOT, "src", "cli", "index.ts");
const localTsx = resolve(REPO_ROOT, "node_modules", ".bin", "tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

const KEY = "pk-fg645-opt-in";
const NOW = "2026-07-30T00:00:00Z";
/** Ids of the FOREIGN authority below — deliberately overlapping the fixture's, the
 *  way a real host backlog overlaps any low-numbered fixture. */
const FOREIGN_IDS = ["FG-10", "FG-20", "FG-30", "FG-345"];

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;
const dirs: string[] = [];

function newDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** The structured fixture the CLI must answer from when the seam is armed. */
function setupFixture(): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
  const base = join(projectDir, "backlog");
  for (const sub of ["ideas", "epics", "stories", "done"]) mkdirSync(join(base, sub), { recursive: true });
  writeFileSync(
    join(base, "ideas", "FG-10-improve-docs.md"),
    "---\nid: FG-10\ntype: idea\nstatus: active\ntitle: Improve docs\ncreated: '2026-01-01'\n---\n\nbody\n",
  );
  writeFileSync(
    join(base, "stories", "FG-30-implement-thing.md"),
    "---\nid: FG-30\ntype: story\nstatus: active\ntitle: Implement thing\ncreated: '2026-02-01'\n---\n\nbody\n",
  );
  writeFileSync(
    join(base, "done", "FG-5-already-done.md"),
    "---\nid: FG-5\ntype: story\nstatus: done\ntitle: Already done\ncreated: '2025-12-01'\nclosed: '2026-01-05'\n---\n\nbody\n",
  );
}

/** Where FG-30's ticket file currently lives, by backlog subdirectory. */
function copiesOf(id: string): Record<string, number> {
  const base = join(projectDir, "backlog");
  const counts: Record<string, number> = {};
  for (const sub of ["stories", "epics", "ideas", "done"]) {
    const d = join(base, sub);
    const n = existsSync(d) ? readdirSync(d).filter((f) => f.startsWith(`${id}-`)).length : 0;
    if (n > 0) counts[sub] = n;
  }
  return counts;
}

/** A published, MARKED authority directory holding tickets that are not the
 *  fixture's — a stand-in for the host snapshot a container carries. */
function foreignAuthority(): string {
  writeTransaction(() => {
    ensureStorageMode(KEY, NOW);
    for (const [id, title] of [
      ["FG-10", "host ten"],
      ["FG-20", "host twenty"],
      ["FG-30", "host thirty"],
      ["FG-345", "a real host ticket"],
    ] as const) {
      upsertTicket({ projectKey: KEY, ticketId: id, type: "story", status: "active", title, body: "host body", importedAt: NOW });
    }
  });
  setStorageMode(KEY, "db", NOW);
  const dir = newDir("fg645-foreign-authority-");
  publishSnapshotOnce(KEY, dir);
  writeAuthorityMarker(dir, { mode: "db", projectKey: KEY, taskId: "task-foreign" });
  return dir;
}

function ids(stdout: string): string[] {
  const parsed = JSON.parse(stdout) as { id: string }[];
  return parsed.map((t) => t.id).sort();
}

type Res = { status: number | null; stdout: string; stderr: string };

/** A real forge CLI child. `seam` chooses whether it is given the `--import` preload;
 *  `env` is spread over the inherited environment LAST. */
function runForge(args: string[], env: Record<string, string>, opts: { seam?: boolean } = {}): Res {
  const argv = opts.seam ? withAuthorityTestkit(entry, args) : [entry, ...args];
  const res = spawnSync(tsx, argv, {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** True when THIS process really is a dispatched agent container. */
function realMarkerPresent(): boolean {
  return existsSync(join(CONTAINER_AUTHORITY_MOUNT, AUTHORITY_MARKER_BASENAME));
}

/** The project_key the store banner names, i.e. WHICH authority answered.
 *
 *  Asserted instead of the ticket CONTENT of the ambient mount: the host republishes
 *  that snapshot on any backlog write, so a content comparison against a live agent
 *  container would be a race. The key is a property of the dispatch and does not move. */
function bannerProjectKey(stderr: string): string | null {
  return /store: db snapshot \(project_key=([^,)]+)/.exec(stderr)?.[1] ?? null;
}

/** The project_key an UNSEAMED child resolves.
 *
 *  Inside an agent container that is the COMPILED-IN mount's marker, NOT `pointedKey` —
 *  the fixed path is probed first and the environment is never consulted at all. That
 *  ordering is the security property, and it is the whole reason the sweep needed a
 *  preload rather than an env var. On a host the fixed path is bare, so the pointer is
 *  what answers. Either way it is a mounted authority and never the fixture. */
function ambientProjectKey(pointedKey: string): string {
  if (!realMarkerPresent()) return pointedKey;
  const marker = JSON.parse(
    readFileSync(join(CONTAINER_AUTHORITY_MOUNT, AUTHORITY_MARKER_BASENAME), "utf8"),
  ) as { projectKey: string };
  return marker.projectKey;
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = newDir("fg645-opt-in-proj-");
  setupFixture();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("integ FG-645 AC4: an UNSEAMED child still resolves a mounted authority and refuses the mutation", () => {
  const foreign = foreignAuthority();
  const res = runForge(["backlog", "close", "FG-30", "--project", projectDir], { [SNAPSHOT_DIR_ENV]: foreign });

  assert.notEqual(res.status, 0, "the production refusal must be intact for a child nobody seamed");
  assert.match(res.stderr, /refusing `backlog close`/);
  assert.match(res.stderr, /READ-ONLY mounted snapshot/);
  assert.deepEqual(copiesOf("FG-30"), { stories: 1 }, "and no local write happened");
});

test("integ FG-645 AC4: an UNSEAMED read is SILENTLY redirected — exit 0, foreign content", () => {
  const foreign = foreignAuthority();
  const res = runForge(["backlog", "list", "--json", "--project", projectDir], { [SNAPSHOT_DIR_ENV]: foreign });

  assert.equal(res.status, 0, "the dangerous shape (a2) exits ZERO — that is why exit-status-only tests went green");
  assert.match(res.stderr, /store: db snapshot/, "and said so on stderr");
  assert.notDeepEqual(ids(res.stdout), ["FG-10", "FG-30", "FG-5"], "the read did NOT answer from --project");
  assert.equal(
    bannerProjectKey(res.stderr),
    ambientProjectKey(KEY),
    "it answered from the mounted authority this process resolves",
  );

  if (realMarkerPresent()) {
    // The ordering claim, asserted where it is observable: the pointer named the
    // foreign authority and was IGNORED, because the marker is probed first.
    assert.notEqual(bannerProjectKey(res.stderr), KEY, "the env pointer did not win — the marker did");
    assert.notDeepEqual(ids(res.stdout), FOREIGN_IDS);
  } else {
    assert.equal(bannerProjectKey(res.stderr), KEY, "on a host the pointer is the only authority there is");
    assert.deepEqual(ids(res.stdout), FOREIGN_IDS);
  }
});

test("integ FG-645 AC4: FORGE_TEST_AUTHORITY_MOUNT is INERT without the --import preload", () => {
  const foreign = foreignAuthority();
  const neutral = neutralAuthorityMount();

  // Arm 1 — the variable alone. Nothing reads it: no module was loaded that does.
  const bare = runForge(["backlog", "close", "FG-30", "--project", projectDir], {
    [SNAPSHOT_DIR_ENV]: foreign,
    FORGE_TEST_AUTHORITY_MOUNT: neutral,
  });
  assert.notEqual(bare.status, 0, "an env var an agent could set for itself must not move the gate");
  assert.match(bare.stderr, /refusing `backlog close`/);

  // Arm 2 — the preload WITH the variable, but the env pointer still names a marked
  // authority. The preload moves the COMPILED-IN probe only; it does not switch off
  // the env branch, so this must STILL refuse.
  const halfSeamed = runForge(["backlog", "close", "FG-30", "--project", projectDir], {
    [SNAPSHOT_DIR_ENV]: foreign,
    FORGE_TEST_AUTHORITY_MOUNT: neutral,
  }, { seam: true });
  assert.notEqual(halfSeamed.status, 0, "clearing the snapshot pointer is the OTHER required half of the seam");
  assert.match(halfSeamed.stderr, /refusing `backlog close`/);

  // Arm 3 — the preload with NO mount variable. `if (dir)` is the guard; an empty
  // value must leave the production path exactly as it was.
  const emptyMount = runForge(["backlog", "close", "FG-30", "--project", projectDir], {
    [SNAPSHOT_DIR_ENV]: foreign,
    FORGE_TEST_AUTHORITY_MOUNT: "",
  }, { seam: true });
  assert.notEqual(emptyMount.status, 0, "an empty mount value must not be read as 'no authority'");
  assert.match(emptyMount.stderr, /refusing `backlog close`/);

  assert.deepEqual(copiesOf("FG-30"), { stories: 1 }, "three refusals, zero writes");

  // Arm 4 — BOTH halves plus the preload: now, and only now, the child is an
  // ordinary process working on the fixture.
  const seamed = runForge(["backlog", "close", "FG-30", "--project", projectDir], {
    [SNAPSHOT_DIR_ENV]: "",
    FORGE_TEST_AUTHORITY_MOUNT: neutral,
  }, { seam: true });
  assert.equal(seamed.status, 0, `the fully-armed seam must reach the fixture: ${seamed.stderr}`);
  assert.deepEqual(copiesOf("FG-30"), { done: 1 }, "the close landed in THIS fixture");
});

test("integ FG-645 AC4: with every signal cleared, the COMPILED-IN marker is what decides", () => {
  // This is the arm whose answer legitimately differs by environment, and the reason
  // the seam had to exist at all. Both branches assert; neither skips.
  const res = runForge(["backlog", "close", "FG-30", "--project", projectDir], {
    [SNAPSHOT_DIR_ENV]: "",
    FORGE_TEST_AUTHORITY_MOUNT: "",
  });

  if (realMarkerPresent()) {
    assert.notEqual(res.status, 0, "this process carries a real marker — an agent clearing the env must not open the gate");
    assert.match(res.stderr, /refusing `backlog close`/);
    assert.deepEqual(copiesOf("FG-30"), { stories: 1 }, "and nothing was written");
    const marker = JSON.parse(readFileSync(join(CONTAINER_AUTHORITY_MOUNT, AUTHORITY_MARKER_BASENAME), "utf8")) as {
      kind: string;
    };
    assert.equal(marker.kind, "forge-backlog-authority", "the refusal came from a real dispatched marker");
  } else {
    assert.equal(res.status, 0, `on a host with no marker the same child is ordinary: ${res.stderr}`);
    assert.deepEqual(copiesOf("FG-30"), { done: 1 }, "the close landed in the fixture");
  }
});

test("integ FG-645 AC4: the seam has NO production reader — only the testkit consults the variable", () => {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx|mjs|js|sh)$/.test(e.name)) continue;
      if (statSync(p).size > 2_000_000) continue;
      if (readFileSync(p, "utf8").includes("FORGE_TEST_AUTHORITY_MOUNT")) hits.push(relative(REPO_ROOT, p));
    }
  };
  for (const top of ["src", "bin", "docker", "scripts"]) walk(resolve(REPO_ROOT, top));

  const production = hits.filter((p) => !/\.test\.ts$/.test(p)).sort();
  assert.deepEqual(
    production,
    ["src/backlog/container-authority.testkit-spawn.ts", "src/backlog/container-authority.testkit.ts"],
    "a third non-test reader of this variable would make the seam ambient — which is the F2 bypass",
  );

  // And the module that DOES read it is loaded only by an explicit `--import`: it is
  // not imported by any production module.
  const importers = hits.filter((p) => p !== "src/backlog/container-authority.testkit.ts");
  for (const p of importers) {
    const src = readFileSync(resolve(REPO_ROOT, p), "utf8");
    if (!/from "\.\/container-authority\.testkit\.js"/.test(src)) continue;
    assert.match(p, /\.test\.ts$|testkit-spawn\.ts$/, `${p} imports the testkit on a production path`);
  }
});

test("integ FG-645 AC4: the SHIPPED reader has no env- or preload-reachable mount override", () => {
  const reader = readFileSync(resolve(REPO_ROOT, "docker", "forge-backlog-reader.mjs"), "utf8");
  const mountLines = reader.split("\n").filter((l) => /^const MOUNT = /.test(l));
  assert.deepEqual(
    mountLines,
    [`const MOUNT = "/forge-backlog";`],
    "the container's only forge surface must compile its mount root IN, with exactly one declaration",
  );
  assert.doesNotMatch(reader, /FORGE_TEST_AUTHORITY_MOUNT/, "no test seam may exist in the shipped reader");
  assert.doesNotMatch(reader, /setAuthorityMountForTest/, "nor a setter reachable from it");
});

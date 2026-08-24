// FG-759: the project-card's README fallback and one-click classification both
// consume the dashboard's server contract.  This suite uses a real dashboard HTTP
// server, real git checkouts, and the co-located forge CLI: it guards the boundary
// below the presentation-only browser tier.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectRecord } from "@forge/projects";

const TEST_PORT = 18859;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const root = mkdtempSync(join(tmpdir(), "forge-fg759-contract-"));
const forgeHome = join(root, ".forge");
const scanRoot = join(root, "projects");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(scanRoot, { recursive: true });

// These must be fixed before any store/dashboard module is loaded.
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_DB_PATH = join(forgeHome, "forge.db");
process.env.FORGE_PROJECT_SCAN_ROOTS = scanRoot;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const { getDb, writeTransaction } = await import("../../src/store/db.js");
const { getWorkspacePurpose } = await import("../../src/store/workspace-purpose.js");
const { extractReadmeProse, operatorProjects } = await import("../../src/util/projects.js");
const { presentationRegistry } = await import("./queries.js");

function checkout(name: string, readme: string): string {
  const dir = join(scanRoot, name);
  mkdirSync(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", `git@github.com:forge-tests/${name}.git`], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), readme);
  return dir;
}

const htmlReadmeDir = checkout("html-opening", [
  '<p align="left">',
  '  <img src="logo.svg" alt="Forge logo" />',
  "</p>",
  "",
  "# HTML-opening fixture",
  "",
  "The first card sentence is meaningful prose.",
].join("\n"));
const claimDir = checkout("operator-claim", "A legacy workspace that the operator can claim.\n");

writeTransaction(() => {
  const insertRun = getDb().prepare(
    "INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)",
  );
  insertRun.run("run-fg759-html", "feature", "HTML README fixture", "complete", "2026-08-24T10:00:00Z", htmlReadmeDir);
  insertRun.run("run-fg759-claim", "feature", "Claim fixture", "complete", "2026-08-24T10:01:00Z", claimDir);
});

const { server } = await import("./server.js");

after(() => {
  server.closeAllConnections?.();
  server.close();
  rmSync(root, { recursive: true, force: true });
});

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/projects`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error("FG-759 dashboard test server did not start");
}

await waitForServer();

async function projects(): Promise<ProjectRecord[]> {
  const response = await fetch(`${BASE}/api/projects`);
  assert.equal(response.status, 200);
  return response.json() as Promise<ProjectRecord[]>;
}

test("extractReadmeProse contract ignores README framing and returns only prose", () => {
  const cases: Array<{ name: string; readme: string; expected: string | undefined }> = [
    {
      name: "HTML opening",
      readme: '<p align="left">\n<img src="logo.svg" />\n</p>\n\nActual prose starts here.\n',
      expected: "Actual prose starts here.",
    },
    {
      name: "badges first",
      readme: "[![Build](https://img.example/build.svg)](https://ci.example)\n\nUseful library prose.\n",
      expected: "Useful library prose.",
    },
    {
      name: "markdown heading first",
      readme: "# Project title\n\nA concise project description.\n",
      expected: "A concise project description.",
    },
    { name: "plain prose", readme: "The first line is already prose.\nLater detail.\n", expected: "The first line is already prose." },
    { name: "markup only", readme: '<p align="left"></p>\n<!-- logo -->\n---\n', expected: undefined },
  ];

  for (const scenario of cases) {
    assert.equal(extractReadmeProse(scenario.readme), scenario.expected, scenario.name);
  }
});

test("GET /api/projects exposes extracted README prose rather than raw HTML", async () => {
  const record = (await projects()).find((project) => project.projectDirs.includes(htmlReadmeDir));
  assert.ok(record, "the HTML-opening checkout is a dashboard project record");
  assert.equal(record.readmeFirstLine, "The first card sentence is meaningful prose.");
  assert.ok(!record.readmeFirstLine?.includes("<"), "the API contract never forwards a raw HTML tag to the card");
});

test("unclassified records remain visible and unchanged through dashboard membership and presentation", async () => {
  const record = (await projects()).find((project) => project.projectDirs.includes(claimDir));
  assert.ok(record, "an unclassified legacy workspace remains visible in the Projects API");
  assert.equal(record.purpose, "unclassified");
  assert.equal(record.classification, "unclassified");

  const [presented] = presentationRegistry([record]);
  assert.ok(presented, "presentation filtering retains an existing unclassified checkout");
  assert.equal(presented.purpose, "unclassified");
  assert.equal(presented.classification, "unclassified");
  assert.equal(operatorProjects([record]).length, 1, "membership has no new heuristic suppression for an unclassified record");
});

test("POST /api/projects/classify records the operator purpose through the real CLI path", async () => {
  const response = await fetch(`${BASE}/api/projects/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ dir: claimDir, purpose: "operator" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { ok?: unknown; result?: unknown };
  assert.equal(body.ok, true);
  assert.ok(body.result && typeof body.result === "object", "the real CLI result is returned by the endpoint");

  const recorded = getWorkspacePurpose(claimDir);
  assert.equal(recorded?.kind, "operator");
  assert.equal(recorded?.source, "operator");
});

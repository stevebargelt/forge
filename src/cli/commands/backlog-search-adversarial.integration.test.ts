// FG-389 adversarial integration tests: --search --json reflects filtered list.
// All fixtures are real structured backlog dirs written to real temp dirs.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// here = src/cli/commands; entry is src/cli/index.ts; node_modules is at repo root
const entry = resolve(here, "..", "index.ts");
const tsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

let projectDir: string;

function runForge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], { cwd: projectDir, encoding: "utf8" });
}

function setupFixtures(): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
  const base = join(projectDir, "backlog");
  mkdirSync(join(base, "ideas"),   { recursive: true });
  mkdirSync(join(base, "epics"),   { recursive: true });
  mkdirSync(join(base, "stories"), { recursive: true });
  mkdirSync(join(base, "done"),    { recursive: true });

  // Ticket that matches "queueing"
  writeFileSync(
    join(base, "stories", "FG-10-priority-queueing.md"),
    "---\nid: FG-10\ntype: story\nstatus: active\ntitle: Priority queueing in runner\n---\n\nThe runner needs a priority queueing mechanism.\n",
  );
  // Ticket that matches "queueing" in body only (title: "Campaign scheduler")
  writeFileSync(
    join(base, "epics", "FG-20-campaign-scheduler.md"),
    "---\nid: FG-20\ntype: epic\nstatus: active\ntitle: Campaign scheduler\n---\n\nDepends on queueing support being in place first.\n",
  );
  // Ticket with no match
  writeFileSync(
    join(base, "ideas", "FG-30-dark-mode.md"),
    "---\nid: FG-30\ntype: idea\nstatus: active\ntitle: Dark mode for dashboard\n---\n\nUsers want a dark mode option.\n",
  );
  // Done ticket that matches "queueing" — should appear in full list but filtered by --status active
  writeFileSync(
    join(base, "done", "FG-5-old-queue.md"),
    "---\nid: FG-5\ntype: story\nstatus: done\ntitle: Old queueing prototype\n---\n\nThis was the old queueing prototype, now superseded.\n",
  );
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-fg389-json-integ-"));
  setupFixtures();
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ─── (5a) --json output reflects filtered list, not the full backlog ───────────

test("FG-389 adv integ: --search --json returns only matching tickets, not full backlog", () => {
  const res = runForge(["backlog", "list", "--search", "queueing", "--json", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  let arr: Array<{ id: string; type: string; status: string; title: string }>;
  assert.doesNotThrow(() => { arr = JSON.parse(res.stdout); }, "output must be valid JSON");
  arr = JSON.parse(res.stdout);

  assert.ok(Array.isArray(arr), "JSON output must be an array");
  // FG-10, FG-20, FG-5 all match "queueing"; FG-30 does not
  const ids = arr.map((t) => t.id).sort();
  assert.ok(ids.includes("FG-10"), "FG-10 (title match) must appear");
  assert.ok(ids.includes("FG-20"), "FG-20 (body-only match) must appear");
  assert.ok(ids.includes("FG-5"),  "FG-5 (done, title match) must appear");
  assert.ok(!ids.includes("FG-30"), "FG-30 (no match) must NOT appear in JSON");
  assert.equal(arr.length, 3, "exactly 3 tickets match 'queueing'");
});

test("FG-389 adv integ: --search --json with no matches emits empty array", () => {
  const res = runForge(["backlog", "list", "--search", "zzznotreal99", "--json", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const arr = JSON.parse(res.stdout);
  assert.ok(Array.isArray(arr), "output must be an array");
  assert.equal(arr.length, 0, "no-match search must emit empty JSON array");
});

test("FG-389 adv integ: --search --status active --json excludes done tickets", () => {
  const res = runForge(["backlog", "list", "--search", "queueing", "--status", "active", "--json", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const arr: Array<{ id: string }> = JSON.parse(res.stdout);
  assert.ok(Array.isArray(arr), "output must be an array");

  const ids = arr.map((t) => t.id);
  assert.ok(ids.includes("FG-10"), "FG-10 (active, title match) must appear");
  assert.ok(ids.includes("FG-20"), "FG-20 (active, body-only match) must appear");
  assert.ok(!ids.includes("FG-5"),  "FG-5 (done) must NOT appear when status=active");
  assert.ok(!ids.includes("FG-30"), "FG-30 (no keyword) must NOT appear");
  assert.equal(arr.length, 2);
});

test("FG-389 adv integ: --search --type story --json returns only story matches", () => {
  const res = runForge(["backlog", "list", "--search", "queueing", "--type", "story", "--json", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const arr: Array<{ id: string; type: string }> = JSON.parse(res.stdout);
  assert.ok(Array.isArray(arr));

  // FG-10 is a story that matches; FG-5 (done story) is also story but in done/
  // FG-20 is an epic, should be excluded
  const ids = arr.map((t) => t.id);
  assert.ok(ids.includes("FG-10"), "FG-10 (active story, title match) must appear");
  assert.ok(!ids.includes("FG-20"), "FG-20 (epic) must NOT appear with --type story");
  for (const t of arr) {
    assert.equal(t.type, "story", `every returned ticket must have type=story, got ${t.type}`);
  }
});

test("FG-389 adv integ: --json without --search returns all tickets (sanity check)", () => {
  const res = runForge(["backlog", "list", "--json", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const arr: Array<{ id: string }> = JSON.parse(res.stdout);
  assert.ok(Array.isArray(arr));
  const ids = arr.map((t) => t.id).sort();
  // All 4 tickets should be present when no search filter is applied
  assert.ok(ids.includes("FG-10"), "FG-10 must appear in unfiltered list");
  assert.ok(ids.includes("FG-20"), "FG-20 must appear in unfiltered list");
  assert.ok(ids.includes("FG-30"), "FG-30 must appear in unfiltered list");
  assert.ok(ids.includes("FG-5"),  "FG-5 (done) must appear in unfiltered list");
  assert.equal(arr.length, 4, "unfiltered --json must contain all 4 tickets");
});

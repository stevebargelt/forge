import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../../integration-cli-spawn.js";

let projectDir: string;

function runReadiness(args: string[]) {
  return spawnSync(tsx, [entry, "readiness", ...args], {
    cwd: projectDir,
    encoding: "utf8",
  });
}

function createTicket(id: string, fm: Record<string, string>, body: string) {
  const type = fm["type"] ?? "story";
  const subdir = type === "idea" ? "ideas" : type === "epic" ? "epics" : "stories";
  const dir = join(projectDir, "backlog", subdir);
  mkdirSync(dir, { recursive: true });
  const fmLines = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  writeFileSync(join(dir, `${id}-test-ticket.md`), `---\nid: ${id}\n${fmLines}\n---\n\n${body}`);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-readiness-integ-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

test("integ readiness: ready ticket → --json shape stable, exit 0", () => {
  createTicket(
    "FG-001",
    { type: "story", status: "active", title: "Ready ticket" },
    "## Problem\nSomething is broken.\n\n## Goal\nFix it.\n\n## Acceptance Criteria\n- Test passes.\n",
  );

  const result = runReadiness(["FG-001", "--json", "--project", projectDir]);
  assert.equal(result.status, 0, `exit non-zero: ${result.stderr}`);

  const parsed = JSON.parse(result.stdout) as {
    ticketId: string;
    outcome: string;
    gaps: string[];
    refinementProposal: string | null;
  };
  assert.equal(parsed.ticketId, "FG-001");
  assert.equal(parsed.outcome, "ready");
  assert.deepEqual(parsed.gaps, []);
  assert.equal(parsed.refinementProposal, null);
});

test("integ readiness: needs_refinement ticket → --json outcome and non-null refinementProposal, exit 0", () => {
  createTicket(
    "FG-002",
    { type: "story", status: "active", title: "Needs work" },
    "## Problem\nSomething.\n",
  );

  const result = runReadiness(["FG-002", "--json", "--project", projectDir]);
  assert.equal(result.status, 0, `must exit 0 even for not-ready: ${result.stderr}`);

  const parsed = JSON.parse(result.stdout) as {
    ticketId: string;
    outcome: string;
    gaps: string[];
    refinementProposal: string | null;
  };
  assert.equal(parsed.ticketId, "FG-002");
  assert.equal(parsed.outcome, "needs_refinement");
  assert.ok(parsed.gaps.length > 0, "gaps must be non-empty");
  assert.ok(parsed.refinementProposal !== null, "refinementProposal must be non-null");
});

test("integ readiness: blocked ticket → --json outcome=blocked, exit 0", () => {
  createTicket(
    "FG-003",
    { type: "story", status: "blocked", title: "Blocked ticket" },
    "## Problem\nBlocked.\n",
  );

  const result = runReadiness(["FG-003", "--json", "--project", projectDir]);
  assert.equal(result.status, 0, `exit non-zero: ${result.stderr}`);

  const parsed = JSON.parse(result.stdout) as { outcome: string };
  assert.equal(parsed.outcome, "blocked");
});

test("integ readiness: idea ticket → --json outcome=exploratory, exit 0", () => {
  createTicket(
    "FG-004",
    { type: "idea", status: "active", title: "Some idea" },
    "## Problem\nExplore this domain.\n",
  );

  const result = runReadiness(["FG-004", "--json", "--project", projectDir]);
  assert.equal(result.status, 0, `exit non-zero: ${result.stderr}`);

  const parsed = JSON.parse(result.stdout) as { outcome: string; refinementProposal: string | null };
  assert.equal(parsed.outcome, "exploratory");
  assert.equal(parsed.refinementProposal, null);
});

test("integ readiness: human-readable output for ready ticket contains outcome", () => {
  createTicket(
    "FG-005",
    { type: "story", status: "active", title: "Ready" },
    "## Problem\nFoo.\n\n## Goal\nBar.\n\n## Acceptance Criteria\n- Baz.\n",
  );

  const result = runReadiness(["FG-005", "--project", projectDir]);
  assert.equal(result.status, 0, `exit non-zero: ${result.stderr}`);
  assert.ok(result.stdout.includes("ready"), `expected 'ready' in output: ${result.stdout}`);
});

test("integ readiness: no project writes occur", () => {
  createTicket(
    "FG-006",
    { type: "story", status: "active", title: "No writes" },
    "## Problem\nSomething.\n",
  );

  const before = readdirSync(join(projectDir, "backlog", "stories")).join(",");
  runReadiness(["FG-006", "--project", projectDir]);
  const after = readdirSync(join(projectDir, "backlog", "stories")).join(",");
  assert.equal(before, after, "forge readiness must not write to the project");
});

test("integ readiness: missing ticket id → non-zero exit with clear message", () => {
  const result = runReadiness(["FG-999", "--project", projectDir]);
  assert.notEqual(result.status, 0, "must exit non-zero when ticket not found");
  const combined = (result.stderr ?? "") + (result.stdout ?? "");
  assert.ok(
    /FG-999/i.test(combined) || /not found/i.test(combined) || /error/i.test(combined),
    `expected an error mentioning FG-999 or 'not found', got: ${combined}`,
  );
});

test("integ readiness: blocked ticket → --json has all 4 required fields", () => {
  createTicket(
    "FG-007",
    { type: "story", status: "blocked", title: "Blocked story" },
    "## Problem\nBlocked.\n\n## Goal\nUnblock.\n\n## Acceptance Criteria\n- Unblocked.\n",
  );

  const result = runReadiness(["FG-007", "--json", "--project", projectDir]);
  assert.equal(result.status, 0, `exit non-zero: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as {
    ticketId: string;
    outcome: string;
    gaps: string[];
    refinementProposal: string | null;
  };
  assert.equal(parsed.ticketId, "FG-007");
  assert.equal(parsed.outcome, "blocked");
  assert.ok(Array.isArray(parsed.gaps), "gaps must be array");
  assert.ok(parsed.gaps.length > 0, "blocked gap must be non-empty");
  assert.ok(parsed.refinementProposal !== null, "refinementProposal must be non-null for blocked");
});

test("integ readiness: exploratory idea with no Problem/Goal → --json has gaps and non-null refinementProposal", () => {
  createTicket(
    "FG-008",
    { type: "idea", status: "active", title: "Rough idea" },
    "## Notes\nJust some notes.",
  );

  const result = runReadiness(["FG-008", "--json", "--project", projectDir]);
  assert.equal(result.status, 0, `exit non-zero: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as {
    outcome: string;
    gaps: string[];
    refinementProposal: string | null;
  };
  assert.equal(parsed.outcome, "exploratory");
  assert.ok(parsed.gaps.length > 0, "gaps must be non-empty when both Problem and Goal are missing");
  assert.ok(parsed.refinementProposal !== null, "refinementProposal must be non-null");
});

test("integ readiness: human-readable output for blocked ticket contains 'blocked'", () => {
  createTicket(
    "FG-009",
    { type: "story", status: "blocked", title: "Blocked" },
    "## Problem\nBlocked.\n",
  );

  const result = runReadiness(["FG-009", "--project", projectDir]);
  assert.equal(result.status, 0, `exit non-zero: ${result.stderr}`);
  assert.ok(result.stdout.includes("blocked"), `expected 'blocked' in output: ${result.stdout}`);
});

test("integ readiness: human-readable output for exploratory ticket contains 'exploratory'", () => {
  createTicket(
    "FG-010",
    { type: "idea", status: "active", title: "Idea ticket" },
    "## Problem\nExplore this.\n",
  );

  const result = runReadiness(["FG-010", "--project", projectDir]);
  assert.equal(result.status, 0, `exit non-zero: ${result.stderr}`);
  assert.ok(result.stdout.includes("exploratory"), `expected 'exploratory' in output: ${result.stdout}`);
});

test("integ readiness: human-readable output for needs_refinement ticket shows gaps", () => {
  createTicket(
    "FG-011",
    { type: "story", status: "active", title: "Incomplete story" },
    "## Problem\nSomething.\n",
  );

  const result = runReadiness(["FG-011", "--project", projectDir]);
  assert.equal(result.status, 0, `exit non-zero: ${result.stderr}`);
  assert.ok(
    result.stdout.toLowerCase().includes("gaps") || result.stdout.toLowerCase().includes("goal") || result.stdout.toLowerCase().includes("acceptance"),
    `expected gap info in output: ${result.stdout}`,
  );
});

test("integ readiness: --json output is parseable JSON on stdout for all four outcomes", () => {
  const cases: Array<[string, string, Record<string, string>, string, string]> = [
    ["FG-020", "ready", { type: "story", status: "active", title: "Ready" }, "## Problem\nP.\n\n## Goal\nG.\n\n## Acceptance Criteria\n- AC.\n", "ready"],
    ["FG-021", "needs_refinement", { type: "story", status: "active", title: "NeedsWork" }, "## Problem\nP.\n", "needs_refinement"],
    ["FG-022", "blocked", { type: "story", status: "blocked", title: "Blocked" }, "## Problem\nP.\n", "blocked"],
    ["FG-023", "exploratory", { type: "idea", status: "active", title: "Idea" }, "## Problem\nP.\n", "exploratory"],
  ];

  for (const [id, , fm, body, expectedOutcome] of cases) {
    createTicket(id, fm, body);
    const result = runReadiness([id, "--json", "--project", projectDir]);
    assert.equal(result.status, 0, `[${id}] must exit 0: ${result.stderr}`);
    let parsed: { ticketId: string; outcome: string; gaps: string[]; refinementProposal: string | null };
    try {
      parsed = JSON.parse(result.stdout) as typeof parsed;
    } catch {
      assert.fail(`[${id}] stdout is not valid JSON: ${result.stdout}`);
    }
    assert.equal(parsed.ticketId, id, `[${id}] ticketId mismatch`);
    assert.equal(parsed.outcome, expectedOutcome, `[${id}] outcome mismatch`);
    assert.ok(Array.isArray(parsed.gaps), `[${id}] gaps must be array`);
    assert.ok("refinementProposal" in parsed, `[${id}] refinementProposal field must exist`);
  }
});

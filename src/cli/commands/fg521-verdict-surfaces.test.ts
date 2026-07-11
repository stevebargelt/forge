// FG-521 (a)/(b) — the gaps around the engineer's own show.test.ts additions.
//
// The engineer proved the redTaskId is PRINTED and that --json carries a
// verdicts array. These tests prove the two things that make those changes
// worth anything to an operator:
//
//   1. Copy-pasteability: the `forge show <redTaskId>` next-command a
//      blocked_by_red task suggests is RUNNABLE from data on screen — the id
//      token in the rendered Verdicts section resolves to a real task.
//      Printing an id that doesn't resolve, or suggesting a command whose
//      argument appears nowhere in the output, would both pass the engineer's
//      tests and still leave the operator stuck.
//
//   2. Contract shape: the --json verdict elements carry EVERY field the human
//      renderer reads, with the same values — so the two surfaces can't
//      silently diverge field-wise. Asserted by reconstructing the human lines
//      FROM the JSON and demanding they appear verbatim in the human output.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import { insertVerdict } from "../../store/verdicts.js";
import { performShow, registerShow } from "./show.js";
import type { Run, Task } from "../../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = {
  id: "run-fg521",
  workflow: "feature",
  title: "fg521 verdict surfaces",
  status: "active",
  createdAt: "2026-07-11T10:00:00Z",
};

const BLOCKED = "task-fg521-engineer";
const RED_WIDE = "task-fg521-red-wide";
const RED_SECURITY = "task-fg521-red-security";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  const phase = overrides.phase ?? "engineer";
  const role = overrides.agentRole ?? "engineer";
  return {
    id,
    runId: RUN.id,
    phase,
    agentRole: role,
    status: overrides.status ?? "complete",
    taskPackage: {
      taskId: id,
      runId: RUN.id,
      phase,
      role,
      inputs: { brief: "do the thing" },
      composedSystemPrompt: "",
    },
    createdAt: "2026-07-11T10:00:00Z",
  };
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);

  // The blocked_by_red shape: a primary task whose reds returned verdicts, and
  // the red child tasks those verdicts point at.
  insertTask(makeTask(BLOCKED, { status: "blocked_by_red" }));
  insertTask(makeTask(RED_WIDE, { agentRole: "red-wide", phase: "red" }));
  insertTask(makeTask(RED_SECURITY, { agentRole: "red-security", phase: "red" }));

  insertVerdict({
    id: "v-fg521-1",
    taskId: BLOCKED,
    redTaskId: RED_WIDE,
    redRole: "red-wide",
    verdict: "fail",
    confidence: 0.85,
    authority: "authoritative",
    findings: [
      { severity: "high", summary: "unguarded write path", evidence: "src/x.ts:12", hypothesis: "lost update" },
      { severity: "low", summary: "stale comment", evidence: "src/x.ts:40", hypothesis: "cosmetic" },
    ],
    createdAt: "2026-07-11T10:05:00Z",
  });
  insertVerdict({
    id: "v-fg521-2",
    taskId: BLOCKED,
    redTaskId: RED_SECURITY,
    redRole: "red-security",
    verdict: "pass",
    confidence: 0.7,
    authority: "specialist",
    findings: [],
    createdAt: "2026-07-11T10:06:00Z",
  });
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

async function renderShowCli(args: string[]): Promise<string> {
  const lines: string[] = [];
  mock.method(console, "log", (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  try {
    const program = new Command();
    registerShow(program);
    await program.parseAsync(args, { from: "user" });
    return lines.join("\n");
  } finally {
    mock.restoreAll();
  }
}

/** The ids an operator can actually read off the rendered Verdicts section —
 *  extracted the way a human does it: the token after the em-dash on each
 *  verdict line. Deliberately does NOT reuse the ids the fixture inserted. */
function idsFromRenderedVerdictLines(out: string): string[] {
  const ids: string[] = [];
  for (const line of out.split("\n")) {
    const m = /^ {2}- \S+ \(\w+\): \w+ \(\d\.\d{2}\) — (\S+)$/.exec(line);
    if (m) ids.push(m[1]!);
  }
  return ids;
}

test("FG-521: the redTaskId printed in the Verdicts section is a RUNNABLE argument for the suggested next-command", async () => {
  const out = await renderShowCli(["show", BLOCKED]);

  // The suggestion the operator is handed for a blocked_by_red task.
  assert.match(out, /forge show <redTaskId>/, "blocked_by_red must suggest `forge show <redTaskId>`");

  // The only ids on screen to substitute for <redTaskId> are the ones in the
  // Verdicts section. If that list is empty the suggestion is unrunnable.
  const printedIds = idsFromRenderedVerdictLines(out);
  assert.equal(printedIds.length, 2, `expected an id on each verdict line, got: ${JSON.stringify(printedIds)}`);

  // Close the loop: each printed id resolves — `forge show <that-id>` is a task.
  for (const id of printedIds) {
    const resolved = performShow(id);
    assert.equal(resolved.kind, "task", `printed id ${id} must resolve to a task, not ${resolved.kind}`);
    if (resolved.kind === "task") {
      assert.equal(resolved.task.id, id);
      assert.match(resolved.task.agentRole, /^red-/, `${id} must be the RED task whose findings the operator is being sent to read`);
      assert.equal(resolved.task.runId, RUN.id);
    }
  }
});

test("FG-521: `forge show <printed redTaskId>` actually runs — the CLI resolves the pasted id instead of throwing Not found", async () => {
  const printedIds = idsFromRenderedVerdictLines(await renderShowCli(["show", BLOCKED]));
  const pasted = printedIds[0]!;

  // Drive the real CLI with the token an operator would paste. `forge show`
  // throws `Not found: <id>` on an unresolvable id — this must not throw.
  const redOut = await renderShowCli(["show", pasted]);
  assert.match(redOut, new RegExp(pasted), "the red task's own show output must be about the pasted id");
  assert.match(redOut, /red-wide/);
});

test("FG-521: a task with NO verdicts prints no verdict-id lines — nothing to paste, and nothing false on screen", async () => {
  insertTask(makeTask("task-fg521-clean", { status: "complete" }));
  const out = await renderShowCli(["show", "task-fg521-clean"]);
  assert.deepEqual(idsFromRenderedVerdictLines(out), []);
  assert.doesNotMatch(out, /^Verdicts:$/m);
});

test("FG-521: --json verdict elements carry every field the human renderer reads — the human lines reconstruct from the JSON verbatim", async () => {
  const jsonOut = await renderShowCli(["show", BLOCKED, "--json"]);
  const humanOut = await renderShowCli(["show", BLOCKED]);

  const parsed = JSON.parse(jsonOut) as { verdicts: Array<Record<string, unknown>> };
  assert.equal(parsed.verdicts.length, 2, "--json must carry both verdicts");

  // The exact field set the human renderer in show.ts reads from each verdict.
  const HUMAN_READS = ["redTaskId", "redRole", "authority", "verdict", "confidence", "findings"] as const;

  for (const v of parsed.verdicts) {
    for (const field of HUMAN_READS) {
      assert.ok(field in v, `--json verdict element is missing '${field}' — the human path renders it, so the surfaces have diverged`);
      assert.notEqual(v[field], undefined, `--json verdict element has undefined '${field}'`);
    }

    // Reconstruct the human line FROM the JSON. If either surface changes a
    // field name, a value, or the formatting contract (confidence to 2dp),
    // this stops matching — that's the point.
    const expected =
      `  - ${String(v.redRole)} (${String(v.authority)}): ${String(v.verdict)} ` +
      `(${(v.confidence as number).toFixed(2)}) — ${String(v.redTaskId)}`;
    assert.ok(
      humanOut.split("\n").includes(expected),
      `human output has no line matching the JSON element:\n  expected: ${expected}\n  human:\n${humanOut}`,
    );

    // Findings too — same data, same severity/summary fields, on both surfaces.
    const findings = v.findings as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(findings));
    for (const f of findings) {
      assert.ok("severity" in f && "summary" in f, "finding element must carry the severity/summary the human path prints");
      assert.ok(
        humanOut.split("\n").includes(`      [${String(f.severity)}] ${String(f.summary)}`),
        `human output is missing the finding the JSON carries: [${String(f.severity)}] ${String(f.summary)}`,
      );
    }
  }

  // And the id the JSON consumer would use is the same one the human sees —
  // one contract, two renderings.
  assert.deepEqual(
    parsed.verdicts.map((v) => String(v.redTaskId)),
    idsFromRenderedVerdictLines(humanOut),
  );
});

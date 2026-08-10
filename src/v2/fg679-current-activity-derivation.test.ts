// FG-679: the ONE shared Current-activity derivation.
//
// This is the module `/status` and the dashboard BOTH call, so the honesty
// properties are asserted here once and inherited by both surfaces:
//   BD-1  three DISJOINT sections; a launch is never an agent task
//   BD-4  four distinct launch statuses, rendered by statusLine, none generic
//   BD-5  the exact candidate sha with EVERY required context enumerated
//   BD-6  an old-sha observation DISAPPEARS when the candidate moves
//   BD-8  `CI not observed` / `CI not running` / `stale` are three different facts
//   BD-12 a stale observation reads `unobserved since <t>` — never running, never terminal
//   BD-2  placement is authorized by submission metadata alone

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "../store/db.js";
import { recordLaunchObservation, type LaunchPurpose } from "../store/launch-observations.js";
import { statusLine, type LaunchStatus } from "./launch.js";
import {
  CI_NOT_OBSERVED_LABEL,
  CI_NOT_RUNNING_LABEL,
  CI_OBSERVATION_FRESH_MS,
  CI_OBSERVED_EVENT_TYPE,
  CI_RUNNING_LABEL,
  LAUNCH_OBSERVATION_FRESH_MS,
  deriveCurrentActivity,
  renderCurrentActivityLines,
} from "./current-activity.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const NOW = new Date("2026-08-05T12:00:00.000Z");
const PROJECT = "/repos/forge";

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  getDb().prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, 'feature', ?, 'active', ?, ?)`)
    .run("run-fg679", "surface in-flight host verification", "2026-08-05T11:00:00.000Z", PROJECT);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

function addTask(id: string, status: string): void {
  getDb().prepare(`INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at) VALUES (?, 'run-fg679', 'build', 'engineer', ?, '{}', ?, ?)`)
    .run(id, status, "2026-08-05T11:30:00.000Z", "2026-08-05T11:30:00.000Z");
}

/** FG-700: every launch here DECLARES a purpose, because that is now the only thing
 *  that puts one under `Host verification`. The default is `host_verification` since
 *  this suite's subject IS that section — a fixture that wants a different kind, or a
 *  legacy row that declared nothing (`purpose: null`), says so explicitly. */
function addLaunch(opts: {
  id: string;
  status?: LaunchStatus;
  observedAt?: string;
  association?: { runId?: string; taskId?: string; ticketId?: string };
  projectDir?: string | null;
  name?: string;
  command?: string[];
  cwd?: string;
  purpose?: LaunchPurpose | null;
}): void {
  const purpose = opts.purpose === undefined ? "host_verification" : opts.purpose;
  recordLaunchObservation({
    launchId: opts.id,
    name: opts.name ?? opts.id,
    command: opts.command ?? ["npm", "run", "test:worktree"],
    cwd: opts.cwd ?? PROJECT,
    projectDir: opts.projectDir === undefined ? PROJECT : opts.projectDir,
    ...(opts.association ? { association: opts.association } : {}),
    ...(purpose === null ? {} : { purpose }),
    startedAt: "2026-08-05T11:50:00.000Z",
    observedAt: opts.observedAt ?? "2026-08-05T11:59:00.000Z",
    status: opts.status ?? { state: "running" },
  });
}

/** A row as a PRE-FG-700 binary wrote it: no purpose column value at all. Written with
 *  raw SQL because the recorder now always writes one, and "the column is NULL" is the
 *  legacy shape the fail-closed rule exists for. */
function addLegacyLaunch(id: string, runId: string | null): void {
  getDb().prepare(`
    INSERT INTO launch_observations (launch_id, name, command, cwd, project_dir, association_kind, run_id, started_at, observed_at, state, terminal)
    VALUES (?, ?, ?, ?, ?, ?, ?, '2026-08-05T11:50:00.000Z', '2026-08-05T11:59:00.000Z', 'running', 0)
  `).run(id, id, JSON.stringify(["npm", "run", "test:worktree"]), PROJECT, PROJECT, runId === null ? "cwd" : "explicit", runId);
}

function addCiEvent(payload: Record<string, unknown>, createdAt: string, runId: string | null = "run-fg679"): void {
  getDb().prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`)
    .run(runId, CI_OBSERVED_EVENT_TYPE, JSON.stringify(payload), createdAt);
}

const contexts = (state: string) => [
  { context: "test", state, url: "https://github.com/o/r/actions/runs/1", observedAt: "2026-08-05T11:59:30.000Z" },
  { context: "test-extended", state, url: "https://github.com/o/r/actions/runs/2", observedAt: "2026-08-05T11:59:31.000Z" },
];

describe("FG-679 BD-1 — three disjoint sections; a launch is never an agent task", () => {
  test("a run whose ONLY in-flight work is a host launch shows it under Host verification and NO agent task", () => {
    addLaunch({ id: "launch-worktree-aaaaaa", association: { runId: "run-fg679" } });
    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });

    assert.equal(activity.agents.length, 0, "no agent task is in flight");
    assert.equal(activity.hostVerification.length, 1);
    assert.equal(activity.hostVerification[0]!.launchId, "launch-worktree-aaaaaa");

    // And the RENDERED surface carries all three section headings, distinctly.
    const rendered = renderCurrentActivityLines(activity).join("\n");
    assert.match(rendered, /^Current activity$/m);
    assert.match(rendered, /^ {2}Agents$/m);
    assert.match(rendered, /^ {2}Host verification$/m);
    assert.match(rendered, /^ {2}Required CI$/m);
    assert.match(rendered, /\(no agent task in flight\)/);
    assert.match(rendered, /launch-worktree-aaaaaa/);
  });

  test("an agent task and a launch appear in DIFFERENT sections — neither leaks into the other", () => {
    addTask("task-build-1", "running");
    addLaunch({ id: "launch-worktree-bbbbbb", association: { runId: "run-fg679" } });
    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    assert.deepEqual(activity.agents.map((a) => a.taskId), ["task-build-1"]);
    assert.deepEqual(activity.hostVerification.map((l) => l.launchId), ["launch-worktree-bbbbbb"]);
    assert.equal(activity.agents.some((a) => a.taskId.startsWith("launch-")), false);
  });
});

describe("FG-679 BD-4 — four launch statuses, four distinct rendered surfaces, none generic", () => {
  test("signaled / terminated_unattributed(143) / owner_gone / unknown render four DISTINCT statusLine strings", () => {
    const four: Array<[string, LaunchStatus]> = [
      ["launch-sig-aaaaaa", { state: "signaled", signal: "SIGTERM", sender: "unrecorded" }],
      ["launch-143-bbbbbb", { state: "terminated_unattributed", code: 143 }],
      ["launch-owner-cccccc", { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" }],
      ["launch-unk-dddddd", { state: "unknown" }],
    ];
    // Terminal rows leave the in-flight set (BD-16), so this asserts the RENDERING
    // directly against the one canonical renderer the surface uses.
    const rendered = four.map(([, status]) => statusLine(status));
    assert.equal(new Set(rendered).size, 4, `four distinct surfaces, got ${JSON.stringify(rendered)}`);
    for (const line of rendered) {
      assert.notEqual(line.trim().toLowerCase(), "failed");
      assert.doesNotMatch(line, /^\s*failed\b/i);
    }
    assert.equal(rendered[0], "terminated by SIGTERM (signal sender not recorded — origin unknown)");
    assert.equal(rendered[1], "exited 143 (signal-range code, no signal evidence — origin unknown)");
    assert.notEqual(rendered[0], rendered[1], "a SIGTERM record and a bare 143 exit code are NOT the same fact");
  });

  test("a FRESH running launch renders byte-identically to statusLine, not a paraphrase", () => {
    addLaunch({ id: "launch-run-eeeeee", association: { runId: "run-fg679" } });
    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    assert.equal(activity.hostVerification[0]!.statusLabel, statusLine({ state: "running" }));
    assert.equal(activity.hostVerification[0]!.statusLabel, "running");
  });
});

describe("FG-679 BD-12 — freshness is a fact about the observer, not about the work", () => {
  test("with a fresh `running` row and NO tmux and NO launch fs record, the derivation answers 'yes, running' from persisted state alone", () => {
    // Nothing here touches ~/.forge/launches and nothing probes tmux — the row IS
    // the evidence. This is the question the ticket exists for.
    addLaunch({ id: "launch-live-ffffff", association: { runId: "run-fg679" }, observedAt: "2026-08-05T11:59:00.000Z" });
    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    assert.equal(activity.hostVerification.length, 1);
    assert.equal(activity.hostVerification[0]!.observation, "fresh");
    assert.equal(activity.hostVerification[0]!.statusLabel, "running");
  });

  test("a row past the cutoff renders literally `unobserved since <time>` — neither running nor any terminal status", () => {
    const observedAt = new Date(NOW.getTime() - LAUNCH_OBSERVATION_FRESH_MS - 60_000).toISOString();
    addLaunch({ id: "launch-stale-gggggg", association: { runId: "run-fg679" }, observedAt });
    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    const entry = activity.hostVerification[0]!;

    assert.equal(entry.statusLabel, `unobserved since ${observedAt}`);
    assert.equal(entry.observation, "unobserved");
    // Not `running`…
    assert.notEqual(entry.statusLabel, statusLine({ state: "running" }));
    // …and not ANY terminal disposition.
    const terminalRenderings = [
      statusLine({ state: "exited_ok", code: 0 }),
      statusLine({ state: "exited_error", code: 1 }),
      statusLine({ state: "signaled", signal: "SIGTERM", sender: "unrecorded" }),
      statusLine({ state: "terminated_unattributed", code: 143 }),
      statusLine({ state: "owner_gone", cause: "unrecorded", sender: "unrecorded" }),
      statusLine({ state: "unknown" }),
    ];
    for (const t of terminalRenderings) assert.notEqual(entry.statusLabel, t);
    // The RECORDED evidence is still available and still says what it said.
    assert.deepEqual(entry.recordedStatus, { state: "running" });
    assert.deepEqual(entry.status, { state: "unknown" }, "the EFFECTIVE status of a stale row is `unknown`");

    assert.match(renderCurrentActivityLines(activity).join("\n"), new RegExp(`unobserved since ${observedAt}`));
  });

  test("an unparseable observation time is not fresh evidence either", () => {
    addLaunch({ id: "launch-baddate-hhhhhh", association: { runId: "run-fg679" }, observedAt: "not-a-date" });
    const entry = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } }).hostVerification[0]!;
    assert.equal(entry.observation, "unobserved");
  });

  test("a FUTURE-dated observation is unusable evidence, not maximally fresh — the surface never asserts `running` from a time that has not occurred", () => {
    // Clock skew, a corrected system clock, an imported row. `now - observed <= cutoff`
    // is trivially true for a NEGATIVE difference, so a one-sided bound rendered this
    // as the freshest possible evidence of a running launch.
    const observedAt = new Date(NOW.getTime() + 6 * 60 * 60_000).toISOString();
    addLaunch({ id: "launch-future-hhhhh1", association: { runId: "run-fg679" }, observedAt });
    const entry = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } }).hostVerification[0]!;

    assert.equal(entry.observation, "unobserved");
    assert.notEqual(entry.statusLabel, statusLine({ state: "running" }), "never `running` from an observation time in the future");
    assert.equal(entry.statusLabel, `unobserved since ${observedAt}`);
    assert.deepEqual(entry.status, { state: "unknown" });
    assert.deepEqual(entry.recordedStatus, { state: "running" }, "the row still says what it said");
  });

  test("a TERMINAL row has left the in-flight set entirely (BD-16)", () => {
    addLaunch({ id: "launch-done-iiiiii", association: { runId: "run-fg679" }, status: { state: "exited_ok", code: 0 } });
    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    assert.equal(activity.hostVerification.length, 0);
  });
});

describe("FG-679 BD-2/BD-3/BD-14 — placement", () => {
  test("a launch whose NAME, ARGV and cwd are full of a run id it was never associated with is NOT attributed to it", () => {
    addLaunch({
      id: "launch-run-abc123-fg679-plan-jjjjjj",
      name: "launch-run-abc123-fg679-plan",
      command: ["npm", "run", "test:worktree", "--", "run-abc123", "task-plan-51d71e"],
      cwd: "/home/op/.forge/worktrees/run-abc123/task-plan-51d71e",
      projectDir: null,
    });
    getDb().prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES ('run-abc123', 'feature', 'other', 'active', '2026-08-05T09:00:00.000Z', ?)`).run(PROJECT);

    const onThatRun = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-abc123" } });
    assert.equal(onThatRun.hostVerification.length, 0, "argv/name text must never authorize run placement");

    const hostWide = deriveCurrentActivity(db, { now: NOW });
    assert.deepEqual(hostWide.unassociated.map((l) => l.launchId), ["launch-run-abc123-fg679-plan-jjjjjj"]);
    assert.equal(hostWide.unassociated[0]!.unassociated, true);
    assert.equal(hostWide.unassociated[0]!.placement, "host");
    assert.match(renderCurrentActivityLines(hostWide).join("\n"), /^ {2}Unassociated activity$/m);
  });

  test("an explicitly associated launch appears on BOTH its run and its project", () => {
    addLaunch({ id: "launch-both-kkkkkk", association: { runId: "run-fg679" } });
    const onRun = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    const onProject = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [PROJECT] } });
    assert.deepEqual(onRun.hostVerification.map((l) => l.launchId), ["launch-both-kkkkkk"]);
    assert.deepEqual(onProject.hostVerification.map((l) => l.launchId), ["launch-both-kkkkkk"]);
    assert.equal(onRun.hostVerification[0]!.unassociated, false);
  });

  test("a cwd-associated launch appears at PROJECT level ONLY, labeled `unassociated`, and never on a run", () => {
    addLaunch({ id: "launch-cwd-llllll" }); // projectDir resolved, no explicit metadata
    const onRun = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    const onProject = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [PROJECT] } });
    assert.equal(onRun.hostVerification.length, 0);
    assert.deepEqual(onProject.hostVerification.map((l) => l.launchId), ["launch-cwd-llllll"]);
    assert.equal(onProject.hostVerification[0]!.unassociated, true);
    assert.equal(onProject.hostVerification[0]!.associationKind, "cwd");
    assert.match(renderCurrentActivityLines(onProject).join("\n"), /\[unassociated\]/);
  });

  test("the host-level bucket is HOST-level: it is not surfaced inside a project or run scope", () => {
    addLaunch({ id: "launch-orphan-mmmmmm", projectDir: null });
    assert.equal(deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [PROJECT] } }).unassociated.length, 0);
    assert.equal(deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } }).unassociated.length, 0);
    assert.equal(deriveCurrentActivity(db, { now: NOW }).unassociated.length, 1);
  });

  test("the bucket is the LAST tier, not a dumping ground: an EXPLICITLY associated launch in a per-task worktree lands on its run, not in the bucket", () => {
    // The ticket's own 2026-08-04 case, once `--run` is supplied: the launch ran in
    // ~/.forge/worktrees, which maps to no registered project home, but explicit
    // submission metadata places it anyway.
    addLaunch({
      id: "launch-worktree-nnnnnn",
      association: { runId: "run-fg679" },
      projectDir: null,
      cwd: "/home/op/.forge/worktrees/run-fg679/task-build-0",
    });
    assert.deepEqual(
      deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } }).hostVerification.map((l) => l.launchId),
      ["launch-worktree-nnnnnn"],
    );
    const hostWide = deriveCurrentActivity(db, { now: NOW });
    assert.deepEqual(hostWide.hostVerification.map((l) => l.launchId), ["launch-worktree-nnnnnn"]);
    assert.equal(hostWide.hostVerification[0]!.placement, "run");
    assert.equal(hostWide.unassociated.length, 0, "an explicitly associated launch is never in the unassociated bucket");
  });

  test("no host filesystem path is carried on a launch entry", () => {
    addLaunch({ id: "launch-nopath-nnnnnn", association: { runId: "run-fg679" } });
    const entry = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } }).hostVerification[0]!;
    assert.equal("cwd" in entry, false);
    assert.equal("logPath" in entry, false);
  });
});

// ─────────────────────────────────── FG-700 ───────────────────────────────────
//
// WHAT A LAUNCH IS, versus WHERE IT BELONGS. Before FG-700 there was no purpose field
// at all, so this derivation used PLACEMENT as a proxy for it: every non-terminal
// launch that passed the scope test rendered under `Host verification`. On 2026-08-10
// that labelled `forge invoke engineer`, `forge invoke test-engineer`, `forge invoke
// documentation-maintainer` and `forge review start/continue` as host verification —
// work the agent-task surface was already showing, presented as a wait nobody had.
//
// The ENFORCEMENT half is what these tests are mostly about: a launch that declared
// nothing, or declared something this binary cannot read, is NOT host verification.
// Failing closed to the generic bucket is the whole property; the positive case is one
// assertion and the negative cases are the rest.

describe("FG-700 — only a DECLARED host verification renders as one", () => {
  test("AC7 — the 2026-08-10 live shape: four associated agent/review/campaign launches plus one real verification", () => {
    // Every one of these carries `--run` and would have rendered as host verification
    // before FG-700. Only the last DECLARED that it is one.
    addLaunch({ id: "launch-engineer-aa0001", association: { runId: "run-fg679", ticketId: "MG-49" }, purpose: "agent_invoke", command: ["forge", "invoke", "engineer"] });
    addLaunch({ id: "launch-tester-aa0002", association: { runId: "run-fg679", ticketId: "MG-49" }, purpose: "agent_invoke", command: ["forge", "invoke", "test-engineer"] });
    addLaunch({ id: "launch-docs-aa0003", association: { runId: "run-fg679", ticketId: "FG-683" }, purpose: "agent_invoke", command: ["forge", "invoke", "documentation-maintainer"] });
    addLaunch({ id: "launch-review-aa0004", association: { runId: "run-fg679", ticketId: "FG-683" }, purpose: "review", command: ["forge", "review", "continue", "FG-683"] });
    addLaunch({ id: "launch-verify-aa0005", association: { runId: "run-fg679", ticketId: "FG-700" }, purpose: "host_verification" });

    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    assert.deepEqual(activity.hostVerification.map((l) => l.launchId), ["launch-verify-aa0005"],
      "EXACTLY the launch that declared host verification");

    // …and none of the other four is hidden: they are all still in flight, under a
    // heading that does not claim they are verification (AC3 + the diagnostics rule).
    assert.deepEqual(activity.launches.map((l) => l.launchId).sort(), [
      "launch-docs-aa0003", "launch-engineer-aa0001", "launch-review-aa0004", "launch-tester-aa0002",
    ]);
    const rendered = renderCurrentActivityLines(activity).join("\n");
    assert.match(rendered, /^ {2}Launch activity$/m);
    for (const id of ["launch-engineer-aa0001", "launch-tester-aa0002", "launch-docs-aa0003", "launch-review-aa0004"]) {
      assert.match(rendered, new RegExp(id), `${id} must still be visible as a launch diagnostic`);
    }
    // The four are BELOW the Host verification heading's own rows, never among them.
    const lines = renderCurrentActivityLines(activity);
    const hostHeading = lines.indexOf("  Host verification");
    const launchHeading = lines.indexOf("  Launch activity");
    for (const id of ["launch-engineer-aa0001", "launch-review-aa0004"]) {
      assert.ok(lines.findIndex((l) => l.includes(id)) > launchHeading, `${id} renders under Launch activity`);
    }
    assert.ok(lines.findIndex((l) => l.includes("launch-verify-aa0005")) > hostHeading);
    assert.ok(lines.findIndex((l) => l.includes("launch-verify-aa0005")) < launchHeading);
  });

  test("AC5 (fail closed) — a LEGACY row with no purpose at all is not host verification", () => {
    addLegacyLaunch("launch-legacy-bb0001", "run-fg679");
    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    // Non-vacuous: it is associated with the run, fresh, and running — every pre-FG-700
    // condition for the host-verification section is met, and only the absent
    // declaration excludes it.
    assert.deepEqual(activity.launches.map((l) => l.launchId), ["launch-legacy-bb0001"]);
    assert.equal(activity.launches[0]!.statusLabel, "running");
    assert.equal(activity.launches[0]!.runId, "run-fg679");
    assert.equal(activity.launches[0]!.purpose, "generic", "an absent declaration reads `generic`");
    assert.deepEqual(activity.hostVerification, []);
  });

  test("AC5 (fail closed) — an UNRECOGNIZED purpose is not host verification either", () => {
    // A newer binary sharing ~/.forge/forge.db wrote a purpose this one has never heard
    // of. The honest reading is the WEAKEST one, never the most specific.
    addLaunch({ id: "launch-x-bb0002", association: { runId: "run-fg679" }, purpose: "host_verification" });
    getDb().prepare(`UPDATE launch_observations SET purpose = ? WHERE launch_id = ?`).run("host_verification_v2", "launch-x-bb0002");

    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    assert.deepEqual(activity.hostVerification, []);
    assert.deepEqual(activity.launches.map((l) => l.purpose), ["generic"]);
  });

  test("an empty-string purpose is an absent declaration, not a kind", () => {
    addLaunch({ id: "launch-empty-bb0003", association: { runId: "run-fg679" }, purpose: "host_verification" });
    getDb().prepare(`UPDATE launch_observations SET purpose = '' WHERE launch_id = ?`).run("launch-empty-bb0003");
    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    assert.deepEqual(activity.hostVerification, []);
    assert.deepEqual(activity.launches.map((l) => l.purpose), ["generic"]);
  });

  test("AC1/AC8 — purpose and association are SEPARATE: neither decides the other, at every scope", () => {
    // A declared host verification with NO association at all: purpose does not place
    // it on a run, and placement does not revoke its purpose.
    addLaunch({ id: "launch-hostwide-cc0001", purpose: "host_verification" });
    // An agent invoke that DID declare a run: the association still places it on that
    // run; the purpose still keeps it out of the host-verification section there.
    addLaunch({ id: "launch-invoke-cc0002", association: { runId: "run-fg679" }, purpose: "agent_invoke" });

    const onRun = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    assert.deepEqual(onRun.hostVerification, [], "purpose alone never places a launch on a run");
    assert.deepEqual(onRun.launches.map((l) => l.launchId), ["launch-invoke-cc0002"], "association still places it");

    const onProject = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [PROJECT] } });
    assert.deepEqual(onProject.hostVerification.map((l) => l.launchId), ["launch-hostwide-cc0001"]);
    assert.equal(onProject.hostVerification[0]!.unassociated, true,
      "…and it is still labeled `unassociated`: the purpose says nothing about placement");
    assert.deepEqual(onProject.launches.map((l) => l.launchId), ["launch-invoke-cc0002"]);
  });

  test("the two buckets are DISJOINT and together are every placed launch — nothing is dropped", () => {
    addLaunch({ id: "launch-hv-dd0001", association: { runId: "run-fg679" }, purpose: "host_verification" });
    addLaunch({ id: "launch-ai-dd0002", association: { runId: "run-fg679" }, purpose: "agent_invoke" });
    addLaunch({ id: "launch-rv-dd0003", association: { runId: "run-fg679" }, purpose: "review" });
    addLaunch({ id: "launch-cp-dd0004", association: { runId: "run-fg679" }, purpose: "campaign" });
    addLaunch({ id: "launch-db-dd0005", association: { runId: "run-fg679" }, purpose: "dashboard" });
    addLaunch({ id: "launch-gn-dd0006", association: { runId: "run-fg679" }, purpose: "generic" });

    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    const hv = activity.hostVerification.map((l) => l.launchId);
    const other = activity.launches.map((l) => l.launchId);
    assert.deepEqual(hv, ["launch-hv-dd0001"]);
    assert.deepEqual([...hv, ...other].sort(), [
      "launch-ai-dd0002", "launch-cp-dd0004", "launch-db-dd0005",
      "launch-gn-dd0006", "launch-hv-dd0001", "launch-rv-dd0003",
    ], "every placed launch is in exactly one of the two sections");
    assert.equal(hv.some((id) => other.includes(id)), false);
  });

  test("AC4 — a declared verification that goes TERMINAL or STALE renders no host-verification row", () => {
    addLaunch({ id: "launch-term-ee0001", association: { runId: "run-fg679" }, purpose: "host_verification", status: { state: "exited_ok", code: 0 } });
    assert.deepEqual(deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } }).hostVerification, [],
      "terminality is unchanged by FG-700 — a finished verification is not in flight");

    const observedAt = new Date(NOW.getTime() - LAUNCH_OBSERVATION_FRESH_MS - 60_000).toISOString();
    addLaunch({ id: "launch-stale-ee0002", association: { runId: "run-fg679" }, purpose: "host_verification", observedAt });
    const stale = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } }).hostVerification;
    assert.deepEqual(stale.map((l) => l.launchId), ["launch-stale-ee0002"]);
    assert.equal(stale[0]!.statusLabel, `unobserved since ${observedAt}`, "…and an unobserved one never claims to be running");
  });

  test("AC6 — the agent section is untouched by any of this: an agent task is not a launch and is counted once", () => {
    addTask("task-build-ff0001", "running");
    addLaunch({ id: "launch-invoke-ff0002", association: { runId: "run-fg679", taskId: "task-build-ff0001" }, purpose: "agent_invoke" });
    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    assert.deepEqual(activity.agents.map((a) => a.taskId), ["task-build-ff0001"]);
    assert.deepEqual(activity.hostVerification, []);
    assert.deepEqual(activity.launches.map((l) => l.launchId), ["launch-invoke-ff0002"]);
  });

  test("with nothing but non-verification launches, `Host verification` says so — and does not borrow one", () => {
    addLaunch({ id: "launch-invoke-gg0001", association: { runId: "run-fg679" }, purpose: "agent_invoke" });
    const rendered = renderCurrentActivityLines(deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } })).join("\n");
    assert.match(rendered, /\(no host launch observed in flight\)/);
    assert.match(rendered, /^ {2}Launch activity$/m);
    assert.match(rendered, /launch-invoke-gg0001/);
    assert.match(rendered, /\[agent_invoke\]/, "the row NAMES what it declared rather than leaving a reader to guess");
  });

  test("`Launch activity` renders only when there IS one — an empty bucket prints no heading", () => {
    addLaunch({ id: "launch-only-hh0001", association: { runId: "run-fg679" }, purpose: "host_verification" });
    const rendered = renderCurrentActivityLines(deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } })).join("\n");
    assert.doesNotMatch(rendered, /Launch activity/);
  });
});

describe("FG-679 BD-5/BD-6/BD-8 — required CI", () => {
  test("no event at all renders `CI not observed` — a fact about the OBSERVER, not about the checks", () => {
    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    assert.equal(activity.requiredCi.state, "not_observed");
    assert.equal(activity.requiredCi.label, CI_NOT_OBSERVED_LABEL);
    assert.match(renderCurrentActivityLines(activity).join("\n"), /CI not observed/);
  });

  test("BD-5: the exact candidate sha, and EVERY required context with state, URL and observation time", () => {
    const sha = "a".repeat(40);
    addCiEvent({
      attemptId: "attempt-1", ticketId: "FG-679", projectDir: PROJECT, candidateSha: sha,
      observedAt: "2026-08-05T11:59:40.000Z", outcome: "pending", unavailableReason: null, contexts: contexts("pending"),
    }, "2026-08-05T11:59:40.000Z");

    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    assert.equal(activity.requiredCi.state, "observed");
    const obs = activity.requiredCi.observations[0]!;
    assert.equal(obs.candidateSha, sha);
    assert.equal(obs.candidateSha.length, 40, "the FULL sha, never a short sha");
    assert.deepEqual(obs.contexts.map((c) => c.context), ["test", "test-extended"]);
    assert.equal(obs.contexts[0]!.state, "pending");
    assert.equal(obs.contexts[0]!.url, "https://github.com/o/r/actions/runs/1");
    assert.equal(obs.contexts[0]!.observedAt, "2026-08-05T11:59:30.000Z");
    assert.equal(obs.state, "running");
    assert.equal(obs.label, CI_RUNNING_LABEL);

    // The RENDERED surface names the sha and enumerates EACH context — a summary
    // verdict does not satisfy BD-5.
    const rendered = renderCurrentActivityLines(activity).join("\n");
    assert.match(rendered, new RegExp(`candidate ${sha}`));
    assert.match(rendered, /test: pending {2}https:\/\/github\.com\/o\/r\/actions\/runs\/1 {2}observed 2026-08-05T11:59:30\.000Z/);
    assert.match(rendered, /test-extended: pending/);
  });

  test("BD-6: when the candidate moves, the old-sha observation DISAPPEARS — never carried forward, never relabeled", () => {
    const oldSha = "a".repeat(40);
    const newSha = "b".repeat(40);
    addCiEvent({
      attemptId: "attempt-1", ticketId: "FG-679", projectDir: PROJECT, candidateSha: oldSha,
      observedAt: "2026-08-05T11:50:00.000Z", outcome: "pending", unavailableReason: null, contexts: contexts("pending"),
    }, "2026-08-05T11:50:00.000Z");

    let activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    assert.equal(activity.requiredCi.observations[0]!.candidateSha, oldSha);

    addCiEvent({
      attemptId: "attempt-2", ticketId: "FG-679", projectDir: PROJECT, candidateSha: newSha,
      observedAt: "2026-08-05T11:58:00.000Z", outcome: "pending", unavailableReason: null, contexts: contexts("queued"),
    }, "2026-08-05T11:58:00.000Z");

    activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    assert.equal(activity.requiredCi.observations.length, 1, "only the newest observation is presented");
    assert.equal(activity.requiredCi.observations[0]!.candidateSha, newSha);
    const rendered = renderCurrentActivityLines(activity).join("\n");
    assert.doesNotMatch(rendered, new RegExp(oldSha), "the superseded sha must be ABSENT from the surface");
    assert.match(rendered, new RegExp(newSha));
  });

  test("BD-8: `CI not running` is a different fact from `CI not observed`", () => {
    addCiEvent({
      attemptId: "attempt-1", ticketId: "FG-679", projectDir: PROJECT, candidateSha: "c".repeat(40),
      observedAt: "2026-08-05T11:59:00.000Z", outcome: "success", unavailableReason: null, contexts: contexts("success"),
    }, "2026-08-05T11:59:00.000Z");
    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    assert.equal(activity.requiredCi.state, "observed");
    assert.equal(activity.requiredCi.observations[0]!.state, "not_running");
    assert.equal(activity.requiredCi.observations[0]!.label, CI_NOT_RUNNING_LABEL);
    assert.notEqual(CI_NOT_RUNNING_LABEL, CI_NOT_OBSERVED_LABEL);
    assert.match(renderCurrentActivityLines(activity).join("\n"), /CI not running/);
  });

  test("BD-8: an observation past the cutoff is LABELED stale rather than presented as current", () => {
    const observedAt = new Date(NOW.getTime() - CI_OBSERVATION_FRESH_MS - 60_000).toISOString();
    addCiEvent({
      attemptId: "attempt-1", ticketId: "FG-679", projectDir: PROJECT, candidateSha: "d".repeat(40),
      observedAt, outcome: "pending", unavailableReason: null, contexts: contexts("pending"),
    }, observedAt);
    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    const obs = activity.requiredCi.observations[0]!;
    assert.equal(obs.state, "stale");
    assert.match(obs.label, /^stale — CI last observed /);
    assert.notEqual(obs.label, CI_RUNNING_LABEL, "a stale pending observation is not a claim that CI is running now");
    assert.match(renderCurrentActivityLines(activity).join("\n"), /stale — CI last observed/);
  });

  test("BD-8: a FUTURE-dated CI observation is stale evidence, not current — `CI running` is never asserted from a time that has not occurred", () => {
    const observedAt = new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString();
    addCiEvent({
      attemptId: "attempt-1", ticketId: "FG-679", projectDir: PROJECT, candidateSha: "f".repeat(40),
      observedAt, outcome: "pending", unavailableReason: null, contexts: contexts("pending"),
    }, observedAt);
    const obs = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } }).requiredCi.observations[0]!;
    assert.equal(obs.state, "stale");
    assert.notEqual(obs.label, CI_RUNNING_LABEL);
  });

  test("an `unavailable` outcome states its reason rather than reading as a pass", () => {
    addCiEvent({
      attemptId: "attempt-1", ticketId: "FG-679", projectDir: PROJECT, candidateSha: "e".repeat(40),
      observedAt: "2026-08-05T11:59:00.000Z", outcome: "unavailable", unavailableReason: "gh not authenticated", contexts: [],
    }, "2026-08-05T11:59:00.000Z");
    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } });
    const rendered = renderCurrentActivityLines(activity).join("\n");
    assert.match(rendered, /unavailable: gh not authenticated/);
    assert.match(rendered, /\(no required context enumerated\)/);
  });

  test("a per-context pending state counts as running even when the summary outcome has not caught up", () => {
    addCiEvent({
      attemptId: "attempt-1", ticketId: "FG-679", projectDir: PROJECT, candidateSha: "f".repeat(40),
      observedAt: "2026-08-05T11:59:00.000Z", outcome: "unavailable", unavailableReason: null,
      contexts: [{ context: "test", state: "in_progress", url: null, observedAt: "2026-08-05T11:59:00.000Z" }],
    }, "2026-08-05T11:59:00.000Z");
    const obs = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-fg679" } }).requiredCi.observations[0]!;
    assert.equal(obs.state, "running");
  });
});

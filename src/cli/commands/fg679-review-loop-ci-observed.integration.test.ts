// FG-679 (BD-5/BD-6/BD-7/BD-8): the review loop — the ONE Forge-owned CI
// observer — durably records WHAT it saw at the exact candidate sha it probed.
//
// CONTRACT B is pinned by the FG-679 plan and consumed VERBATIM by the
// dashboard's current-activity reader, which has no git and no GitHub and
// therefore cannot derive any of it. These tests assert the wire format
// literally — the event_type string, every payload key, every per-context key —
// because a rename here is a silently empty section there.
//
// The load-bearing negatives: a dirty-tree round consults no CI and must emit
// NOTHING, and no observation may ever be written for a sha the observer did
// not actually probe.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { buildReviewLoopDeps, type ReviewLoopContext } from "./review-loop.js";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertHostVerification, REQUIRED_CI_CHECK_CONTEXT } from "../../store/host-verifications.js";
import { eventsForRun, type Event } from "../../store/events.js";

const CI_OBSERVED = "review_loop.ci_observed";
const EXTENDED_CONTEXT = "CI / test-extended";
const GATE_CMD = "npm run test:all";

// Contract B, spelled out. Sorted so a key ADDED or REMOVED fails, not just renamed.
const PAYLOAD_KEYS = [
  "attemptId", "candidateSha", "contexts", "observedAt", "outcome", "projectDir", "projectDirCanonical", "ticketId",
  "unavailableReason",
].sort();
const CONTEXT_KEYS = ["context", "observedAt", "state", "url"].sort();

type CiObservedPayload = {
  attemptId: string;
  ticketId: string | null;
  projectDir: string;
  projectDirCanonical: string | null;
  candidateSha: string;
  observedAt: string;
  outcome: string;
  unavailableReason: string | null;
  contexts: { context: string; state: string; url: string | null; observedAt: string }[];
};

let projectDir: string;
let db: DatabaseInstance;
let prev: DatabaseInstance | null;

function gitExec(args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectDir, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@t.com" },
  });
}

function writeTwoJobCiWorkflow(): void {
  mkdirSync(join(projectDir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(projectDir, ".github", "workflows", "ci.yml"),
    `name: CI\njobs:\n  test:\n    steps:\n      - run: ${GATE_CMD}\n  test-extended:\n    steps:\n      - run: echo extended\n`,
  );
}

function commitAll(message: string): string {
  gitExec(["add", "-A"]);
  gitExec(["commit", "-m", message]);
  return gitExec(["rev-parse", "HEAD"]).trim();
}

function ctx(over: Partial<ReviewLoopContext> = {}): ReviewLoopContext {
  return {
    ticketId: "FG-679", acceptance: "FG-679 — surface in-flight required CI",
    diffProvider: () => "diff --git a/x b/x", projectDir, scripts: {}, unrouted: true, ...over,
  };
}

const passingRunner: NonNullable<ReviewLoopContext["runVerification"]> = (scripts) => ({
  ok: true, steps: Object.keys(scripts).map((name) => ({ name, ok: true, output: "" })),
});

function ciObserved(runId: string): { event: Event; payload: CiObservedPayload }[] {
  return eventsForRun(runId)
    .filter((e) => e.eventType === CI_OBSERVED)
    .map((event) => ({ event, payload: event.payload as CiObservedPayload }));
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "fg679-rl-ci-"));
  gitExec(["init", "-q"]);
  gitExec(["config", "user.email", "t@t.com"]);
  gitExec(["config", "user.name", "Test"]);
  writeFileSync(join(projectDir, "src.ts"), "// initial\n");
  writeTwoJobCiWorkflow();
  commitAll("initial commit");
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
});

// ── Contract B, literally ────────────────────────────────────────────────────

test("FG-679: a clean-tree round with pending CI emits `review_loop.ci_observed` in Contract B's EXACT shape", async () => {
  const headSha = gitExec(["rev-parse", "HEAD"]).trim();
  const { deps } = buildReviewLoopDeps(ctx({
    runId: "run-fg679-shape",
    scripts: { typecheck: "true", test: "true" },
    runVerification: passingRunner,
    sleep: async () => {},
    ciPollMs: 1, ciWaitTimeoutMs: 0,   // one probe, then the wait times out immediately
    checkStatusProvider: ({ checkContext }) => (checkContext === REQUIRED_CI_CHECK_CONTEXT
      ? { sha: headSha, state: "pending", detailsUrl: "https://example.com/ci/test" }
      : { sha: headSha, state: "pending" }),
  }));
  await deps.verify();

  const observed = ciObserved("run-fg679-shape");
  assert.ok(observed.length >= 1, "a clean-tree round that probed CI must leave a durable observation");

  for (const { event, payload } of observed) {
    assert.equal(event.eventType, CI_OBSERVED, "the event_type string is pinned — the reader matches it literally");
    assert.equal(event.runId, "run-fg679-shape", "the observation is bound to the review-loop run id");
    assert.deepEqual(Object.keys(payload).sort(), PAYLOAD_KEYS, "Contract B's payload key set is pinned exactly");

    assert.equal(typeof payload.attemptId, "string");
    assert.ok(payload.attemptId.length > 0);
    assert.equal(payload.ticketId, "FG-679");
    assert.equal(payload.projectDir, projectDir);
    // FG-693: the bytes above are a SPELLING and decide nothing; the PROVEN identity
    // travels beside them, so a reader never has to re-resolve the spelling later and
    // credit this observation to whatever it happens to reach then.
    assert.equal(payload.projectDirCanonical, realpathSync(projectDir));
    assert.equal(payload.candidateSha, headSha);
    assert.equal(payload.candidateSha.length, 40, "the FULL probed sha, never a short sha");
    assert.equal(payload.observedAt, new Date(payload.observedAt).toISOString(), "observedAt is ISO 8601");
    assert.ok(["pending", "success", "failed", "unavailable"].includes(payload.outcome), `unexpected outcome ${payload.outcome}`);

    assert.deepEqual(
      payload.contexts.map((c) => c.context).sort(),
      [REQUIRED_CI_CHECK_CONTEXT, EXTENDED_CONTEXT].sort(),
      "BD-5: EVERY required context is enumerated — a summary verdict does not satisfy it",
    );
    for (const c of payload.contexts) {
      assert.deepEqual(Object.keys(c).sort(), CONTEXT_KEYS, "each context entry's key set is pinned exactly");
      assert.equal(typeof c.context, "string");
      assert.equal(typeof c.state, "string");
      assert.equal(c.observedAt, new Date(c.observedAt).toISOString(), "each context carries its own ISO observation time");
    }
    assert.equal(payload.contexts.find((c) => c.context === REQUIRED_CI_CHECK_CONTEXT)!.url, "https://example.com/ci/test");
    assert.equal(payload.contexts.find((c) => c.context === EXTENDED_CONTEXT)!.url, null, "a context with no details url records null — never an invented one");
  }

  const attemptIds = new Set(observed.map((o) => o.payload.attemptId));
  const started = eventsForRun("run-fg679-shape").find((e) => e.eventType === "review_loop.verification_started")!;
  assert.deepEqual(
    [...attemptIds], [(started.payload as { attemptId: string }).attemptId],
    "every observation in a round shares that round's attemptId",
  );
});

test("FG-679: one event per poll iteration plus one at round resolution — a two-poll round emits three, with non-decreasing observedAt", async () => {
  const headSha = gitExec(["rev-parse", "HEAD"]).trim();
  // pending for the first probe, green from the second — flipped on the sleep
  // callback so the round is exactly two polls regardless of tryReuse's own
  // provider calls (findCoveringGateEvidence shares the same provider).
  let phase: "pending" | "success" = "pending";
  const sleeps: number[] = [];
  const { deps } = buildReviewLoopDeps(ctx({
    runId: "run-fg679-polls",
    sleep: async (ms) => { sleeps.push(ms); phase = "success"; },
    ciPollMs: 1, ciWaitTimeoutMs: 600_000,
    checkStatusProvider: () => (phase === "pending"
      ? { sha: headSha, state: "pending" }
      : { sha: headSha, state: "success", detailsUrl: "https://example.com/ci/green" }),
  }));
  const result = await deps.verify();

  assert.equal(result.ok, true);
  assert.equal(sleeps.length, 1, "exactly one poll before the checks went green — i.e. two probe passes");

  const observed = ciObserved("run-fg679-polls");
  assert.equal(observed.length, 3, "two probe passes + one round-resolution observation");
  assert.deepEqual(observed.map((o) => o.payload.outcome), ["pending", "success", "success"]);

  const stamps = observed.map((o) => o.payload.observedAt);
  assert.deepEqual(stamps, [...stamps].sort(), "observation times are monotonically non-decreasing across the round");

  // The resolution observation re-states the LAST probe's contexts verbatim —
  // nothing is re-observed and no context time is refreshed without a probe.
  assert.deepEqual(observed[2]!.payload.contexts, observed[1]!.payload.contexts);
});

test("FG-679: a dirty-tree round consults no CI and emits ZERO ci_observed events", async () => {
  writeFileSync(join(projectDir, "dirty.txt"), "wip");
  const { deps } = buildReviewLoopDeps(ctx({
    runId: "run-fg679-dirty",
    scripts: { typecheck: "true", test: "true" },
    runVerification: passingRunner,
    checkStatusProvider: () => { throw new Error("a dirty tree must never consult CI"); },
  }));
  await deps.verify();

  assert.deepEqual(ciObserved("run-fg679-dirty"), [], "local verification observed no CI, so it must claim none");
});

test("FG-679: a round that resolves via an instant host_verifications reuse observed no CI, and records none", async () => {
  const headSha = gitExec(["rev-parse", "HEAD"]).trim();
  insertHostVerification({
    ticketId: "FG-679", projectDir, commitSha: headSha,
    gateName: GATE_CMD, command: GATE_CMD, exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
  });
  const { deps } = buildReviewLoopDeps(ctx({
    runId: "run-fg679-hostrow",
    checkStatusProvider: () => { throw new Error("must not be called — the host row already covers"); },
  }));
  const result = await deps.verify();

  assert.equal(result.ok, true);
  assert.deepEqual(ciObserved("run-fg679-hostrow"), []);
});

// ── BD-6: the observer declares the candidate; it never observes for a sha it
// did not probe ──────────────────────────────────────────────────────────────

test("FG-679: a candidate change between rounds — every event's candidateSha is the sha actually handed to the provider for that round", async () => {
  const firstSha = gitExec(["rev-parse", "HEAD"]).trim();
  const askedFor: string[] = [];
  const { deps } = buildReviewLoopDeps(ctx({
    runId: "run-fg679-candidate",
    sleep: async () => {},
    ciPollMs: 1, ciWaitTimeoutMs: 0,
    scripts: { typecheck: "true", test: "true" },
    runVerification: passingRunner,
    checkStatusProvider: ({ sha }) => { askedFor.push(sha); return { sha, state: "pending" }; },
  }));

  await deps.verify();
  const roundOne = ciObserved("run-fg679-candidate");
  assert.ok(roundOne.length > 0);

  // The candidate advances, exactly as a fixer's commit advances it mid-loop.
  writeFileSync(join(projectDir, "src.ts"), "// fixed\n");
  const secondSha = commitAll("fixer commit");
  assert.notEqual(secondSha, firstSha);

  await deps.verify();
  const all = ciObserved("run-fg679-candidate");
  const roundTwo = all.slice(roundOne.length);
  assert.ok(roundTwo.length > 0);

  assert.deepEqual(new Set(roundOne.map((o) => o.payload.candidateSha)), new Set([firstSha]));
  assert.deepEqual(new Set(roundTwo.map((o) => o.payload.candidateSha)), new Set([secondSha]));
  assert.deepEqual(
    new Set(all.map((o) => o.payload.candidateSha)), new Set(askedFor),
    "no observation names a sha the provider was never asked about",
  );
  // BD-6 needs no supersession column: the old-sha observation is simply no
  // longer the newest, which is a fact about ORDER, not about a rewrite.
  assert.equal(all[all.length - 1]!.payload.candidateSha, secondSha);
  assert.ok(roundOne.every((o) => o.payload.candidateSha === firstSha), "the old-sha observations are left exactly as they were recorded");
});

// ── outcomes at round resolution ─────────────────────────────────────────────

test("FG-679: a failing required check resolves the round's observation as `failed` while still enumerating every required context", async () => {
  const headSha = gitExec(["rev-parse", "HEAD"]).trim();
  const { deps } = buildReviewLoopDeps(ctx({
    runId: "run-fg679-failed",
    checkStatusProvider: ({ checkContext }) => (checkContext === REQUIRED_CI_CHECK_CONTEXT
      ? { sha: headSha, state: "failure", detailsUrl: "https://example.com/ci/red" }
      : { sha: headSha, state: "success" }),
  }));
  const result = await deps.verify();
  assert.equal(result.ok, false);

  const observed = ciObserved("run-fg679-failed");
  const last = observed[observed.length - 1]!.payload;
  assert.equal(last.outcome, "failed");
  assert.equal(last.unavailableReason, null);
  assert.deepEqual(last.contexts.map((c) => c.context).sort(), [REQUIRED_CI_CHECK_CONTEXT, EXTENDED_CONTEXT].sort());
  assert.equal(last.contexts.find((c) => c.context === REQUIRED_CI_CHECK_CONTEXT)!.state, "failure");
  assert.equal(last.contexts.find((c) => c.context === EXTENDED_CONTEXT)!.state, "success");
});

test("FG-679: a CI wait that times out resolves as `unavailable` with the timeout named — recorded BEFORE the local fallback runs", async () => {
  const headSha = gitExec(["rev-parse", "HEAD"]).trim();
  let observationsAtLocalRun = -1;
  const { deps } = buildReviewLoopDeps(ctx({
    runId: "run-fg679-timeout",
    scripts: { typecheck: "true", test: "true" },
    runVerification: (scripts) => {
      observationsAtLocalRun = ciObserved("run-fg679-timeout").length;
      return passingRunner(scripts, { cwd: projectDir });
    },
    sleep: async () => {},
    ciPollMs: 1, ciWaitTimeoutMs: 0,
    checkStatusProvider: () => ({ sha: headSha, state: "pending" }),
  }));
  const result = await deps.verify();
  assert.equal(result.ciOutcome?.kind, "local_fallback");

  const observed = ciObserved("run-fg679-timeout");
  const last = observed[observed.length - 1]!.payload;
  assert.equal(last.outcome, "unavailable");
  assert.match(last.unavailableReason ?? "", /CI wait timed out/);
  assert.deepEqual(last.contexts.map((c) => c.state), ["pending", "pending"], "the contexts are the ones last actually observed, unchanged");
  assert.equal(
    observationsAtLocalRun, observed.length,
    "the CI disposition is durable before the local fallback starts — the surface must not go quiet for the length of a local run",
  );
});

test("FG-679: a project with no CI workflow records the `unavailable` observation with its reason and ZERO contexts — 'not observed' is never dressed up as 'not running'", async () => {
  rmSync(join(projectDir, ".github"), { recursive: true, force: true });
  commitAll("drop ci workflow");
  const { deps } = buildReviewLoopDeps(ctx({
    runId: "run-fg679-noci",
    scripts: { typecheck: "true", test: "true" },
    runVerification: passingRunner,
    checkStatusProvider: () => { throw new Error("a failed pairing precondition must never reach the provider"); },
  }));
  await deps.verify();

  const observed = ciObserved("run-fg679-noci");
  assert.ok(observed.length > 0);
  for (const { payload } of observed) {
    assert.equal(payload.outcome, "unavailable");
    assert.deepEqual(payload.contexts, [], "nothing was enumerated, so nothing is claimed");
    assert.ok((payload.unavailableReason ?? "").length > 0, "an unavailable observation always names why");
  }
});

// ── BD-7: ONE observer ───────────────────────────────────────────────────────

test("FG-679: no second poller — the observations come from the SAME pass that decided the round, and resolution re-probes nothing", async () => {
  const headSha = gitExec(["rev-parse", "HEAD"]).trim();
  const asked: { sha: string; checkContext: string }[] = [];
  const { deps } = buildReviewLoopDeps(ctx({
    runId: "run-fg679-one-observer",
    scripts: { typecheck: "true", test: "true" },
    runVerification: passingRunner,
    sleep: async () => {},
    ciPollMs: 1, ciWaitTimeoutMs: 0,
    checkStatusProvider: ({ sha, checkContext }) => { asked.push({ sha, checkContext }); return { sha, state: "pending" }; },
  }));
  await deps.verify();

  const observed = ciObserved("run-fg679-one-observer");
  const probePasses = observed.filter((o) => o.payload.outcome === "pending").length;

  // findCoveringGateEvidence short-circuits on the first non-success job, so it
  // consumes 1 call; each probe pass consumes one call per required job (2).
  assert.equal(asked.length, 1 + probePasses * 2, "the observer polls CI exactly as often as the status probe alone did — nothing polls a second time");
  assert.ok(asked.every((a) => a.sha === headSha), "every provider call is bound to the candidate under review");

  const contexts = new Set(observed.flatMap((o) => o.payload.contexts.map((c) => c.context)));
  const askedContexts = new Set(asked.map((a) => a.checkContext));
  for (const c of contexts) assert.ok(askedContexts.has(c), `observed context "${c}" was never actually probed`);
});

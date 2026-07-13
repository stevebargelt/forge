// FG-425 operator surface, driven through the REAL CLI.
//
// The ticket makes operator visibility an ACCEPTANCE CRITERION, not a nicety:
// the durable {baseSha, candidateSha, publishedSha, target} record and the FIFO
// lane must be visible, and a serialized publisher that gives the operator no way
// to see who is in front of them is indistinguishable from a hung one. Nothing
// else in the suite invokes `forge publish` at all — the store accessors are
// tested, the commander wiring that exposes them is not. A registerPublish() that
// was never registered, or an action handler that printed the wrong SHA, would be
// caught by no existing test.
//
// So this drives the commands as an operator actually runs them: through
// program.parseAsync, against a REAL publication of a REAL git repo, reading the
// REAL stdout. The only thing captured is the console — nothing is stubbed.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import {
  getPublicationAttempt,
  publicationAttemptsForProject,
  recordPublicationIntent,
  tryAcquirePublicationMutex,
  laneTick,
} from "../../store/publications.js";
import { projectIdentity } from "../../v2/project-identity.js";
import { publishIntegration } from "../../v2/integration-publisher.js";
import { registerPublish } from "./publish.js";

let prevDb: DatabaseInstance | null;
const cleanup: string[] = [];
// `process.exitCode` is wider than `number | undefined` (it accepts a string
// exit name and null), so mirror its type rather than narrowing it.
type ExitCode = typeof process.exitCode;
let savedExitCode: ExitCode;

beforeEach(() => {
  prevDb = setDbForTest(makeInMemoryDb());
  savedExitCode = process.exitCode;
});

afterEach(() => {
  setDbForTest(prevDb as DatabaseInstance);
  process.exitCode = savedExitCode;
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(dir: string, file: string, body: string): string {
  writeFileSync(join(dir, file), body);
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", `add ${file}`]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** Run a `forge publish ...` invocation exactly as an operator would — through
 *  commander's own parse, with the real action handlers — and capture what the
 *  operator would SEE. */
async function forgePublish(...argv: string[]): Promise<{ out: string; err: string; exitCode: ExitCode }> {
  const program = new Command();
  program.exitOverride();
  registerPublish(program);

  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]): void => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]): void => { err.push(a.map(String).join(" ")); };
  process.exitCode = undefined;
  try {
    await program.parseAsync(["node", "forge", "publish", ...argv]);
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  return { out: out.join("\n"), err: err.join("\n"), exitCode: process.exitCode };
}

function makeProject(runId: string): { dir: string; branch: string; seed: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fg425-cli-")));
  cleanup.push(dir);
  git(dir, ["init", "-b", "main"]);
  const seed = commit(dir, "seed.txt", "seed\n");
  const branch = `forge/${runId}/task`;
  git(dir, ["checkout", "-q", "-b", branch, seed]);
  commit(dir, "feature.txt", "the agent's work\n");
  git(dir, ["checkout", "-q", "main"]);
  insertRun({
    id: runId,
    workflow: "fg425",
    title: "fg425 publish cli test",
    status: "active",
    projectDir: dir,
    createdAt: new Date().toISOString(),
    metadata: {},
  });
  return { dir, branch, seed };
}

test("FG-425 (operator visibility): `forge publish attempts` shows the durable {baseSha, candidateSha, publishedSha, target} of a real publication", async () => {
  const { dir, branch, seed } = makeProject("run-cli-1");

  const outcome = await publishIntegration({
    runId: "run-cli-1",
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: () => ({ ok: true }),
  });
  assert.equal(outcome.kind, "published", `setup: publication failed: ${JSON.stringify(outcome)}`);
  if (outcome.kind !== "published") return;

  const { out } = await forgePublish("attempts", "--project", dir);

  // The full quad the AC requires, each shown as the operator sees it (12 chars).
  assert.match(out, new RegExp(`baseSha\\s+${seed.slice(0, 12)}`), "the recorded baseSha must be operator-visible");
  assert.match(
    out,
    new RegExp(`candidateSha\\s+${outcome.candidateSha.slice(0, 12)}`),
    "the recorded candidateSha must be operator-visible",
  );
  assert.match(
    out,
    new RegExp(`publishedSha\\s+${outcome.publishedSha.slice(0, 12)}`),
    "the recorded publishedSha must be operator-visible",
  );
  assert.match(out, new RegExp(`target\\s+local:${dir}#main`), "the recorded target descriptor must be operator-visible");
  assert.match(out, new RegExp(`${outcome.attemptId}\\s+published`), "the attempt's terminal state must be visible");

  // AD-6, read back off the OPERATOR SURFACE rather than the return value: what the
  // operator is shown as published is what was validated.
  assert.equal(outcome.publishedSha, outcome.candidateSha);
  assert.equal(
    getPublicationAttempt(outcome.attemptId)?.publishedSha,
    getPublicationAttempt(outcome.attemptId)?.candidateSha,
    "AD-6: the DURABLE record must carry publishedSha === candidateSha",
  );
});

test("FG-425 (operator visibility): `forge publish lane` names the holder and the queue, in durable enqueue order, through ANY spelling of the project", async () => {
  const { dir } = makeProject("run-cli-holder");
  const linkParent = realpathSync(mkdtempSync(join(tmpdir(), "fg425-cli-link-")));
  cleanup.push(linkParent);
  const symlinked = join(linkParent, "project-link");
  symlinkSync(dir, symlinked);

  const { key, canonicalDir } = projectIdentity(dir);

  // A holder and two queued attempts behind it — the exact state an operator runs
  // `forge publish lane` to understand. Built durably rather than by racing real
  // publications, so the ORDER under assertion is the recorded one and the test has
  // no timing in it.
  const common = { projectKey: key, canonicalDir, taskId: "t", target: `local:${dir}#main`, leaseTtlMs: 90_000 };
  recordPublicationIntent({ ...common, attemptId: "att-first", runId: "run-first" });
  recordPublicationIntent({ ...common, attemptId: "att-second", runId: "run-second" });
  recordPublicationIntent({ ...common, attemptId: "att-third", runId: "run-third" });

  // The head takes its turn and enters the short publication window.
  const turn = laneTick("att-first", 90_000);
  assert.equal(turn.ready, true, "setup: the first-enqueued attempt must be head of the lane");
  tryAcquirePublicationMutex({ projectKey: key, attemptId: "att-first", runId: "run-first", ttlMs: 120_000 });

  // The operator asks through the SYMLINK spelling — the CLI must canonicalize it
  // to the same lane, or `forge publish lane` reports "(empty)" on a project that is
  // in fact queued three deep, which is precisely the "hung or queued?" question the
  // command exists to answer.
  const { out } = await forgePublish("lane", "--project", symlinked);

  assert.match(out, new RegExp(`lane for ${canonicalDir}`), "the lane must be reported against the CANONICAL dir");
  assert.match(
    out,
    /publication window HELD by run run-first \(attempt att-first\) — CAS \+ fast-forward only/,
    "the operator must be told WHO holds the short publication window",
  );
  assert.match(out, /▶ #\d+\s+holding\s+att-first\s+run run-first/, "the lane holder must be marked and named");
  assert.match(out, /att-second\s+run run-second/, "a queued attempt must be visible");
  assert.match(out, /att-third\s+run run-third/, "a queued attempt must be visible");

  // FIFO, asserted off the RENDERED surface: the durable enqueue order is what the
  // operator is shown, not lock-acquisition order.
  const lines = out.split("\n");
  const order = ["att-first", "att-second", "att-third"].map((a) => lines.findIndex((l) => l.includes(a)));
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    "the lane must RENDER in durable enqueue order — the operator's view of who goes next is the FIFO key",
  );
});

test("FG-425 (AD-5): `forge publish recover` converges an attempt crashed inside the publication window, from the three SHAs alone — and is IDEMPOTENT", async () => {
  const { dir, branch, seed } = makeProject("run-cli-crash");

  // A REAL publication, interrupted in the AD-5 window: the ref has advanced, the
  // checked-out tree has NOT caught up. Throwing from afterRefAdvance leaves exactly
  // the durable state a crash leaves — ref at the candidate, index and working tree
  // at the base, the attempt row still `publishing`. (The sibling worktree test kills
  // a real OS process at this same point; what is under test HERE is the operator's
  // recovery command against that state.)
  await assert.rejects(
    publishIntegration({
      runId: "run-cli-crash",
      taskId: "task-build-1",
      projectDir: dir,
      sources: [{ branch, label: "task" }],
      lane: { pollMs: 10, log: () => {} },
      alsoValidate: () => ({ ok: true }),
      afterRefAdvance: () => { throw new Error("simulated crash inside the publication window"); },
    }),
    /simulated crash inside the publication window/,
  );

  const attempt = publicationAttemptsForProject(projectIdentity(dir).key)[0];
  assert.ok(attempt, "setup: the interrupted attempt must be durably recorded");
  assert.equal(attempt.state, "publishing", "setup: the attempt is left INSIDE the window — the recoverable state");
  const candidateSha = attempt.candidateSha;
  assert.ok(candidateSha);

  // The durable state a crash really leaves: ref advanced, working tree stale.
  assert.equal(git(dir, ["rev-parse", "refs/heads/main"]), candidateSha, "setup: the ref advanced");
  assert.notEqual(seed, candidateSha);
  assert.throws(
    () => readFileSync(join(dir, "feature.txt"), "utf8"),
    "setup: the checked-out tree has NOT caught up to the ref — that is the AD-5 window",
  );

  // ── the operator runs recovery ─────────────────────────────────────────────
  const first = await forgePublish("recover", attempt.attemptId);

  assert.match(first.out, new RegExp(`attempt ${attempt.attemptId}: published`), "recovery must report the truth the REF tells");
  assert.match(first.out, new RegExp(`published ${candidateSha} to local:${dir}#main`));
  assert.equal(first.exitCode, undefined, "a clean recovery must not signal failure");

  // The publication is durable AND the working tree has been brought up to it.
  assert.equal(readFileSync(join(dir, "feature.txt"), "utf8"), "the agent's work\n", "the checkout was converged");
  assert.equal(getPublicationAttempt(attempt.attemptId)?.state, "published");
  assert.equal(
    getPublicationAttempt(attempt.attemptId)?.publishedSha,
    candidateSha,
    "AD-6: recovery records the RECORDED candidate as published — never a re-derived branch tip",
  );

  // ── IDEMPOTENCE: re-running converges to the same answer and discards nothing ──
  const second = await forgePublish("recover", attempt.attemptId);
  assert.match(second.out, new RegExp(`attempt ${attempt.attemptId}: published`), "recovery is idempotent");
  assert.equal(git(dir, ["rev-parse", "refs/heads/main"]), candidateSha, "a re-run must never discard a correct publication");
  assert.equal(readFileSync(join(dir, "feature.txt"), "utf8"), "the agent's work\n");
  assert.equal(getPublicationAttempt(attempt.attemptId)?.state, "published");
});

test("FG-425: `forge publish recover` on an unknown attempt fails loudly rather than inventing a publication", async () => {
  const { err, exitCode } = await forgePublish("recover", "att-does-not-exist");
  assert.match(err, /no publication attempt att-does-not-exist/);
  assert.equal(exitCode, 1, "an unknown attempt must be a non-zero exit, not a silent no-op");
});

test("FG-425: the publish operator surface is empty-safe — no lane, no attempts, no crash", async () => {
  const lane = await forgePublish("lane");
  assert.match(lane.out, /no publication lane entries/);
  const attempts = await forgePublish("attempts");
  assert.match(attempts.out, /no publication attempts/);
});

// FG-634 — real readiness execution must redact only its durable audit surfaces.
//
// Unlike the unit-tier FG-634 coverage, this suite does not inject `runSetup`.
// The configured setup contract is executed by defaultRunSetup in a real child;
// the assertions then read the real readiness JSON record and the event-store
// rows written by that flow.  This protects the persistence/event/reuse seams,
// where a future caller could accidentally surface an old unredacted command.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { eventsForRun } from "../store/events.js";
import { hostConfigPath, hostReadinessDir } from "../util/paths.js";
import { prepareHostVerification, type HostReadinessOutcome } from "./host-readiness.js";
import { readReadinessRecord } from "./host-readiness-store.js";

let prevDb: DatabaseInstance | null;
const dirs: string[] = [];
const envKeys = ["FORGE_HOST_VERIFICATION_SETUP", "FORGE_HOST_READINESS_REQUIRE_ABI", "FORGE_HOST_READINESS_SETUP_TIMEOUT_MS"];
let savedEnv: Record<string, string | undefined> = {};
let runNumber = 0;

beforeEach(() => {
  prevDb = setDbForTest(makeInMemoryDb());
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  rmSync(hostConfigPath(), { force: true });
  rmSync(hostReadinessDir(), { recursive: true, force: true });
});

afterEach(() => {
  setDbForTest(prevDb as DatabaseInstance);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(hostConfigPath(), { force: true });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `fg634-integration-${prefix}-`)));
  dirs.push(dir);
  return dir;
}

function workspace(): string {
  const dir = scratch("workspace");
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "fg634-integration-fixture", version: "1.0.0", private: true,
    dependencies: { "fixture": "1.0.0" },
  }));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "fg634-integration-fixture", lockfileVersion: 3 }));
  return dir;
}

function notForgeRoot(): string {
  return scratch("not-forge-root");
}

function prepare(ws: string, runId: string): Promise<HostReadinessOutcome> {
  return prepareHostVerification(
    { workspace: ws, treeSha: "deadbeef", coveredCommandSet: ["npm run test:unit"], label: "fg634-integration", runId },
    { sourceRoot: notForgeRoot(), porcelain: () => "" },
  );
}

function eventPayload(runId: string, type: "host_readiness.ready" | "host_readiness.refused"): Record<string, unknown> {
  const event = eventsForRun(runId).find((candidate) => candidate.eventType === type);
  assert.ok(event, `expected ${type} in the durable event store`);
  return event!.payload as Record<string, unknown>;
}

function configureChild(script: string, ...args: string[]): void {
  process.env.FORGE_HOST_VERIFICATION_SETUP = JSON.stringify([process.execPath, "-e", script, ...args]);
  process.env.FORGE_HOST_READINESS_REQUIRE_ABI = process.versions.modules;
}

test("FG-634 integration: a real failed setup redacts command, message and stderr in its refusal and refused event", async () => {
  const ws = workspace();
  const secret = "npm_fg634_refusal_secret";
  const registryUrl = `https://ci-bot:${secret}@mirror.example.com/`;
  configureChild(
    "process.stderr.write(`//registry.example.com/:_authToken=${process.argv[1]}\\nAuthorization: Bearer ${process.argv[1]}\\n`); process.exit(19)",
    registryUrl,
  );
  // A multi-step contract puts the failed argv into the refusal detail.  This
  // proves the returned operator-facing message is redacted too, not merely the
  // separately recorded command and stderr tail.
  process.env.FORGE_HOST_VERIFICATION_SETUP = JSON.stringify([JSON.parse(process.env.FORGE_HOST_VERIFICATION_SETUP!), ["node", "-e", "process.exit(0)"]]);

  const outcome = await prepare(ws, `fg634-refused-${++runNumber}`);
  assert.equal(outcome.kind, "refused");
  const refusal = outcome.refusal;
  assert.equal(refusal.reason, "setup_failed");
  for (const auditValue of [refusal.command, refusal.message, refusal.stderrTail]) {
    assert.match(auditValue, /«redacted»/);
    assert.doesNotMatch(auditValue, new RegExp(secret));
  }

  const payload = eventPayload(`fg634-refused-${runNumber}`, "host_readiness.refused");
  for (const auditValue of [payload.command, payload.stderrTail]) {
    assert.match(String(auditValue), /«redacted»/);
    assert.doesNotMatch(String(auditValue), new RegExp(secret));
  }
  assert.equal(readReadinessRecord(ws)?.state, "preparing", "the failure still leaves its real durable preparation record");
});

test("FG-634 integration: real setup executes an unredacted registry URL while records, ready events, and reuse events redact it", async () => {
  const ws = workspace();
  const capturePath = join(scratch("capture"), "argv.json");
  const secret = "fg634-ready-password";
  const registryUrl = `https://ci-bot:${secret}@mirror.example.com/`;
  configureChild(
    "const fs = require('fs'); fs.mkdirSync('node_modules/fixture', { recursive: true }); fs.writeFileSync(process.argv[1], process.argv[2]); fs.writeFileSync(process.argv[3], JSON.stringify(process.argv.slice(1)));",
    join(ws, "child-ran.txt"), registryUrl, capturePath,
  );

  const firstRun = `fg634-ready-${++runNumber}`;
  const first = await prepare(ws, firstRun);
  assert.equal(first.kind, "ready");
  assert.equal(readFileSync(join(ws, "child-ran.txt"), "utf8"), registryUrl, "the actual setup child receives the real credential-shaped argument");
  assert.ok(existsSync(join(ws, "node_modules", "fixture")), "the real child prepared a reusable workspace");
  assert.match(readFileSync(capturePath, "utf8"), new RegExp(secret), "the child argv was not redacted before execution");

  const record = readReadinessRecord(ws);
  assert.ok(record);
  assert.match(record!.setupCommand, /«redacted»/);
  assert.doesNotMatch(record!.setupCommand, new RegExp(secret));
  const firstPayload = eventPayload(firstRun, "host_readiness.ready");
  assert.match(String(firstPayload.setupCommand), /«redacted»/);
  assert.doesNotMatch(String(firstPayload.setupCommand), new RegExp(secret));

  const reuseRun = `fg634-reuse-${++runNumber}`;
  const reused = await prepare(ws, reuseRun);
  assert.equal(reused.kind, "ready");
  assert.equal(reused.evidence.reused, true, "the second call takes the stored-record reuse path");
  assert.match(reused.evidence.setupCommand, /«redacted»/);
  assert.doesNotMatch(reused.evidence.setupCommand, new RegExp(secret));
  const reusePayload = eventPayload(reuseRun, "host_readiness.ready");
  assert.equal(reusePayload.reused, true);
  assert.match(String(reusePayload.setupCommand), /«redacted»/);
  assert.doesNotMatch(String(reusePayload.setupCommand), new RegExp(secret), "a stored command cannot leak when it is re-emitted later");
});

test("FG-634 integration: benign setup output and its durable audit values remain byte-intact", async () => {
  const ws = workspace();
  const benign = "npm error code ELIFECYCLE: fixture compiler unavailable";
  configureChild(`process.stderr.write(${JSON.stringify(benign)}); process.exit(7)`);

  const runId = `fg634-benign-${++runNumber}`;
  const outcome = await prepare(ws, runId);
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.refusal.stderrTail, benign);
  assert.doesNotMatch(outcome.refusal.message, /«redacted»/);
  const payload = eventPayload(runId, "host_readiness.refused");
  assert.equal(payload.stderrTail, benign);
  assert.doesNotMatch(JSON.stringify(payload), /«redacted»/);
});

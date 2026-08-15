// FG-634 — operator secrets must be REDACTED at the readiness persistence boundary.
//
// FG-566 established WHERE the setup command comes from (operator host config, never
// the workspace under test). FG-643 then established that "local-only, therefore safe"
// is NOT a safe assumption for forge's persisted surfaces: the dashboard timeline can
// be network-reachable, and the durable event store outlives the session and can be
// backed up. So the three free-text fields readiness PERSISTS — the setup command, the
// stderr tail of a failed setup, and a refusal's recorded command — must not carry an
// operator's credentials into the record or the event payload.
//
// Every test here asserts the SAME shape: a credential-shaped value that flows through
// a persistence site comes out `«redacted»` on the record AND the event, while the
// value handed to the actual setup child stays REAL (execution still works), and
// ordinary output is left byte-intact (the redactor is not a mangler).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { eventsForRun } from "../store/events.js";
import { hostConfigPath } from "../util/paths.js";
import {
  prepareHostVerification,
  redactSecrets,
  type HostReadinessDeps,
  type HostReadinessOutcome,
  type SetupRun,
} from "./host-readiness.js";
import { readReadinessRecord } from "./host-readiness-store.js";

let prevDb: DatabaseInstance | null;
const dirs: string[] = [];
const envKeys = [
  "FORGE_HOST_VERIFICATION_SETUP", "FORGE_HOST_READINESS_REQUIRE_ABI",
  "FORGE_WORKTREES", "FORGE_NO_WORKTREES", "FORGE_HOST_READINESS_SETUP_TIMEOUT_MS",
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  prevDb = setDbForTest(makeInMemoryDb());
  savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];
  process.env.FORGE_WORKTREES = "0";
  rmSync(hostConfigPath(), { force: true });
});

afterEach(() => {
  setDbForTest(prevDb as DatabaseInstance);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(hostConfigPath(), { force: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A workspace readiness will actually prepare: declares deps, has a lockfile, no
 *  node_modules. */
function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fg634-ws-")));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "fg634-fixture", version: "1.0.0", private: true,
    dependencies: { "some-dep": "1.0.0" },
  }));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "fg634-fixture", lockfileVersion: 3 }));
  return dir;
}

/** A REAL directory to stand in for "not the forge source root" — FG-693's guard
 *  re-derives identity from disk, so a non-existent path refuses as UNPROVEN. */
function notTheForgeRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fg634-not-forge-")));
  dirs.push(dir);
  return dir;
}

type SetupCall = { cmd: string; args: string[] };

/** Injected deps: capture the argv the child WOULD have run (to prove it is
 *  un-redacted), and let each test dictate the SetupRun (ok, or a failure carrying a
 *  chosen stderr tail). */
function deps(calls: SetupCall[], run: SetupRun): HostReadinessDeps {
  return {
    runSetup: (cmd, args): SetupRun => {
      calls.push({ cmd, args });
      return run;
    },
    porcelain: () => "",
    sourceRoot: notTheForgeRoot(),
  };
}

const RUN_ID = "fg634-run";

function prepare(ws: string, d: HostReadinessDeps): Promise<HostReadinessOutcome> {
  return prepareHostVerification(
    { workspace: ws, treeSha: "deadbeef", coveredCommandSet: ["npm run test:unit"], label: "test", runId: RUN_ID },
    d,
  );
}

function eventPayload(type: string): Record<string, unknown> {
  const ev = eventsForRun(RUN_ID).find((e) => e.eventType === type);
  assert.ok(ev, `expected a ${type} event`);
  return ev!.payload as Record<string, unknown>;
}

const OK: SetupRun = { ok: true, status: 0, timedOut: false, stderrTail: "" };

// ── redactSecrets unit coverage — the four structural credential shapes ────────────

test("FG-634: redacts basic-auth in a registry URL, keeps scheme and host", () => {
  const out = redactSecrets("npm ci --registry https://ci-bot:s3cr3tPassw0rd@mirror.example.com/");
  assert.match(out, /https:\/\/«redacted»@mirror\.example\.com\//);
  assert.doesNotMatch(out, /s3cr3tPassw0rd/);
  assert.doesNotMatch(out, /ci-bot:/);
});

test("FG-634: redacts npm _authToken / _auth / _password lines, keeps the registry key", () => {
  const out = redactSecrets(
    "//registry.example.com/:_authToken=npm_aB3xYz9QqTOKEN\n_auth=BASE64CREDS==\n_password=hunter2",
  );
  assert.match(out, /\/\/registry\.example\.com\/:_authToken=«redacted»/);
  assert.match(out, /_auth=«redacted»/);
  assert.match(out, /_password=«redacted»/);
  assert.doesNotMatch(out, /npm_aB3xYz9QqTOKEN|BASE64CREDS|hunter2/);
});

test("FG-634: redacts *_TOKEN / *_SECRET / *_KEY / *PASSWORD env assignments, keeps the name", () => {
  const out = redactSecrets("NPM_TOKEN=abc123 AWS_SECRET=zzz DEPLOY_KEY=kkk DB_PASSWORD=pw");
  assert.match(out, /NPM_TOKEN=«redacted»/);
  assert.match(out, /AWS_SECRET=«redacted»/);
  assert.match(out, /DEPLOY_KEY=«redacted»/);
  assert.match(out, /DB_PASSWORD=«redacted»/);
  assert.doesNotMatch(out, /abc123|zzz|kkk|\bpw\b/);
});

test("FG-634 (RF-1): an empty-username basic-auth URL still redacts the password", () => {
  // `scheme://:password@host` — the username is empty, which previously slipped past
  // the redactor's mandatory-username pattern and leaked the token.
  const out = redactSecrets("npm ci --registry https://:s3cr3tPassw0rd@mirror.example.com/");
  assert.match(out, /https:\/\/«redacted»@mirror\.example\.com\//);
  assert.doesNotMatch(out, /s3cr3tPassw0rd/);
});

test("FG-634 (RF-3): a quoted whitespace-containing secret value is redacted whole, not just to the first space", () => {
  const single = redactSecrets("DB_PASSWORD='correct horse battery staple'");
  assert.match(single, /DB_PASSWORD=«redacted»/);
  assert.doesNotMatch(single, /horse|battery|staple/);

  const dbl = redactSecrets('API_SECRET="a b c d"');
  assert.match(dbl, /API_SECRET=«redacted»/);
  assert.doesNotMatch(dbl, /\bb\b|\bc\b|\bd\b/);

  const back = redactSecrets("DEPLOY_KEY=`k1 k2 k3`");
  assert.match(back, /DEPLOY_KEY=«redacted»/);
  assert.doesNotMatch(back, /k2|k3/);
});

test("FG-634: redacts Authorization Bearer/Basic headers, keeps the scheme", () => {
  const out = redactSecrets("Authorization: Bearer eyJhbG.tok.en\nAuthorization: Basic dXNlcjpwYXNz");
  assert.match(out, /Authorization: Bearer «redacted»/);
  assert.match(out, /Authorization: Basic «redacted»/);
  assert.doesNotMatch(out, /eyJhbG|dXNlcjpwYXNz/);
});

test("FG-634: FALSE-POSITIVE GUARD — ordinary readiness output is left byte-intact", () => {
  // Error tails, a 40-char git SHA, a lockfile digest and module paths are the exact
  // audit signal these fields exist to carry — the redactor must not touch them.
  const benign =
    "npm error code ERR_MODULE_NOT_FOUND\n" +
    "Cannot find module '/ws/node_modules/foo/index.js'\n" +
    "tree 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b digest sha256-QmFrZWQ\n" +
    "npm ci --cache-key build-42 --registry https://registry.npmjs.org/";
  assert.equal(redactSecrets(benign), benign);
});

// ── FINDING 1: setupCommand at the persistence boundary ────────────────────────────

test("FG-634 (finding 1): a credential-shaped setupCommand is redacted in the record AND the ready event, but the child runs it REAL", async () => {
  const ws = workspace();
  // Operator host config embeds a //user:pass@ mirror URL in the install argv.
  process.env.FORGE_HOST_VERIFICATION_SETUP = JSON.stringify([
    "npm", "ci", "--registry", "https://ci-bot:s3cr3tPassw0rd@mirror.example.com/",
  ]);
  const calls: SetupCall[] = [];
  const outcome = await prepare(ws, deps(calls, OK));
  assert.equal(outcome.kind, "ready", `expected ready, got ${outcome.kind}`);

  // Durable record: redacted, secret gone.
  const record = readReadinessRecord(ws);
  assert.ok(record, "a ready record must exist");
  assert.match(record!.setupCommand, /«redacted»/);
  assert.doesNotMatch(record!.setupCommand, /s3cr3tPassw0rd/);

  // Event payload: redacted, secret gone.
  const payload = eventPayload("host_readiness.ready");
  assert.match(String(payload.setupCommand), /«redacted»/);
  assert.doesNotMatch(String(payload.setupCommand), /s3cr3tPassw0rd/);

  // The CHILD got the real value — execution is un-redacted (audit-surface-only).
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    cmd: "npm",
    args: ["ci", "--registry", "https://ci-bot:s3cr3tPassw0rd@mirror.example.com/"],
  });
});

// ── FINDING 2: stderrTail at the persistence boundary ──────────────────────────────

test("FG-634 (finding 2): a credential-shaped stderrTail is redacted in the refusal AND the refused event", async () => {
  const ws = workspace();
  const secretStderr =
    "npm error code E401\n" +
    "//registry.example.com/:_authToken=npm_leakedTOKENvalue\n" +
    "Authorization: Bearer eyJleY.leaked.jwt";
  const failed: SetupRun = { ok: false, status: 1, timedOut: false, stderrTail: secretStderr };
  const outcome = await prepare(ws, deps([], failed));
  assert.equal(outcome.kind, "refused", `expected refused, got ${outcome.kind}`);
  const refusal = (outcome as { refusal: { reason: string; stderrTail: string } }).refusal;
  assert.equal(refusal.reason, "setup_failed");

  // Refusal object: redacted, no secret substring.
  assert.match(refusal.stderrTail, /_authToken=«redacted»/);
  assert.match(refusal.stderrTail, /Bearer «redacted»/);
  assert.doesNotMatch(refusal.stderrTail, /npm_leakedTOKENvalue|eyJleY\.leaked\.jwt/);

  // Event payload: redacted too.
  const payload = eventPayload("host_readiness.refused");
  assert.doesNotMatch(String(payload.stderrTail), /npm_leakedTOKENvalue|eyJleY\.leaked\.jwt/);
  assert.match(String(payload.stderrTail), /«redacted»/);
});

test("FG-634 (RF-2): the refused event carries the redacted refusal message", async () => {
  const ws = workspace();
  const failed: SetupRun = { ok: false, status: 1, timedOut: false, stderrTail: "boom" };
  const outcome = await prepare(ws, deps([], failed));
  assert.equal(outcome.kind, "refused");
  const refusal = (outcome as { refusal: { message: string } }).refusal;

  const payload = eventPayload("host_readiness.refused");
  assert.equal(payload.message, refusal.message, "event message must equal the refusal object's message");
  assert.match(String(payload.message), /verification_environment_unavailable/);
});

test("FG-634 (finding 2, false-positive guard): a benign stderrTail is recorded intact", async () => {
  const ws = workspace();
  const benign = "npm error code ELIFECYCLE\nnode-gyp exited 1: no C compiler found";
  const failed: SetupRun = { ok: false, status: 1, timedOut: false, stderrTail: benign };
  const outcome = await prepare(ws, deps([], failed));
  assert.equal(outcome.kind, "refused");
  const refusal = (outcome as { refusal: { stderrTail: string } }).refusal;
  assert.equal(refusal.stderrTail, benign);
  assert.doesNotMatch(refusal.stderrTail, /«redacted»/);
});

// ── FINDING 1/3 refusal command: an ambiguous contract's raw value is redacted ─────

test("FG-634: a refusal's recorded command is redacted (ambiguous contract carrying a secret URL)", async () => {
  const ws = workspace();
  // A shell-shaped contract forge refuses without splitting — its `raw` is recorded as
  // the refusal command and would otherwise carry the embedded credential verbatim.
  process.env.FORGE_HOST_VERIFICATION_SETUP =
    "npm ci --registry https://ci-bot:s3cr3tPassw0rd@mirror.example.com/ && npm run build";
  const outcome = await prepare(ws, deps([], OK));
  assert.equal(outcome.kind, "refused");
  const refusal = (outcome as { refusal: { reason: string; command: string } }).refusal;
  assert.equal(refusal.reason, "ambiguous_setup_contract");
  assert.doesNotMatch(refusal.command, /s3cr3tPassw0rd/);
  assert.match(refusal.command, /«redacted»/);

  const payload = eventPayload("host_readiness.refused");
  assert.doesNotMatch(String(payload.command), /s3cr3tPassw0rd/);
});

test("FG-634: a benign setupCommand reaches the record intact (false-positive guard on the argv path)", async () => {
  const ws = workspace();
  process.env.FORGE_HOST_VERIFICATION_SETUP = JSON.stringify(["npm", "ci"]);
  const outcome = await prepare(ws, deps([], OK));
  assert.equal(outcome.kind, "ready");
  const record = readReadinessRecord(ws);
  assert.equal(record!.setupCommand, "npm ci");
  assert.doesNotMatch(record!.setupCommand, /«redacted»/);
});

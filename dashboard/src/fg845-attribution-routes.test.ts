// FG-845 part 2 — the two attribution routes: registry rows, the body shape and its closed
// value set, the fixed argv (and that the client's previewed verb is the one it runs), the
// guards and refusals before any spawn, `--project` from the registry never the caller, and
// the CLI recording `config.ai_attribution_changed` with the dashboard as actor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

const HOME = mkdtempSync(join(tmpdir(), "fg845-routes-home-"));
process.env["FORGE_HOME"] = HOME;
delete process.env["HOST"];
delete process.env["FORGE_AI_ATTRIBUTION_CARRIED"];

const {
  AI_ATTRIBUTION_PATH,
  HOST_ATTRIBUTION_CHOICES,
  PROJECT_ATTRIBUTION_CHOICES,
  buildAiAttributionArgv,
  handleAiAttributionMutation,
  parseAiAttributionRequest,
} = await import("./ai-attribution-mutation.js");
const { ACTION_FORGE_VERBS, ACTION_ROUTES, isActionMutationPath } = await import("./action-mutation.js");
const { isRefusal } = await import("./mutation-guards.js");
const { attributionCommand } = await import("../client/attribution-render.js");
const { Command } = await import("commander");
const { registerConfig } = await import("../../src/cli/commands/config.js");
const { makeInMemoryDb, setDbForTest } = await import("../../src/store/db.js");
const { readAiAttribution } = await import("../../src/v2/ai-attribution.js");
const { provenPhysical } = await import("../../src/util/path-identity.js");

type Request = Parameters<typeof parseAiAttributionRequest>[0];

test("the registry: two rows shelling the one `config` verb; nothing else matches the path", () => {
  assert.deepEqual(ACTION_ROUTES["ai-attribution-project"], { path: "/api/ai-attribution/project", verb: "config" });
  assert.deepEqual(ACTION_ROUTES["ai-attribution-host"], { path: "/api/ai-attribution/host", verb: "config" });
  assert.ok((ACTION_FORGE_VERBS as readonly string[]).includes("config"));
  for (const path of ["/api/ai-attribution/project", "/api/ai-attribution/host"]) assert.ok(isActionMutationPath(path), path);
  for (const path of ["/api/ai-attribution", "/api/ai-attribution/project/force", "/api/ai-attribution/unset", "/api/config/set", "/api/ai-attribution/host/"]) {
    assert.equal(AI_ATTRIBUTION_PATH.test(path), false, path);
    assert.equal(isActionMutationPath(path), false, path);
  }
});

test("parseAiAttributionRequest: the closed value sets — suppress | allow | inherit for a project, suppress | allow for the host", () => {
  assert.deepEqual([...PROJECT_ATTRIBUTION_CHOICES], ["suppress", "allow", "inherit"]);
  assert.deepEqual([...HOST_ATTRIBUTION_CHOICES], ["suppress", "allow"]);
  for (const mode of PROJECT_ATTRIBUTION_CHOICES) {
    assert.deepEqual(parseAiAttributionRequest("ai-attribution-project", { projectKey: "k", projectDir: "/c", mode }), {
      action: "ai-attribution-project", projectKey: "k", projectDir: "/c", mode,
    });
  }
  for (const mode of HOST_ATTRIBUTION_CHOICES) assert.deepEqual(parseAiAttributionRequest("ai-attribution-host", { mode }), { action: "ai-attribution-host", mode });

  const refused: Array<[Request, unknown, RegExp]> = [
    ["ai-attribution-host", { mode: "inherit" }, /mode must be one of suppress, allow/],
    ["ai-attribution-host", { mode: "ALLOW" }, /mode must be one of/],
    ["ai-attribution-host", {}, /mode must be one of/],
    ["ai-attribution-host", { mode: "allow", projectKey: "k" }, /refusing projectKey/],
    ["ai-attribution-host", { mode: "allow", force: true }, /refusing force/],
    ["ai-attribution-project", { projectKey: "k", mode: "on" }, /mode must be one of suppress, allow, inherit/],
    ["ai-attribution-project", { projectKey: "k", mode: "--host" }, /mode must be one of/],
    ["ai-attribution-project", { mode: "allow" }, /projectKey is required/],
    ["ai-attribution-project", { projectKey: " ", mode: "allow" }, /projectKey is required/],
    ["ai-attribution-project", { projectKey: "k", projectDir: 7, mode: "allow" }, /projectDir must be a string/],
    ["ai-attribution-project", { projectKey: "k", mode: "allow", file: "/etc/passwd" }, /refusing file/],
    ["ai-attribution-project", ["allow"], /JSON object/],
    ["ai-attribution-project", null, /JSON object/],
  ];
  for (const [action, body, why] of refused) {
    const out = parseAiAttributionRequest(action, body);
    assert.ok(isRefusal(out), JSON.stringify(body));
    if (isRefusal(out)) {
      assert.equal(out.status, 400);
      assert.match(out.error, why);
    }
  }
});

test("buildAiAttributionArgv: the fixed argv per choice, --project the resolved checkout, the actor recorded; the client previews the same verb", () => {
  const cases: Array<[Parameters<typeof buildAiAttributionArgv>[0], string[]]> = [
    [{ action: "ai-attribution-project", projectKey: "k", projectDir: undefined, mode: "allow" }, ["config", "set", "ai-attribution", "allow", "--project", "/repo", "--actor", "dashboard"]],
    [{ action: "ai-attribution-project", projectKey: "k", projectDir: undefined, mode: "suppress" }, ["config", "set", "ai-attribution", "suppress", "--project", "/repo", "--actor", "dashboard"]],
    [{ action: "ai-attribution-project", projectKey: "k", projectDir: undefined, mode: "inherit" }, ["config", "unset", "ai-attribution", "--project", "/repo", "--actor", "dashboard"]],
    [{ action: "ai-attribution-host", mode: "allow" }, ["config", "set", "ai-attribution", "allow", "--host", "--actor", "dashboard"]],
    [{ action: "ai-attribution-host", mode: "suppress" }, ["config", "set", "ai-attribution", "suppress", "--host", "--actor", "dashboard"]],
  ];
  for (const [request, argv] of cases) {
    const built = buildAiAttributionArgv(request, request.action === "ai-attribution-host" ? undefined : "/repo", "dashboard");
    assert.ok(!isRefusal(built));
    if (isRefusal(built)) continue;
    assert.deepEqual(built.argv, argv);
    assert.ok(!built.argv.includes("--force"));
    const target = request.action === "ai-attribution-host" ? "host" : "project";
    assert.equal(built.command, attributionCommand(target, request.mode), "Preview shows exactly the verb Confirm runs");
  }
  const project = { action: "ai-attribution-project", projectKey: "k", projectDir: undefined, mode: "allow" } as const;
  assert.ok(isRefusal(buildAiAttributionArgv(project, "relative/dir", "dashboard")));
  assert.ok(isRefusal(buildAiAttributionArgv(project, undefined, "dashboard")));
});

// ─── the handler, against a recording FORGE_BIN ──────────────────────────────

const BIN_DIR = mkdtempSync(join(tmpdir(), "fg845-bin-"));
const ARGV_LOG = join(BIN_DIR, "argv.log");
const FAKE_FORGE = join(BIN_DIR, "forge");
writeFileSync(FAKE_FORGE, `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > "${ARGV_LOG}"\necho "set ok"\n`);
chmodSync(FAKE_FORGE, 0o755);
process.env["FORGE_BIN"] = FAKE_FORGE;

const CHECKOUT = mkdtempSync(join(tmpdir(), "fg845-checkout-"));
const OTHER = mkdtempSync(join(tmpdir(), "fg845-other-"));
const PROJECT = {
  key: "pk-1",
  label: "proj",
  primaryCheckout: CHECKOUT,
  projectDir: CHECKOUT,
  checkouts: [{ projectDir: CHECKOUT, projectDirs: [CHECKOUT], exists: true, runCount: 0, inFlightCount: 0, liveSessions: 0 }],
} as never;

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]) as unknown as IncomingMessage;
  req.headers = { host: "127.0.0.1:8024", "content-type": "application/json", origin: "http://127.0.0.1:8024", ...headers };
  req.method = "POST";
  return new Promise((resolve) => {
    let status = 0;
    const res = {
      writeHead(s: number) {
        status = s;
        return res;
      },
      end(text: string) {
        resolve({ status, body: JSON.parse(text) as Record<string, unknown> });
      },
    } as unknown as ServerResponse;
    void handleAiAttributionMutation(req, res, path, { resolveProject: (key) => (key === "pk-1" ? PROJECT : undefined), actor: "dashboard" });
  });
}

function spawned(): string[] | null {
  if (!existsSync(ARGV_LOG)) return null;
  const lines = readFileSync(ARGV_LOG, "utf8").trimEnd().split("\n");
  writeFileSync(ARGV_LOG, "");
  return lines[0] === "" && lines.length === 1 ? null : lines;
}

test("handler: a project change shells the registered argv with the registry's checkout — a caller path is never --project", async () => {
  spawned();
  const out = await post("/api/ai-attribution/project", { projectKey: "pk-1", projectDir: OTHER, mode: "allow" });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body["verb"], "forge config set ai-attribution allow");
  const argv = spawned();
  assert.ok(argv);
  assert.equal(provenPhysical(argv[0]!), provenPhysical(CHECKOUT), "runs in the registry's checkout");
  assert.deepEqual(argv.slice(1), ["config", "set", "ai-attribution", "allow", "--project", CHECKOUT, "--actor", "dashboard"]);

  const inherit = await post("/api/ai-attribution/project", { projectKey: "pk-1", mode: "inherit" });
  assert.equal(inherit.status, 200);
  assert.deepEqual(spawned()!.slice(1), ["config", "unset", "ai-attribution", "--project", CHECKOUT, "--actor", "dashboard"]);

  const host = await post("/api/ai-attribution/host", { mode: "suppress" });
  assert.equal(host.status, 200);
  assert.deepEqual(spawned()!.slice(1), ["config", "set", "ai-attribution", "suppress", "--host", "--actor", "dashboard"]);
});

test("handler: an applied change whose audit record failed is reported applied, with the CLI's audit warning", async () => {
  const warnBin = join(BIN_DIR, "forge-audit-gap");
  writeFileSync(warnBin, `#!/bin/sh\necho "set ai-attribution = allow (host default)"\necho "warning: applied, but the config.ai_attribution_changed audit event was not recorded: disk I/O error" >&2\n`);
  chmodSync(warnBin, 0o755);
  process.env["FORGE_BIN"] = warnBin;
  try {
    const out = await post("/api/ai-attribution/host", { mode: "allow" });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body["ok"], true);
    assert.equal(out.body["stdout"], "set ai-attribution = allow (host default)");
    assert.equal(out.body["auditWarning"], "warning: applied, but the config.ai_attribution_changed audit event was not recorded: disk I/O error");
  } finally {
    process.env["FORGE_BIN"] = FAKE_FORGE;
  }
  const clean = await post("/api/ai-attribution/host", { mode: "allow" });
  assert.equal("auditWarning" in clean.body, false);
});

test("handler: every refusal happens before a spawn — guards, bad JSON, bad value, unknown project", async () => {
  spawned();
  const refusals: Array<[string, unknown, Record<string, string>, number]> = [
    ["/api/ai-attribution/host", { mode: "allow" }, { "content-type": "text/plain" }, 415],
    ["/api/ai-attribution/host", { mode: "allow" }, { origin: "http://evil.example" }, 403],
    ["/api/ai-attribution/host", { mode: "allow" }, { "sec-fetch-site": "cross-site" }, 403],
    ["/api/ai-attribution/host", { mode: "allow" }, { host: "attacker.example:8024" }, 403],
    ["/api/ai-attribution/host", "{not json", {}, 400],
    ["/api/ai-attribution/host", { mode: "inherit" }, {}, 400],
    ["/api/ai-attribution/project", { projectKey: "pk-1", mode: "yes" }, {}, 400],
    ["/api/ai-attribution/project", { projectKey: "nope", mode: "allow" }, {}, 404],
    ["/api/ai-attribution/project", { projectKey: "pk-1", mode: "allow", force: true }, {}, 400],
  ];
  for (const [path, body, headers, status] of refusals) {
    const out = await post(path, body, headers);
    assert.equal(out.status, status, `${path} ${JSON.stringify(body)} ${JSON.stringify(headers)}: ${JSON.stringify(out.body)}`);
    assert.equal(out.body["ok"], false);
    assert.equal(spawned(), null, "nothing spawned");
  }

  process.env["HOST"] = "0.0.0.0";
  try {
    const out = await post("/api/ai-attribution/host", { mode: "allow" });
    assert.equal(out.status, 403);
    assert.match(String(out.body["error"]), /not loopback/);
    assert.equal(spawned(), null);
  } finally {
    delete process.env["HOST"];
  }
});

// ─── the verb the route shells, run in-process: the write and its event ──────

async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerConfig(program);
  const orig = console.log;
  console.log = () => {};
  try {
    await program.parseAsync(argv, { from: "user" });
  } finally {
    console.log = orig;
  }
}

test("the built argv, run by the real CLI: the files change and config.ai_attribution_changed records before/after/source with actor dashboard", async () => {
  const db = makeInMemoryDb();
  const prev = setDbForTest(db);
  try {
    const repo = mkdtempSync(join(tmpdir(), "fg845-cli-"));
    mkdirSync(join(repo, ".forge"), { recursive: true });
    writeFileSync(join(repo, ".forge", "config.yml"), "project_key: pk\n");
    const projectFile = join(repo, ".forge", "config.yml");
    const hostFile = join(HOME, "config.yml");
    const argvFor = (request: Parameters<typeof buildAiAttributionArgv>[0]) => {
      const built = buildAiAttributionArgv(request, request.action === "ai-attribution-host" ? undefined : repo, "dashboard");
      assert.ok(!isRefusal(built));
      return (built as { argv: string[] }).argv;
    };

    await runCli(argvFor({ action: "ai-attribution-project", projectKey: "k", projectDir: undefined, mode: "allow" }));
    assert.deepEqual(readAiAttribution(repo, { carried: null }), { mode: "allow", source: "project", file: projectFile });
    await runCli(argvFor({ action: "ai-attribution-host", mode: "allow" }));
    await runCli(argvFor({ action: "ai-attribution-project", projectKey: "k", projectDir: undefined, mode: "inherit" }));
    assert.deepEqual(readAiAttribution(repo, { carried: null }), { mode: "allow", source: "host", file: hostFile });
    await runCli(argvFor({ action: "ai-attribution-project", projectKey: "k", projectDir: undefined, mode: "inherit" }));

    const events = (db.prepare("SELECT event_type, payload FROM events WHERE event_type = 'config.ai_attribution_changed' ORDER BY id").all() as Array<{ payload: string }>).map(
      (r) => JSON.parse(r.payload) as Record<string, unknown>,
    );
    assert.deepEqual(events, [
      { level: "project", file: projectFile, before: null, after: "allow", actor: "dashboard", projectDir: repo, resolved: { mode: "allow", source: "project" } },
      { level: "host", file: hostFile, before: null, after: "allow", actor: "dashboard" },
      { level: "project", file: projectFile, before: "allow", after: null, actor: "dashboard", projectDir: repo, resolved: { mode: "allow", source: "host" } },
    ], "a no-op unset logs nothing");
  } finally {
    if (prev) setDbForTest(prev);
  }
});

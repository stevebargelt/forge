// FG-799 (AC1): `forge config set/show ai-attribution` and the `forge doctor`
// line, exercised through the real CLI (tsx entry) against a temp project.
// FG-845 (AC2): the host default — `set --host`, `unset`, and the project / host /
// default source on show and doctor. Every spawn gets its OWN disposable FORGE_HOME.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../../integration-cli-spawn.js";

let projectDir: string;
let forgeHome: string;

function runForge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], { cwd: projectDir, encoding: "utf8", env: { ...process.env, FORGE_HOME: forgeHome } });
}

function hostConfigPath(): string {
  return join(forgeHome, "config.yml");
}

function configPath(): string {
  return join(projectDir, ".forge", "config.yml");
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-fg799-cfg-"));
  forgeHome = mkdtempSync(join(tmpdir(), "forge-fg845-home-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(forgeHome, { recursive: true, force: true });
});

test("FG-799 (AC1): config show reports the suppress default when no config exists", () => {
  const res = runForge(["config", "show", "--project", projectDir]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /ai attribution: suppress \(default\)/);
});

test("FG-799 (AC1): config set ai-attribution allow writes the key and show/report reflect it", () => {
  const set = runForge(["config", "set", "ai-attribution", "allow", "--project", projectDir]);
  assert.equal(set.status, 0, set.stderr);

  const parsed = parseYaml(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
  assert.equal(parsed["ai_attribution"], "allow", "snake_case key in YAML");

  const show = runForge(["config", "show", "--project", projectDir]);
  assert.match(show.stdout, /ai attribution: allow \(project\)/);
});

test("FG-799 (AC1): config set PRESERVES other keys (read-modify-write, not template-overwrite)", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(configPath(), "project_key: pk-xyz\nbacklog:\n  prefix: FG\n");

  const set = runForge(["config", "set", "ai-attribution", "suppress", "--project", projectDir]);
  assert.equal(set.status, 0, set.stderr);

  const parsed = parseYaml(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
  assert.equal(parsed["project_key"], "pk-xyz");
  assert.deepEqual(parsed["backlog"], { prefix: "FG" });
  assert.equal(parsed["ai_attribution"], "suppress");
});

test("FG-799 (AC1): an invalid value is refused, naming the two valid ones", () => {
  const res = runForge(["config", "set", "ai-attribution", "sometimes", "--project", projectDir]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr + res.stdout, /suppress/);
  assert.match(res.stderr + res.stdout, /allow/);
});

test("FG-799 (AC1): an unknown key is refused", () => {
  const res = runForge(["config", "set", "nonsense", "allow", "--project", projectDir]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr + res.stdout, /unknown config key/);
});

test("FG-799 (AC1): forge doctor prints the effective ai attribution line", () => {
  runForge(["config", "set", "ai-attribution", "allow", "--project", projectDir]);
  // doctor runs against cwd; --json is a stable surface that never needs docker.
  const res = runForge(["doctor", "--json"]);
  // doctor may exit 1 on readiness, but the JSON payload must carry the mode.
  const parsed = JSON.parse(res.stdout);
  assert.deepEqual(parsed.aiAttribution, { mode: "allow", source: "project", file: configPath() });
});

// ── FG-845 (AC2) ────────────────────────────────────────────────────────────

test("FG-845 (AC2): config set --host creates the host file when absent; show reports (host) and --json carries mode/source/file", () => {
  const set = runForge(["config", "set", "ai-attribution", "allow", "--host"]);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /host default/);
  assert.deepEqual(parseYaml(readFileSync(hostConfigPath(), "utf8")), { ai_attribution: "allow" });
  assert.ok(!existsSync(configPath()), "--host never writes the project file");

  const show = runForge(["config", "show", "--project", projectDir]);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /ai attribution: allow \(host\)/);

  const json = runForge(["config", "show", "--project", projectDir, "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { aiAttribution: { mode: "allow", source: "host", file: hostConfigPath() } });

  const doctor = runForge(["doctor", "--json"]);
  assert.deepEqual(JSON.parse(doctor.stdout).aiAttribution, { mode: "allow", source: "host", file: hostConfigPath() });
});

test("FG-845 (AC2): config set --host changes only ai_attribution and preserves neighbouring host bytes", () => {
  const before = "# operator-owned comment\ntelemetry: off\nai_attribution: allow\nnested:\n  k: v\n";
  writeFileSync(hostConfigPath(), before);
  const set = runForge(["config", "set", "ai-attribution", "suppress", "--host"]);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(
    readFileSync(hostConfigPath(), "utf8"),
    before.replace("ai_attribution: allow", "ai_attribution: suppress"),
    "read-modify-write must not reformat operator-owned neighbours",
  );
});

test("FG-845 (AC2): config set (project) replaces the ai_attribution line in place, keeping comments, neighbours and an inline comment", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  const before = "# operator-owned comment\nproject_key: 'pk-xyz'\n\nai_attribution: allow   # why\nbacklog:\n  prefix: FG\n  ai_attribution: nested\n";
  writeFileSync(configPath(), before);
  const set = runForge(["config", "set", "ai-attribution", "suppress", "--project", projectDir]);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(readFileSync(configPath(), "utf8"), before.replace("ai_attribution: allow   # why", "ai_attribution: suppress   # why"));
});

test("FG-845 (AC2): config set (project and --host) appends exactly one line when the key is absent", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  const project = "# operator-owned comment\nproject_key: pk-xyz\nbacklog:\n  ai_attribution: nested\n";
  writeFileSync(configPath(), project);
  assert.equal(runForge(["config", "set", "ai-attribution", "allow", "--project", projectDir]).status, 0);
  assert.equal(readFileSync(configPath(), "utf8"), `${project}ai_attribution: allow\n`);

  const host = "# operator-owned comment\ntelemetry: off";
  writeFileSync(hostConfigPath(), host);
  const set = runForge(["config", "set", "ai-attribution", "allow", "--host"]);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(readFileSync(hostConfigPath(), "utf8"), `${host}\nai_attribution: allow\n`, "no trailing newline → one separator, one line");
});

test("FG-845 (AC2): config set refuses an unparseable file (project and --host) and writes nothing", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  const before = "# keep me\nproject_key: [unterminated\n";
  writeFileSync(configPath(), before);
  const project = runForge(["config", "set", "ai-attribution", "allow", "--project", projectDir]);
  assert.notEqual(project.status, 0);
  assert.match(project.stderr + project.stdout, /refusing to rewrite .*not valid YAML/);
  assert.equal(readFileSync(configPath(), "utf8"), before);

  writeFileSync(hostConfigPath(), before);
  const host = runForge(["config", "set", "ai-attribution", "allow", "--host"]);
  assert.notEqual(host.status, 0);
  assert.match(host.stderr + host.stdout, /refusing to rewrite .*not valid YAML/);
  assert.equal(readFileSync(hostConfigPath(), "utf8"), before);
});

test("FG-845 (AC2): config set --host refuses an invalid value and writes nothing", () => {
  const res = runForge(["config", "set", "ai-attribution", "sometimes", "--host"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr + res.stdout, /Valid values: suppress, allow/);
  assert.ok(!existsSync(hostConfigPath()), "no host file is created by a refused write");
});

test("FG-845 (AC2): config set refuses an unsupported key before either host or project write", () => {
  const hostBefore = "telemetry: off\n";
  writeFileSync(hostConfigPath(), hostBefore);
  const host = runForge(["config", "set", "telemetry", "on", "--host"]);
  assert.notEqual(host.status, 0);
  assert.match(host.stderr + host.stdout, /unknown config key 'telemetry'. Supported: ai-attribution/);
  assert.equal(readFileSync(hostConfigPath(), "utf8"), hostBefore);

  const project = runForge(["config", "set", "telemetry", "on", "--project", projectDir]);
  assert.notEqual(project.status, 0);
  assert.match(project.stderr + project.stdout, /unknown config key 'telemetry'. Supported: ai-attribution/);
  assert.ok(!existsSync(configPath()), "unsupported project key does not create config");
});

test("FG-845 (AC2): --host and --project together are refused", () => {
  const res = runForge(["config", "set", "ai-attribution", "allow", "--host", "--project", projectDir]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr + res.stdout, /mutually exclusive/);
  assert.ok(!existsSync(hostConfigPath()));
  assert.ok(!existsSync(configPath()));
});

test("FG-845 (AC2): config unset removes the project key, preserves neighbours, and the project inherits the host default", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(configPath(), "project_key: pk-xyz\nai_attribution: suppress\nbacklog:\n  prefix: FG\n");
  writeFileSync(hostConfigPath(), "ai_attribution: allow\n");
  assert.match(runForge(["config", "show", "--project", projectDir]).stdout, /ai attribution: suppress \(project\)/);

  const unset = runForge(["config", "unset", "ai-attribution", "--project", projectDir]);
  assert.equal(unset.status, 0, unset.stderr);
  assert.match(unset.stdout, /unset ai-attribution/);
  assert.match(unset.stdout, /ai attribution: allow \(host\)/);
  assert.deepEqual(parseYaml(readFileSync(configPath(), "utf8")), { project_key: "pk-xyz", backlog: { prefix: "FG" } });
});

test("FG-845 (AC2): config unset deletes exactly the ai_attribution line, keeping comments, blank lines and nested keys", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  const kept = "# operator-owned comment\nproject_key: 'pk-xyz'\n\nbacklog:\n  prefix: FG\n  ai_attribution: nested\n";
  writeFileSync(configPath(), kept.replace("\nbacklog:", "\nai_attribution: allow # why\nbacklog:"));
  const unset = runForge(["config", "unset", "ai-attribution", "--project", projectDir]);
  assert.equal(unset.status, 0, unset.stderr);
  assert.equal(readFileSync(configPath(), "utf8"), kept);
});

test("FG-845 (AC2): config unset with no project key is a no-op that says so", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(configPath(), "project_key: pk-xyz\n");
  const beforeStat = statSync(configPath());
  const unset = runForge(["config", "unset", "ai-attribution", "--project", projectDir]);
  assert.equal(unset.status, 0, unset.stderr);
  assert.match(unset.stdout, /was not set .*nothing to unset/);
  assert.match(unset.stdout, /ai attribution: suppress \(default\)/);
  assert.equal(readFileSync(configPath(), "utf8"), "project_key: pk-xyz\n", "the file is untouched");
  assert.equal(statSync(configPath()).mtimeMs, beforeStat.mtimeMs, "a no-op must not replace the file");

  rmSync(join(projectDir, ".forge"), { recursive: true, force: true });
  const noFile = runForge(["config", "unset", "ai-attribution", "--project", projectDir]);
  assert.equal(noFile.status, 0, noFile.stderr);
  assert.match(noFile.stdout, /nothing to unset/);
  assert.ok(!existsSync(configPath()), "no file is created by a no-op unset");
});

test("FG-845 (AC2): config unset refuses any other key", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(configPath(), "project_key: pk-xyz\n");
  const res = runForge(["config", "unset", "project_key", "--project", projectDir]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr + res.stdout, /unknown config key 'project_key'. Supported: ai-attribution/);
  assert.equal(readFileSync(configPath(), "utf8"), "project_key: pk-xyz\n");
});

test("FG-845 (AC2): config unset refuses malformed project YAML and writes nothing", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  const before = "ai_attribution: [unterminated\n";
  writeFileSync(configPath(), before);
  const res = runForge(["config", "unset", "ai-attribution", "--project", projectDir]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr + res.stdout, /refusing to rewrite .*not valid YAML/);
  assert.equal(readFileSync(configPath(), "utf8"), before);
});

test("FG-845 (AC2): CLI resolution honors project, host, and default sources in config show and doctor human output", () => {
  const doctor = () => runForge(["doctor"]);
  const assertSurface = (mode: "allow" | "suppress", source: "project" | "host" | "default") => {
    const expected = new RegExp(`ai attribution: ${mode} \\(${source}\\)`);
    const show = runForge(["config", "show", "--project", projectDir]);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, expected);
    assert.match(doctor().stdout, expected);
  };

  writeFileSync(hostConfigPath(), "ai_attribution: suppress\n");
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(configPath(), "ai_attribution: allow\n");
  assertSurface("allow", "project");

  rmSync(join(projectDir, ".forge"), { recursive: true, force: true });
  writeFileSync(hostConfigPath(), "ai_attribution: allow\n");
  assertSurface("allow", "host");

  rmSync(hostConfigPath(), { force: true });
  assertSurface("suppress", "default");
});

test("FG-845 (AC2): malformed host stops resolution at host with its file and reason, rather than allowing", () => {
  writeFileSync(hostConfigPath(), "ai_attribution: yes\n");
  const show = runForge(["config", "show", "--project", projectDir]);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /ai attribution: suppress \(default\)/);
  assert.match(show.stdout, new RegExp(hostConfigPath().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(show.stdout, /unrecognized ai_attribution value.*failing closed to suppress/);
  const json = JSON.parse(runForge(["config", "show", "--project", projectDir, "--json"]).stdout);
  assert.equal(json.aiAttribution.source, "default");
  assert.equal(json.aiAttribution.file, hostConfigPath());
  assert.match(json.aiAttribution.reason, /unrecognized ai_attribution value/);
});

test("FG-845 (AC2): malformed project stops before an allow host default", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(configPath(), "ai_attribution: not-a-mode\n");
  writeFileSync(hostConfigPath(), "ai_attribution: allow\n");
  const show = runForge(["config", "show", "--project", projectDir]);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /ai attribution: suppress \(default\)/);
  assert.match(show.stdout, new RegExp(configPath().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(show.stdout, /failing closed to suppress/);
  const json = JSON.parse(runForge(["config", "show", "--project", projectDir, "--json"]).stdout);
  assert.deepEqual(json.aiAttribution, {
    mode: "suppress",
    source: "default",
    file: configPath(),
    reason: json.aiAttribution.reason,
  });
  assert.match(json.aiAttribution.reason, /unrecognized ai_attribution value/);
});

test("FG-845 (RF-1): a duplicated project ai_attribution key stops before an allow host default, naming the duplicate", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(configPath(), "ai_attribution: allow\nai_attribution: suppress\n");
  writeFileSync(hostConfigPath(), "ai_attribution: allow\n");
  const show = runForge(["config", "show", "--project", projectDir]);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /ai attribution: suppress \(default\)/);
  assert.match(show.stdout, /more than one top-level ai_attribution key.*failing closed to suppress/);
  const json = JSON.parse(runForge(["config", "show", "--project", projectDir, "--json"]).stdout);
  assert.equal(json.aiAttribution.mode, "suppress");
  assert.equal(json.aiAttribution.source, "default");
  assert.equal(json.aiAttribution.file, configPath());
  assert.match(json.aiAttribution.reason, /more than one top-level ai_attribution key/);
  assert.match(runForge(["doctor"]).stdout, /ai attribution: suppress \(default\)/);
});

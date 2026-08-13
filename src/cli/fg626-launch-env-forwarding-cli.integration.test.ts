// FG-626: operator-facing environment forwarding seams over the REAL forge CLI.
//
// The sibling v2 integration test proves the injected launch boundary and the warning.
// These cases deliberately exercise Commander parsing, durable record readback, and the
// tmux-owned workload as an operator uses them. src/test-setup.ts supplies a private tmux
// socket and deletes TMUX, so every CLI subprocess below inherits only the suite's server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "index.ts");
const tsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");
const repoRoot = resolve(here, "..", "..");
const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;

type Launch = { id: string; logPath: string; tmuxSession: string; status?: { state: string }; forwardedEnv?: { forwarded: { name: string; value: string }[]; dropped: { name: string; reason: string }[] }; workload?: { profile?: { label?: string; path: string; requireAbi: string } } };
type CliResult = { status: number | null; stdout: string; stderr: string };

/**
 * FG-707 deliberately drives its record assertions from the production allowlist rather
 * than sampling names in this spec. The list is module-private (not part of the launch
 * API), so read its declaration from the source that owns it; the count prevents a broad
 * regex from silently accepting an unrelated set of strings.
 */
function nonSecretForgeEnvAllowlist(): string[] {
  const source = readFileSync(resolve(repoRoot, "src", "v2", "launch.ts"), "utf8");
  const declaration = source.match(/const NON_SECRET_FORGE_ENV_ALLOWLIST:[\s\S]*?new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(declaration, "launch.ts declares the FG-707 non-secret FORGE_ allowlist");
  const names = [...declaration[1]!.matchAll(/"(FORGE_[A-Z0-9_]+)"/g)].map((match) => match[1]!);
  assert.equal(names.length, 10, "FG-707 has exactly the ten explicitly-reviewed safe names");
  assert.ok(!names.includes("FORGE_CONTROLLER_ID"), "FG-707/RF-4: the lease-fencing controller identity is NOT allowlisted");
  return names;
}

function forge(home: string, args: string[], env: NodeJS.ProcessEnv = {}): CliResult {
  const result = spawnSync(tsx, [entry, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: home, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function waitFor(what: string, condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

function launch(home: string, args: string[], env: NodeJS.ProcessEnv = {}): Launch {
  const result = forge(home, ["launch", "run", "--json", ...args], env);
  assert.equal(result.status, 0, `forge launch run failed: ${result.stderr}`);
  assert.doesNotThrow(() => JSON.parse(result.stdout), `--json stdout must be parseable: ${result.stdout}`);
  return JSON.parse(result.stdout) as Launch;
}

test(
  "FG-626 CLI (AC3): invocation FORGE_ env reaches the tmux workload, and show renders forwarded and dropped audit lines",
  { skip: hasTmux ? false : "tmux not available" },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "fg626-cli-audit-"));
    try {
      const meta = launch(
        home,
        ["--name", "audit", "--", process.execPath, "-e", "process.stdout.write('POLL=' + process.env.FORGE_CI_POLL_SECONDS + '\\n')"],
        { FORGE_CI_POLL_SECONDS: "37", FORGE_RELEASE_ID: "caller-controlled" },
      );
      await waitFor("the launched workload output", () => existsSync(meta.logPath) && readFileSync(meta.logPath, "utf8").includes("POLL=37"));

      const human = forge(home, ["launch", "show", meta.id]);
      assert.equal(human.status, 0, `forge launch show failed: ${human.stderr}`);
      assert.match(readFileSync(meta.logPath, "utf8"), /POLL=37/, "the workload saw the FORGE_ value supplied to the real CLI invocation");
      assert.match(human.stdout, /env fwd:.*FORGE_CI_POLL_SECONDS=37/, "human show records the forwarded invocation gate");
      assert.match(human.stdout, /env drop: FORGE_RELEASE_ID — NOT forwarded:/, "human show records the named denied variable and reason");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "FG-707 CLI: fail-closed allowlist — unlisted FORGE_ names (credential, FORGE_AUTH_MODE, an arbitrary name) are REDACTED in meta.json and `forge launch show`; allowlisted gates keep their value; the real value still reaches the workload",
  { skip: hasTmux ? false : "tmux not available" },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "fg707-cli-redact-"));
    const secret = "AWS_ACCESS_KEY_ID=AKIAEXAMPLE,AWS_SECRET_ACCESS_KEY=topsecretvalue,AWS_SESSION_TOKEN=sessiontok";
    const allowlisted = nonSecretForgeEnvAllowlist();
    const allowlistedValues = Object.fromEntries(allowlisted.map((name, index) => [name, `allowlisted-value-${index}`]));
    try {
      // The workload writes the values it actually sees to a side file OUTSIDE the launch
      // record — never to its stdout (that log tail is rendered by `forge launch show`) and
      // never embedded in argv (that is recorded as meta.command). Both would leak through a
      // surface redaction does not govern, masking whether the ENV RECORD is redacted.
      const seen = join(home, "seen-env.txt");
      const probe = `require('fs').writeFileSync(${JSON.stringify(seen)}, [process.env.FORGE_AWS_CREDS_FOR_TEST, process.env.FORGE_AUTH_MODE, process.env.FORGE_SOMETHING_UNKNOWN].join('|'))`;
      const meta = launch(
        home,
        ["--name", "redact", "--", process.execPath, "-e", probe],
        {
          FORGE_AWS_CREDS_FOR_TEST: secret,
          FORGE_AUTH_MODE: "mount",
          FORGE_SOMETHING_UNKNOWN: "arbitraryunlistedvalue",
          ...allowlistedValues,
        },
      );
      await waitFor("the launched workload output", () => existsSync(seen));

      // AC5: the workload got the REAL values — redaction is audit-surface only, gates armed.
      assert.equal(readFileSync(seen, "utf8"), `${secret}|mount|arbitraryunlistedvalue`, "the workload saw every un-redacted value");

      // AC2/AC3: the durable record on disk carries the NAMES but not the unlisted VALUES.
      const metaJson = readFileSync(join(home, "launches", meta.id, "meta.json"), "utf8");
      assert.ok(!metaJson.includes("topsecretvalue"), "no credential material is written into the durable launch record");
      assert.ok(!metaJson.includes("arbitraryunlistedvalue"), "an arbitrary unlisted value is not written into the durable launch record");
      const recorded = (JSON.parse(metaJson) as Launch).forwardedEnv!.forwarded;
      const byName = (n: string) => recorded.find((f) => f.name === n)!;
      assert.equal(byName("FORGE_AWS_CREDS_FOR_TEST").value, "«redacted»", "the credential's NAME is recorded with a redacted value");
      // AC2: FORGE_AUTH_MODE's NAME is recorded, but its value redacted — not 'mount'.
      assert.equal(byName("FORGE_AUTH_MODE").value, "«redacted»", "FORGE_AUTH_MODE is redacted in meta.json (not allowlisted)");
      // Property: EVERY explicitly reviewed allowlist member reaches the durable record
      // verbatim. Reading the production list above means a newly added safe gate cannot
      // quietly escape this regression coverage.
      for (const [name, value] of Object.entries(allowlistedValues)) {
        assert.equal(byName(name).value, value, `${name} keeps its value in meta.json`);
      }

      // `forge launch show` renders unlisted values redacted, allowlisted gates verbatim.
      const human = forge(home, ["launch", "show", meta.id]);
      assert.equal(human.status, 0, `forge launch show failed: ${human.stderr}`);
      assert.ok(!human.stdout.includes("topsecretvalue"), "launch show never prints the credential material");
      assert.ok(!human.stdout.includes("arbitraryunlistedvalue"), "launch show never prints the arbitrary unlisted value");
      assert.match(human.stdout, /FORGE_AWS_CREDS_FOR_TEST=«redacted»/, "launch show renders the credential value redacted, by name");
      assert.match(human.stdout, /FORGE_AUTH_MODE=«redacted»/, "AC2: launch show renders FORGE_AUTH_MODE redacted, by name");
      assert.match(human.stdout, /FORGE_SOMETHING_UNKNOWN=«redacted»/, "AC3: launch show renders an arbitrary unlisted name redacted, by name");
      for (const [name, value] of Object.entries(allowlistedValues)) {
        assert.ok(human.stdout.includes(`${name}=${value}`), `${name} keeps its value in launch show`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "FG-707/RF-4 CLI: FORGE_CONTROLLER_ID is a lease-fencing identity, not configuration — its VALUE is REDACTED in meta.json and `forge launch show` while the workload still receives the real value",
  { skip: hasTmux ? false : "tmux not available" },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "fg707-controller-id-"));
    const controllerCredential = "controller-lease-credential-abc123";
    try {
      const seen = join(home, "seen-controller-id.txt");
      const probe = `require('fs').writeFileSync(${JSON.stringify(seen)}, process.env.FORGE_CONTROLLER_ID)`;
      const meta = launch(
        home,
        ["--name", "controller", "--", process.execPath, "-e", probe],
        { FORGE_CONTROLLER_ID: controllerCredential },
      );
      await waitFor("the launched workload output", () => existsSync(seen));

      // The workload still receives the REAL controller id — redaction never disarms the gate.
      assert.equal(readFileSync(seen, "utf8"), controllerCredential, "the workload sees the un-redacted controller id");

      // The durable record carries the NAME (the audit shows a controller id WAS forwarded)
      // but not the VALUE — whoever presents it could claim/renew a continuation lease.
      const metaJson = readFileSync(join(home, "launches", meta.id, "meta.json"), "utf8");
      assert.ok(!metaJson.includes(controllerCredential), "no controller-id credential material is written into the durable launch record");
      const recorded = (JSON.parse(metaJson) as Launch).forwardedEnv!.forwarded;
      const controllerId = recorded.find((f) => f.name === "FORGE_CONTROLLER_ID")!;
      assert.equal(controllerId.value, "«redacted»", "FORGE_CONTROLLER_ID's NAME is recorded with a redacted value in meta.json");

      const human = forge(home, ["launch", "show", meta.id]);
      assert.equal(human.status, 0, `forge launch show failed: ${human.stderr}`);
      assert.ok(!human.stdout.includes(controllerCredential), "launch show never prints the controller-id credential material");
      assert.match(human.stdout, /FORGE_CONTROLLER_ID=«redacted»/, "launch show renders FORGE_CONTROLLER_ID redacted, by name");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "FG-626 CLI: --require-control-toolchain preserves both forwarded FORGE_ env and the pinned control-node PATH",
  { skip: hasTmux ? false : "tmux not available" },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "fg626-cli-profile-"));
    try {
      const meta = launch(
        home,
        [
          "--require-control-toolchain",
          "--name",
          "profile",
          "--",
          process.execPath,
          "-e",
          "process.stdout.write('GATE=' + process.env.FORGE_CI_WAIT_TIMEOUT_SECONDS + '\\n')",
        ],
        { FORGE_CI_WAIT_TIMEOUT_SECONDS: "91" },
      );
      await waitFor("the profiled workload output", () => existsSync(meta.logPath) && readFileSync(meta.logPath, "utf8").includes("GATE=91"));
      const output = readFileSync(meta.logPath, "utf8");
      assert.match(output, /GATE=91/, "the forwarded gate survives the same tmux -e channel as the profile");
      const shown = forge(home, ["launch", "show", meta.id, "--json"]);
      assert.equal(shown.status, 0, `profiled launch show failed: ${shown.stderr}`);
      const view = JSON.parse(shown.stdout) as Launch;
      assert.equal(view.workload?.profile?.label, "control-runtime", "the durable workload profile identifies the control-runtime contract");
      // Deliberately do NOT assert the workload-observed PATH: tmux's session-env
      // pin does not reach a respawn-pane workload (FG-706). This FG-626 seam
      // proves that forwarding neither displaces nor duplicates the session pin.
      const sessionPath = spawnSync("tmux", ["show-environment", "-t", meta.tmuxSession, "PATH"], { encoding: "utf8" });
      assert.equal(sessionPath.status, 0, `tmux could not read the launched session PATH: ${sessionPath.stderr}`);
      assert.deepEqual(
        sessionPath.stdout.trim().split("\n"),
        [`PATH=${view.workload!.profile!.path}`],
        "the profile PATH is present exactly once as the final tmux session value after forwarding",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test("FG-626 CLI backward-compat: a pre-forwarding meta.json without forwardedEnv loads and has no broken env audit line", () => {
  const home = mkdtempSync(join(tmpdir(), "fg626-cli-legacy-"));
  try {
    const id = "launch-pre-fg626-abcd";
    const dir = join(home, "launches", id);
    const logPath = join(dir, "out.log");
    mkdirSync(dir, { recursive: true });
    writeFileSync(logPath, "legacy launch\n");
    writeFileSync(join(dir, "meta.json"), JSON.stringify({
      id,
      command: ["true"],
      tmuxSession: `forge-${id}`,
      launcherPid: 4242,
      ownerPid: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      logPath,
      cwd: home,
    }));

    const result = forge(home, ["launch", "show", id]);
    assert.equal(result.status, 0, `legacy launch show failed: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /^env (?:fwd|drop):/m, "a pre-FG-626 record omits the audit block rather than rendering an undefined/broken line");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "FG-626 CLI: an invocation with no FORGE_ variables emits no warning and clearly identifies the empty forwarded set",
  { skip: hasTmux ? false : "tmux not available" },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "fg626-cli-empty-"));
    try {
      const cleanEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
      for (const key of Object.keys(cleanEnv)) if (key.startsWith("FORGE_")) delete cleanEnv[key];
      const result = spawnSync(tsx, [entry, "launch", "run", "--json", "--name", "empty", "--", "true"], { cwd: repoRoot, encoding: "utf8", env: cleanEnv });
      assert.equal(result.status, 0, `env-free launch run failed: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /WARNING.*FORGE_|NOT forwarded into the launched command/, "a command with no FORGE_ invocation variables produces no forwarding warning");
      const meta = JSON.parse(result.stdout) as Launch;
      await waitFor("the env-free launch to exit", () => existsSync(join(home, ".forge", "launches", meta.id, "exit")));

      const show = spawnSync(tsx, [entry, "launch", "show", meta.id], { cwd: repoRoot, encoding: "utf8", env: cleanEnv });
      assert.equal(show.status, 0, `env-free launch show failed: ${show.stderr}`);
      assert.match(show.stdout, /^env fwd:  none \(no FORGE_ variables on the invocation\)$/m, "the absence audit is explicit rather than misleadingly implying a forwarded gate");
      assert.doesNotMatch(show.stdout, /^env drop:/m, "no invocation FORGE_ variables means no drop audit line");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

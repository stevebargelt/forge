// Tests for runtime YAML → docker args translation.
// Uses FORGE_AWS_CREDS_FOR_TEST (creds.ts escape hatch) to avoid real STS calls.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runtime } from "./schema.js";
import { buildDockerArgs, type SpawnContext } from "./spawn.js";

// A browser-tools dir that actually contains the auth injector (#181 pin check).
const BT_DIR_WITH_INJECTOR = mkdtempSync(join(tmpdir(), "forge-bt-"));
writeFileSync(join(BT_DIR_WITH_INJECTOR, "auth-inject.js"), "// stub injector\n");
// A browser-tools dir mounted but WITHOUT the injector (old/upstream checkout).
const BT_DIR_NO_INJECTOR = mkdtempSync(join(tmpdir(), "forge-bt-old-"));

const BASE_RUNTIME: Runtime = {
  name: "claude-bedrock",
  description: "test",
  image: "agent-dev-worker:latest",
  models: { default: "claude-sonnet-4-6", "spec-writer": "claude-sonnet-4-6" },
  auth: { mode: "env-snapshot" },
  env: {
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: "${AWS_REGION:-us-east-1}",
  },
  mounts: [
    { host: "${TASK_DIR}", container: "/task", mode: "rw", optional: false },
    { host: "${PROJECT_DIR}", container: "/project", mode: "${PROJECT_MODE:-rw}", optional: false },
    { host: "${DESIGN_DIR}", container: "/design", mode: "ro", optional: true },
  ],
  invocation: {
    command: "claude",
    args: ["--model", "${MODEL}", "--print"],
  },
  container: { name: "forge-${TASK_ID}", remove_on_exit: true, idle_timeout_seconds: 300 },
  result: { file: "/task/result.json", stdout_log: "container.stdout.log", stderr_log: "container.stderr.log" },
};

const BASE_CTX: SpawnContext = {
  TASK_ID: "task-x",
  TASK_DIR: "/tmp/forge/task-x",
  PROJECT_DIR: "/tmp/project",
  PROJECT_MODE: "rw",
  MODEL: "claude-sonnet-4-6",
  SYSTEM_PROMPT: "system",
  TASK_PACKAGE_MARKDOWN: "# Task task-x\n",
};

let envSnap: Record<string, string | undefined>;

beforeEach(() => {
  envSnap = {
    CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    AWS_PROFILE: process.env.AWS_PROFILE,
    AWS_REGION: process.env.AWS_REGION,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
    FORGE_AWS_DIR: process.env.FORGE_AWS_DIR,
    FORGE_AUTH_MODE: process.env.FORGE_AUTH_MODE,
    FORGE_AWS_CREDS_FOR_TEST: process.env.FORGE_AWS_CREDS_FOR_TEST,
    FORGE_CODEX_DIR: process.env.FORGE_CODEX_DIR,
    FORGE_PI_DIR: process.env.FORGE_PI_DIR,
  };
  for (const k of Object.keys(envSnap)) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(envSnap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function pickMount(args: string[], containerPath: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-v") {
      const parts = args[i + 1]!.split(":");
      if (parts.length >= 2 && parts[1] === containerPath) return args[i + 1];
    }
  }
  return undefined;
}

function pickEnv(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-e") {
      const pair = args[i + 1]!;
      const eq = pair.indexOf("=");
      if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return out;
}

test("buildDockerArgs: container --name is substituted with TASK_ID", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  process.env.AWS_PROFILE = "adx-dev";

  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  const nameIdx = args.indexOf("--name");
  assert.ok(nameIdx >= 0);
  assert.equal(args[nameIdx + 1], "forge-task-x");
});

test("buildDockerArgs: env-snapshot auth injects STS env vars", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=AK,AWS_SECRET_ACCESS_KEY=SK,AWS_SESSION_TOKEN=TK";
  process.env.AWS_PROFILE = "adx-dev";

  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  const env = pickEnv(args);
  assert.equal(env.AWS_ACCESS_KEY_ID, "AK");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, "SK");
  assert.equal(env.AWS_SESSION_TOKEN, "TK");

  // No legacy mount, no AWS_PROFILE
  assert.equal(env.AWS_PROFILE, undefined);
  assert.equal(pickMount(args, "/home/agent/.aws"), undefined);
});

test("buildDockerArgs: FORGE_AUTH_MODE=mount forces legacy mount path", () => {
  process.env.AWS_PROFILE = "adx-dev";
  process.env.FORGE_AWS_DIR = "/Users/test/.aws";
  process.env.FORGE_AUTH_MODE = "mount";

  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  const env = pickEnv(args);
  assert.equal(env.AWS_PROFILE, "adx-dev");
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  const awsMount = pickMount(args, "/home/agent/.aws");
  assert.ok(awsMount);
  assert.match(awsMount!, /:\/home\/agent\/\.aws:ro$/);
});

test("buildDockerArgs: substitutes $\\{AWS_REGION:-us-east-1\\} from runtime.env", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  process.env.AWS_PROFILE = "adx-dev";
  // AWS_REGION unset → fallback to us-east-1.

  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  assert.equal(pickEnv(args).AWS_REGION, "us-east-1");
});

test("buildDockerArgs: AWS_REGION from process.env overrides default", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  process.env.AWS_PROFILE = "adx-dev";
  process.env.AWS_REGION = "ap-northeast-1";

  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  assert.equal(pickEnv(args).AWS_REGION, "ap-northeast-1");
});

test("buildDockerArgs: TASK_DIR mounted at /task", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  process.env.AWS_PROFILE = "adx-dev";

  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  const m = pickMount(args, "/task");
  assert.equal(m, "/tmp/forge/task-x:/task:rw");
});

test("buildDockerArgs: PROJECT_MODE=ro is honored for reds", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  process.env.AWS_PROFILE = "adx-dev";

  const { args } = buildDockerArgs(BASE_RUNTIME, { ...BASE_CTX, PROJECT_MODE: "ro" });
  assert.match(pickMount(args, "/project")!, /:ro$/);
});

test("buildDockerArgs: #245 shadows node_modules with an anonymous volume on macOS rw mounts", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  delete process.env.FORGE_NO_NM_SHADOW;
  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  const hasShadow = args.includes("/project/node_modules");
  if (process.platform === "darwin") {
    assert.ok(hasShadow, "darwin rw mount must shadow /project/node_modules to block grpcfuse write-back");
  } else {
    assert.ok(!hasShadow, "non-darwin hosts have no grpcfuse — no shadow volume");
  }
});

test("buildDockerArgs: #245 never shadows node_modules on ro (red) mounts", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  const { args } = buildDockerArgs(BASE_RUNTIME, { ...BASE_CTX, PROJECT_MODE: "ro" });
  assert.ok(!args.includes("/project/node_modules"), "reds (ro) never write node_modules, so never shadow");
});

test("buildDockerArgs: #245 FORGE_NO_NM_SHADOW=1 disables the node_modules shadow", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  process.env.FORGE_NO_NM_SHADOW = "1";
  try {
    const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
    assert.ok(!args.includes("/project/node_modules"), "escape hatch must disable the shadow volume");
  } finally {
    delete process.env.FORGE_NO_NM_SHADOW;
  }
});

test("buildDockerArgs: working dir is set to the project mount (-w /project), not the ephemeral /workspace WORKDIR", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=AK,AWS_SECRET_ACCESS_KEY=SK,AWS_SESSION_TOKEN=TK";
  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  const wIdx = args.indexOf("-w");
  assert.notEqual(wIdx, -1, "-w flag must be present so cwd-relative writes persist");
  assert.equal(args[wIdx + 1], "/project");
  // Must precede the image (docker flags come before the image positional).
  assert.ok(wIdx < args.indexOf(BASE_RUNTIME.image), "-w must come before the image");
});

test("buildDockerArgs: no -w when the runtime declares no project mount", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=AK,AWS_SECRET_ACCESS_KEY=SK,AWS_SESSION_TOKEN=TK";
  const rt: Runtime = {
    ...BASE_RUNTIME,
    mounts: [{ host: "${TASK_DIR}", container: "/task", mode: "rw", optional: false }],
  };
  const { args } = buildDockerArgs(rt, BASE_CTX);
  assert.equal(args.indexOf("-w"), -1, "without a project mount, fall back to the image WORKDIR");
});

test("buildDockerArgs: optional DESIGN_DIR mount is skipped when unset", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  process.env.AWS_PROFILE = "adx-dev";

  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  assert.equal(pickMount(args, "/design"), undefined);
});

test("buildDockerArgs: claude invocation appended after image with substituted MODEL", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  process.env.AWS_PROFILE = "adx-dev";

  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  const imageIdx = args.indexOf(BASE_RUNTIME.image);
  assert.ok(imageIdx >= 0);
  // claude command comes right after the image
  assert.equal(args[imageIdx + 1], "claude");
  // ${MODEL} substitutes to the context's model id
  assert.ok(args.includes("claude-sonnet-4-6"), `MODEL should substitute; got args: ${args.join(" ")}`);
  // The raw ${MODEL} should NOT survive substitution
  assert.ok(!args.some(a => a.includes("${MODEL}")), "no unresolved template vars after build");
});

test("buildDockerArgs: apikey auth mode passes ANTHROPIC_API_KEY", () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-abc";

  const rt: Runtime = { ...BASE_RUNTIME, auth: { mode: "apikey" } };
  const { args } = buildDockerArgs(rt, BASE_CTX);
  assert.equal(pickEnv(args).ANTHROPIC_API_KEY, "sk-test-abc");
  // No bedrock STS vars
  assert.equal(pickEnv(args).AWS_ACCESS_KEY_ID, undefined);
});

test("buildDockerArgs: apikey auth mode throws when ANTHROPIC_API_KEY is unset", () => {
  const rt: Runtime = { ...BASE_RUNTIME, auth: { mode: "apikey" } };
  assert.throws(() => buildDockerArgs(rt, BASE_CTX), /ANTHROPIC_API_KEY/);
});

// #303: apikey mode injects the RESOLVED upstream provider's key, not always
// anthropic, so pi --provider groq actually receives a Groq credential.
test("buildDockerArgs: apikey injects the upstream provider's key (groq → GROQ_API_KEY)", () => {
  process.env.GROQ_API_KEY = "gsk-test";
  process.env.ANTHROPIC_API_KEY = "sk-anthropic"; // must NOT be the one injected
  const rt: Runtime = { ...BASE_RUNTIME, auth: { mode: "apikey" } };
  const env = pickEnv(buildDockerArgs(rt, { ...BASE_CTX, UPSTREAM_PROVIDER: "groq" }).args);
  assert.equal(env.GROQ_API_KEY, "gsk-test");
  assert.equal(env.ANTHROPIC_API_KEY, undefined); // the wrong key is not leaked in
});

test("buildDockerArgs: apikey + groq throws when GROQ_API_KEY is unset (fail loud, names the var)", () => {
  const rt: Runtime = { ...BASE_RUNTIME, auth: { mode: "apikey" } };
  assert.throws(() => buildDockerArgs(rt, { ...BASE_CTX, UPSTREAM_PROVIDER: "groq" }), /GROQ_API_KEY/);
});

test("buildDockerArgs: apikey with an unknown upstream provider fails loud", () => {
  const rt: Runtime = { ...BASE_RUNTIME, auth: { mode: "apikey" } };
  assert.throws(
    () => buildDockerArgs(rt, { ...BASE_CTX, UPSTREAM_PROVIDER: "nope-vendor" }),
    /no API-key binding for upstream provider 'nope-vendor'/,
  );
});

// #303 invariant: openai api-key (codex-apikey) is the deferred mode and is NOT
// in the api-key map, so apikey injection must fail loud rather than inject a
// key the provider-doctor can't probe (doctor-invisible + injectable divergence).
test("buildDockerArgs: apikey with openai fails loud — codex-apikey is deferred, not in the shared map", () => {
  process.env.OPENAI_API_KEY = "sk-openai"; // present, but still must not inject
  const rt: Runtime = { ...BASE_RUNTIME, auth: { mode: "apikey" } };
  assert.throws(
    () => buildDockerArgs(rt, { ...BASE_CTX, UPSTREAM_PROVIDER: "openai" }),
    /no API-key binding for upstream provider 'openai'/,
  );
});

test("buildDockerArgs: codex-auth RO-mounts only ~/.codex/auth.json (not the dir)", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-codex-spawn-"));
  process.env.FORGE_CODEX_DIR = dir;
  writeFileSync(join(dir, "auth.json"), '{"mode":"chatgpt"}');

  const rt: Runtime = { ...BASE_RUNTIME, auth: { mode: "codex-auth" } };
  const { args } = buildDockerArgs(rt, BASE_CTX);
  const mount = pickMount(args, "/forge-codex-auth/auth.json");
  assert.equal(mount, `${join(dir, "auth.json")}:/forge-codex-auth/auth.json:ro`);
  // No AWS/anthropic credential injected on the codex path.
  assert.equal(pickEnv(args).AWS_ACCESS_KEY_ID, undefined);
  assert.equal(pickEnv(args).ANTHROPIC_API_KEY, undefined);
});

test("buildDockerArgs: codex-auth throws when ~/.codex/auth.json is missing (no phantom-dir mount)", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-codex-empty-"));
  process.env.FORGE_CODEX_DIR = dir; // exists but no auth.json inside
  const rt: Runtime = { ...BASE_RUNTIME, auth: { mode: "codex-auth" } };
  assert.throws(() => buildDockerArgs(rt, BASE_CTX), /codex login/);
});

test("buildDockerArgs: warns (not silent) when an optional browser-tools skill mount is skipped", () => {
  // apikey auth keeps this off the AWS creds path; the mount loop is auth-agnostic.
  process.env.ANTHROPIC_API_KEY = "sk-test-mount";
  const rt: Runtime = {
    ...BASE_RUNTIME,
    auth: { mode: "apikey" },
    mounts: [
      ...BASE_RUNTIME.mounts, // includes the optional /design mount (skipped here, non-skill → no warn)
      {
        host: "/definitely/not/here/browser-tools",
        container: "/home/agent/.claude/skills/browser-tools",
        mode: "ro",
        optional: true,
      },
    ],
  };
  const warnings: string[] = [];
  const orig = console.error;
  console.error = (msg?: unknown) => { warnings.push(String(msg)); };
  let args: string[];
  try {
    args = buildDockerArgs(rt, BASE_CTX).args;
  } finally {
    console.error = orig;
  }

  // The skill mount must NOT be added (host missing) ...
  assert.ok(!args.some((a) => a.includes("/home/agent/.claude/skills/browser-tools")));
  // ... but it must warn loudly, naming the skill and the visual-verification consequence.
  const warn = warnings.find((w) => w.includes("browser-tools"));
  assert.ok(warn, `expected a browser-tools skip warning, got: ${JSON.stringify(warnings)}`);
  assert.match(warn, /skill mount 'browser-tools' skipped/);
  assert.match(warn, /no visual UI verification/);
  // A skipped optional *non-skill* mount (/design) stays silent.
  assert.ok(!warnings.some((w) => w.includes("/design")), "non-skill mount should not warn");
});

// #176 auth profiles — a runtime that actually mounts browser-tools (the
// injector). Non-optional so it's added regardless of host existence on disk.
const RUNTIME_WITH_BROWSER_TOOLS: Runtime = {
  ...BASE_RUNTIME,
  auth: { mode: "apikey" },
  mounts: [
    ...BASE_RUNTIME.mounts,
    { host: BT_DIR_WITH_INJECTOR, container: "/home/agent/.claude/skills/browser-tools", mode: "ro", optional: false },
  ],
};

test("buildDockerArgs: AUTH_STATE_HOST_PATH mounts the session ro and sets BROWSER_TOOLS_STORAGE_STATE", () => {
  process.env.ANTHROPIC_API_KEY = "sk-auth";
  const ctx: SpawnContext = { ...BASE_CTX, AUTH_STATE_HOST_PATH: "/home/u/.forge/auth/qa-admin.storage.json" };

  const { args } = buildDockerArgs(RUNTIME_WITH_BROWSER_TOOLS, ctx);
  const mount = pickMount(args, "/forge-auth/state.json");
  assert.equal(mount, "/home/u/.forge/auth/qa-admin.storage.json:/forge-auth/state.json:ro");
  assert.equal(pickEnv(args).BROWSER_TOOLS_STORAGE_STATE, "/forge-auth/state.json");
});

test("buildDockerArgs: no auth mount/env when AUTH_STATE_HOST_PATH is unset", () => {
  process.env.ANTHROPIC_API_KEY = "sk-auth";
  const { args } = buildDockerArgs(RUNTIME_WITH_BROWSER_TOOLS, BASE_CTX);
  assert.equal(pickMount(args, "/forge-auth/state.json"), undefined);
  assert.equal(pickEnv(args).BROWSER_TOOLS_STORAGE_STATE, undefined);
});

test("buildDockerArgs: AUTH_STATE_HOST_PATH throws when browser-tools is not mounted", () => {
  process.env.ANTHROPIC_API_KEY = "sk-auth";
  // BASE_RUNTIME has no browser-tools mount → the injector would be absent.
  const rt: Runtime = { ...BASE_RUNTIME, auth: { mode: "apikey" } };
  const ctx: SpawnContext = { ...BASE_CTX, AUTH_STATE_HOST_PATH: "/home/u/.forge/auth/qa-admin.storage.json" };
  assert.throws(() => buildDockerArgs(rt, ctx), /browser-tools/);
});

test("buildDockerArgs: AUTH_STATE_HOST_PATH throws when browser-tools lacks the injector (#181 pin)", () => {
  process.env.ANTHROPIC_API_KEY = "sk-auth";
  // browser-tools IS mounted, but it's an old/upstream checkout with no auth-inject.js.
  const rt: Runtime = {
    ...BASE_RUNTIME,
    auth: { mode: "apikey" },
    mounts: [
      ...BASE_RUNTIME.mounts,
      { host: BT_DIR_NO_INJECTOR, container: "/home/agent/.claude/skills/browser-tools", mode: "ro", optional: false },
    ],
  };
  const ctx: SpawnContext = { ...BASE_CTX, AUTH_STATE_HOST_PATH: "/home/u/.forge/auth/qa-admin.storage.json" };
  assert.throws(() => buildDockerArgs(rt, ctx), /auth-inject\.js/);
});

// ── #261: pi-apikey runtime dispatch wiring ──────────────────────────────────
// Build docker args from the REAL pi-apikey seed and assert the pi command shape.
// Deterministic, no container/network — proves spawn can invoke pi.

import { readFileSync as _readFileSync } from "node:fs";
import { dirname as _dirname, join as _join } from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { parse as _parseYaml } from "yaml";
import { RuntimeSchema as _RuntimeSchema } from "./schema.js";

function loadPiSeed(): Runtime {
  const here = _dirname(_fileURLToPath(import.meta.url));
  const seed = _join(here, "..", "..", "seeds", "runtimes", "pi-apikey.yml");
  return _RuntimeSchema.parse(_parseYaml(_readFileSync(seed, "utf8")));
}

// Find the index of the runtime command in the assembled docker args (it follows
// the image name).
function argsAfterImage(args: string[], image: string): string[] {
  const i = args.indexOf(image);
  return i >= 0 ? args.slice(i + 1) : [];
}

test("#261: buildDockerArgs runs pi with -p --mode json and substitutes prompt + model", () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-key"; // auth.mode=apikey requires it
  const rt = loadPiSeed();
  const { args, stdin } = buildDockerArgs(rt, {
    ...BASE_CTX,
    SYSTEM_PROMPT: "SYS-PROMPT",
    TASK_PACKAGE_MARKDOWN: "PKG-MD",
  });
  const cmd = argsAfterImage(args, "agent-dev-worker:latest");
  assert.equal(cmd[0], "pi", "command is pi");
  assert.ok(cmd.includes("-p"), "non-interactive -p");
  assert.deepEqual(cmd.slice(cmd.indexOf("--mode"), cmd.indexOf("--mode") + 2), ["--mode", "json"]);
  assert.ok(cmd.includes("--no-context-files"));
  assert.deepEqual(cmd.slice(cmd.indexOf("--provider"), cmd.indexOf("--provider") + 2), ["--provider", "anthropic"]);
  assert.deepEqual(cmd.slice(cmd.indexOf("--model"), cmd.indexOf("--model") + 2), ["--model", "claude-sonnet-4-6"]);
  // system prompt via flag; task package as the trailing positional message.
  assert.deepEqual(cmd.slice(cmd.indexOf("--append-system-prompt"), cmd.indexOf("--append-system-prompt") + 2), ["--append-system-prompt", "SYS-PROMPT"]);
  assert.equal(cmd[cmd.length - 1], "PKG-MD", "task package is the positional message arg");
  assert.equal(stdin, undefined, "pi reads the prompt from args, not stdin");
});

test("#261: pi-apikey injects ANTHROPIC_API_KEY and FORGE_NO_BROWSER", () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-key";
  const { args } = buildDockerArgs(loadPiSeed(), BASE_CTX);
  const env = pickEnv(args);
  assert.equal(env.ANTHROPIC_API_KEY, "sk-test-key");
  assert.equal(env.FORGE_NO_BROWSER, "1", "skip Chromium startup — pi has no browser-tools");
});

test("#261: pi-apikey fails fast when ANTHROPIC_API_KEY is unset", () => {
  delete process.env.ANTHROPIC_API_KEY;
  assert.throws(() => buildDockerArgs(loadPiSeed(), BASE_CTX), /ANTHROPIC_API_KEY/);
});

// ── #263: pi prompt strategy delivers forge context exactly once ─────────────
// Forge-side guarantee at the docker-command level (the pi-side behavioral proof
// — that --no-context-files actually suppresses project CLAUDE.md loading — is
// scripts/pi-context-proof.sh, which inspects pi's real outbound request).

test("#263: pi command delivers the system prompt and task package exactly once each", () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-key";
  const { args, stdin } = buildDockerArgs(loadPiSeed(), {
    ...BASE_CTX,
    SYSTEM_PROMPT: "SEED-AND-CONSTRAINTS",
    TASK_PACKAGE_MARKDOWN: "TASK-PACKAGE",
  });
  const cmd = argsAfterImage(args, "agent-dev-worker:latest");
  // seed+constraints: exactly one --append-system-prompt, carrying it once.
  assert.equal(cmd.filter((a) => a === "--append-system-prompt").length, 1);
  assert.equal(cmd.filter((a) => a === "SEED-AND-CONSTRAINTS").length, 1);
  // task package: exactly one occurrence (the positional message).
  assert.equal(cmd.filter((a) => a === "TASK-PACKAGE").length, 1);
  // --no-context-files present so pi doesn't ALSO auto-load /project context.
  assert.ok(cmd.includes("--no-context-files"));
  // single delivery channel: nothing on stdin to duplicate it.
  assert.equal(stdin, undefined);
});

test("#263: red read-only project mount is still enforced for the pi runtime", () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-key";
  const { args } = buildDockerArgs(loadPiSeed(), { ...BASE_CTX, PROJECT_MODE: "ro" });
  assert.equal(pickMount(args, "/project"), `${BASE_CTX.PROJECT_DIR}:/project:ro`);
});

// ── #266: pi-oauth runtime — pi-auth credential mount ────────────────────────
function loadPiOauthSeed(): Runtime {
  const here = _dirname(_fileURLToPath(import.meta.url));
  const seed = _join(here, "..", "..", "seeds", "runtimes", "pi-oauth.yml");
  return _RuntimeSchema.parse(_parseYaml(_readFileSync(seed, "utf8")));
}

test("#266: pi-auth RO-mounts the host pi auth.json and sets PI_CODING_AGENT_DIR", () => {
  const piDir = mkdtempSync(join(tmpdir(), "forge-pi-"));
  writeFileSync(join(piDir, "auth.json"), '{"providers":{}}');
  process.env.FORGE_PI_DIR = piDir;
  const { args } = buildDockerArgs(loadPiOauthSeed(), BASE_CTX);
  // the credential is mounted read-only at the fixed container path
  const mount = pickMount(args, "/forge-pi-auth/auth.json");
  assert.equal(mount, `${join(piDir, "auth.json")}:/forge-pi-auth/auth.json:ro`);
  // pi reads/refreshes its token from PI_CODING_AGENT_DIR (entrypoint copies there)
  assert.equal(pickEnv(args).PI_CODING_AGENT_DIR, "/tmp/pi-agent");
});

test("#266: pi-auth fails loud when the host credential is missing (run forge pi login)", () => {
  process.env.FORGE_PI_DIR = mkdtempSync(join(tmpdir(), "forge-pi-empty-")); // no auth.json
  assert.throws(() => buildDockerArgs(loadPiOauthSeed(), BASE_CTX), /auth\.mode=pi-auth.*missing.*forge pi login/s);
});

test("#266: pi-oauth invocation carries no --api-key (auth comes from auth.json)", () => {
  const piDir = mkdtempSync(join(tmpdir(), "forge-pi-nokey-"));
  writeFileSync(join(piDir, "auth.json"), '{"providers":{}}');
  process.env.FORGE_PI_DIR = piDir;
  const { args } = buildDockerArgs(loadPiOauthSeed(), BASE_CTX);
  const cmd = argsAfterImage(args, "agent-dev-worker:latest");
  assert.equal(cmd[0], "pi");
  assert.ok(!cmd.includes("--api-key"), "OAuth runtime must not pass --api-key");
});

// ── #265: pi runtime receives the resolved upstream provider via ${UPSTREAM_PROVIDER} ──

const PI_RUNTIME: Runtime = {
  name: "pi-apikey",
  description: "test pi",
  image: "agent-dev-worker:latest",
  runtime_kind: "pi",
  log_format: "pi-jsonl",
  models: { default: "claude-sonnet-4-6" },
  auth: { mode: "oauth-volume" },
  env: {},
  mounts: [{ host: "${TASK_DIR}", container: "/task", mode: "rw", optional: false }],
  invocation: {
    command: "pi",
    args: ["-p", "--provider", "${UPSTREAM_PROVIDER:-anthropic}", "--model", "${MODEL}"],
  },
  container: { name: "forge-${TASK_ID}", remove_on_exit: true, idle_timeout_seconds: 300 },
  result: { file: "/task/result.json", stdout_log: "container.stdout.log", stderr_log: "container.stderr.log" },
};

function pickProvider(args: string[]): string | undefined {
  const i = args.indexOf("--provider");
  return i >= 0 ? args[i + 1] : undefined;
}

test("#265: resolved upstream provider is substituted into pi's --provider", () => {
  const { args } = buildDockerArgs(PI_RUNTIME, { ...BASE_CTX, UPSTREAM_PROVIDER: "groq" });
  assert.equal(pickProvider(args), "groq");
});

test("#265: empty/legacy UPSTREAM_PROVIDER falls back to anthropic (no #261 regression)", () => {
  const emptyArgs = buildDockerArgs(PI_RUNTIME, { ...BASE_CTX, UPSTREAM_PROVIDER: "" }).args;
  assert.equal(pickProvider(emptyArgs), "anthropic");
  const unsetArgs = buildDockerArgs(PI_RUNTIME, BASE_CTX).args; // field absent entirely
  assert.equal(pickProvider(unsetArgs), "anthropic");
});

// ── regression: agent containers isolate from host project settings via --setting-sources ──
// spawn.ts appends `--setting-sources ""` for claude-code runtimes so that the
// agent container does NOT auto-discover <cwd>/.claude/settings*.json from the
// bind-mounted project dir. Without this, the orchestrator's own
// settings.local.json would flip CLAUDE_CODE_USE_BEDROCK=0, swap the model to a
// non-Bedrock id, and crash on host-only hook paths inside the agent.
// The flag is gated on runtimeKind==="claude-code" — codex/pi CLIs reject it.

test("regression: agent containers isolate from host project settings via --setting-sources", () => {
  // Part A: claude-code runtime (BASE_RUNTIME defaults to claude-code via invocation.command="claude")
  // must include --setting-sources immediately followed by "" (empty string).
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  process.env.AWS_PROFILE = "adx-dev";

  const { args: claudeArgs } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  const ssIdx = claudeArgs.indexOf("--setting-sources");
  assert.notEqual(ssIdx, -1, "claude-code runtime must have --setting-sources in args");
  assert.equal(claudeArgs[ssIdx + 1], "", `--setting-sources must be followed by "" (empty string), got: ${JSON.stringify(claudeArgs[ssIdx + 1])}`);

  // Part B: non-claude-code runtime (PI_RUNTIME, runtime_kind="pi") must NOT
  // have --setting-sources — pi CLI does not accept it.
  const { args: piArgs } = buildDockerArgs(PI_RUNTIME, BASE_CTX);
  assert.equal(piArgs.indexOf("--setting-sources"), -1, "non-claude-code runtime (pi) must not have --setting-sources");
});

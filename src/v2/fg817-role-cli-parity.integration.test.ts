// FG-817 verification: the dashboard's role projection must agree with the public
// Forge readers, rather than merely agreeing with a second dashboard-local fixture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "../raci/governance.js";
import { publishTestGeneration } from "./seed-generation.testkit.js";
import { routesNamingRole } from "./role-surface.js";
import { REQUIRED_DASHBOARD_FILES } from "./release.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function forge(home: string, args: string[]): unknown {
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], {
    cwd: ROOT,
    env: { ...process.env, FORGE_HOME: home },
    encoding: "utf8",
  }));
}

test("FG-817: each role route on the page is the real forge route explain policy result", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-fg817-cli-routes-"));
  const gen = publishTestGeneration(home, {
    assetsParent: home,
    raciPath: join(ROOT, "seeds", "forge-raci.md"),
    runtimes: { "claude-oauth": readFileSync(join(ROOT, "seeds", "runtimes", "claude-oauth.yml"), "utf8") },
  });
  for (const role of ["engineer", "red-wide", "test-engineer"]) {
    mkdirSync(join(home, "agents", role), { recursive: true });
    writeFileSync(join(home, "agents", role, "CLAUDE.md"), `# ${role}\n\nSeed.\n`);
  }
  const policy = loadPolicy(join(gen.root, "routing-policy.yml"));
  for (const role of ["engineer", "red-wide", "test-engineer"]) {
    const dashboard = routesNamingRole(policy, role).sort((a, b) => a.route.localeCompare(b.route));
    const explained = dashboard.map(({ route }) => {
      const result = forge(home, ["route", "explain", route, "--json"]) as { ok: true; route: { path: string; responsible: string; consulted: string[]; required_followups: string[] } };
      assert.equal(result.ok, true, `forge route explain ${route} succeeds`);
      const r = result.route;
      const relations = [
        ...(r.responsible === role ? ["responsible"] : []),
        ...(r.consulted.includes(role) ? ["consulted"] : []),
        ...(r.required_followups.includes(role) ? ["followup"] : []),
      ];
      return { route, path: r.path, relations };
    }).sort((a, b) => a.route.localeCompare(b.route));
    assert.deepEqual(dashboard, explained, `${role}'s overview is exactly forge route explain over the published policy`);
  }
});

test("FG-817: the promoted dashboard closure includes every Roles server and client module", () => {
  const rolesModules = [
    "dashboard/src/roles.ts",
    "dashboard/client/roles-index-render.js",
    "dashboard/client/roles-index-view.js",
    "dashboard/client/role-page-render.js",
    "dashboard/client/role-page-view.js",
  ] as const;
  for (const module of rolesModules) assert.ok(REQUIRED_DASHBOARD_FILES.includes(module), `${module} is release-required`);
  assert.equal(new Set(REQUIRED_DASHBOARD_FILES).size, REQUIRED_DASHBOARD_FILES.length, "the release closure has no duplicate entries");
});

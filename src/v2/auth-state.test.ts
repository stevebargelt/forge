import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAuthStateForContainer, AuthProfileError, roleUsesBrowser } from "./auth-state.js";
import { writeProfile, profilePath } from "../util/auth-profiles.js";

function supabaseValue(expiresAt: number): string {
  return JSON.stringify({ access_token: "h.p.s", expires_at: expiresAt, refresh_token: "r" });
}
const future = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 1;

test("roleUsesBrowser: browser roles yes, planning/red roles no", () => {
  for (const r of ["engineer", "frontend-specialist", "test-engineer", "manual-qa"]) {
    assert.equal(roleUsesBrowser(r), true, r);
  }
  for (const r of ["architecture-advisor", "tech-lead", "backend-specialist", "red-frontend", "research-specialist"]) {
    assert.equal(roleUsesBrowser(r), false, r);
  }
});

test("resolveAuthStateForContainer throws on missing profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-as-"));
  assert.throws(() => resolveAuthStateForContainer("ghost", dir), AuthProfileError);
  assert.throws(() => resolveAuthStateForContainer("ghost", dir), /not found/);
});

test("resolveAuthStateForContainer throws on expired profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-as-"));
  delete process.env.FORGE_CONTAINER_HOST;
  writeProfile("stale", {
    cookies: [],
    origins: [{ origin: "https://app.test", localStorage: [{ name: "t", value: supabaseValue(past()) }] }],
  });
  assert.throws(() => resolveAuthStateForContainer("stale", dir), /expired/);
});

test("resolveAuthStateForContainer stages a reconciled mode-600 copy for localhost origins", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-as-"));
  delete process.env.FORGE_CONTAINER_HOST;
  writeProfile("loc", {
    cookies: [],
    origins: [{ origin: "http://localhost:3000", localStorage: [{ name: "t", value: supabaseValue(future()) }] }],
  });
  const staged = resolveAuthStateForContainer("loc", dir);
  assert.equal(staged.reconciled, true);
  assert.equal(staged.hostPath, join(dir, "auth-state.json"));
  assert.deepEqual(staged.origins, ["http://host.docker.internal:3000"]);
  assert.equal(statSync(staged.hostPath).mode & 0o777, 0o600);
  const written = JSON.parse(readFileSync(staged.hostPath, "utf8"));
  assert.equal(written.origins[0].origin, "http://host.docker.internal:3000");
});

test("resolveAuthStateForContainer mounts the original (no copy) for real-DNS origins", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-as-"));
  delete process.env.FORGE_CONTAINER_HOST;
  writeProfile("prod", {
    cookies: [],
    origins: [{ origin: "https://staging.example.com", localStorage: [{ name: "t", value: supabaseValue(future()) }] }],
  });
  const staged = resolveAuthStateForContainer("prod", dir);
  assert.equal(staged.reconciled, false);
  assert.equal(staged.hostPath, profilePath("prod"));
  assert.deepEqual(staged.origins, ["https://staging.example.com"]);
});

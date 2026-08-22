// FG-349 [C] / FG-401: buildConfigGraphCapabilities. The four required cases —
// a ready provider, missing auth, an unsupported capability, a deferred
// prerequisite — plus the host-observed/inferred seam, redaction, and the
// no-subprocess guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-cgcap-home-"));
process.env.FORGE_HOME = tmpHome;
// Plant a ready provider and ensure a second known provider is missing auth.
const SECRET = "sk-ant-PLANTEDSECRETVALUE-0000";
process.env.ANTHROPIC_API_KEY = SECRET;
delete process.env.GROQ_API_KEY;

const { buildConfigGraphCapabilities } = await import("./config-graph-capabilities.js");
const { redactSecrets } = await import("./host-readiness.js");

const build = () => buildConfigGraphCapabilities({ projectDir: "/tmp", forgeHome: tmpHome });

test("a ready provider with auth present → available / detected (host-observed)", () => {
  const anthropic = build().providers.find((p) => p.provider === "anthropic")!;
  assert.equal(anthropic.readiness, "available");
  assert.equal(anthropic.provenance, "detected");
  assert.equal(anthropic.observedBy, "host-observed");
});

test("missing auth → unavailable with a reason, and NEVER the env value", () => {
  const caps = build();
  const groq = caps.providers.find((p) => p.provider === "groq")!;
  assert.equal(groq.readiness, "unavailable");
  assert.equal(groq.provenance, "unavailable");
  assert.match(groq.detail, /GROQ_API_KEY/);
  // no row anywhere leaks the planted secret value
  const allStrings = JSON.stringify(caps);
  assert.equal(allStrings.includes(SECRET), false, "the planted API key value must not appear anywhere");
});

test("an unsupported capability projects to unavailable, carrying the limitation verbatim", () => {
  const caps = build();
  const unsupported = caps.capabilities.find((c) => c.support === "unsupported");
  assert.ok(unsupported, "the matrix contains at least one unsupported cell");
  assert.equal(unsupported!.provenance, "unavailable");
  assert.ok((unsupported!.limitation ?? "").length > 0, "an unsupported cell carries a limitation");
  // native cell carried verbatim
  const nativeLimit = (unsupported!.native as { limitation?: string }).limitation;
  assert.equal(unsupported!.limitation, redactSecrets(nativeLimit ?? ""));
});

test("capability facts are labeled inferred (container-side), not witnessed", () => {
  const caps = build();
  assert.ok(caps.capabilities.length > 0);
  for (const c of caps.capabilities) assert.equal(c.observedBy, "inferred");
});

test("Shipping Reviewer and Campaign Runner have explicit readiness + reason", () => {
  const { prerequisites } = build();
  const sr = prerequisites.find((p) => p.name === "Shipping Reviewer")!;
  const cr = prerequisites.find((p) => p.name === "Campaign Runner")!;
  assert.ok(["available", "unavailable", "deferred", "unknown"].includes(sr.readiness));
  assert.ok(sr.reason.length > 0);
  // Campaign Runner requires a container probe we don't run here → deferred, inferred.
  assert.equal(cr.readiness, "deferred");
  assert.equal(cr.observedBy, "inferred");
  assert.match(cr.reason, /probe|inferred|witnessed/i);
});

test("every surfaced capability string is redaction-clean", () => {
  const caps = build();
  const strings: string[] = [];
  for (const p of caps.providers) strings.push(p.detail, p.provider, p.mode);
  for (const c of caps.capabilities) strings.push(c.title, c.capability, c.adapter, c.support, c.limitation ?? "");
  for (const pr of caps.prerequisites) strings.push(pr.name, pr.reason);
  for (const s of strings) assert.equal(redactSecrets(s), s, `unredacted: ${s}`);
});

test("the capabilities module invokes no docker/git/model subprocess (static guard)", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "config-graph-capabilities.ts"), "utf8");
  for (const forbidden of ["child_process", "execSync", "spawnSync", "spawn(", "dockerode", "simple-git"]) {
    assert.equal(src.includes(forbidden), false, `capabilities module must not reference ${forbidden}`);
  }
});

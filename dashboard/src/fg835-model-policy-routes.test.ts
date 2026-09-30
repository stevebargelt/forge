// FG-835 — the pure half of the model-policy routes: the body shape (project or host
// target), the named apply refusals, the argv builder and the backups listing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_CONFIRM_KEY,
  MAX_POLICY_CANDIDATE_BYTES,
  MODEL_POLICY_PATH,
  buildModelPolicyArgv,
  confirmKeyFor,
  listPolicyBackups,
  parseModelPolicyRequest,
  policyApplyRefusal,
  type ModelPolicyRequest,
} from "./model-policy-mutation.js";
import { MAX_RATIONALE_CHARS, PROPOSAL_WINDOW_MS, ProposalWindow, sha256Hex } from "./raci-mutation.js";
import { isRefusal } from "./mutation-guards.js";
import { ACTION_FORGE_VERBS, ACTION_ROUTES, isActionMutationPath } from "./action-mutation.js";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const YAML = "schema_version: 2\n";

test("MODEL_POLICY_PATH: exactly propose and apply; the registry rows shell the one `model` verb", () => {
  assert.ok(MODEL_POLICY_PATH.test("/api/model-policy/propose"));
  assert.ok(MODEL_POLICY_PATH.test("/api/model-policy/apply"));
  for (const path of ["/api/model-policy", "/api/model-policy/apply/force", "/api/model-policy/allow-undispatchable", "/api/model-policy/migrate"]) {
    assert.equal(MODEL_POLICY_PATH.test(path), false, path);
    assert.equal(isActionMutationPath(path), false, path);
  }
  assert.deepEqual(ACTION_ROUTES["model-policy-propose"], { path: "/api/model-policy/propose", verb: "model" });
  assert.deepEqual(ACTION_ROUTES["model-policy-apply"], { path: "/api/model-policy/apply", verb: "model" });
  assert.ok((ACTION_FORGE_VERBS as readonly string[]).includes("model"));
});

test("parseModelPolicyRequest: a project target or target: \"host\", never both; unknown fields (force, allowUndispatchable) refused", () => {
  const project = parseModelPolicyRequest("model-policy-propose", { projectKey: "k", candidate: YAML });
  assert.ok(!isRefusal(project));
  if (!isRefusal(project)) {
    assert.deepEqual(project.target, { kind: "project", projectKey: "k", projectDir: undefined });
    assert.equal(project.candidateSha256, sha256Hex(YAML));
  }
  const host = parseModelPolicyRequest("model-policy-propose", { target: "host", candidate: YAML });
  assert.ok(!isRefusal(host) && host.target.kind === "host");

  for (const body of [
    { projectKey: "k", candidate: YAML, force: true },
    { projectKey: "k", candidate: YAML, allowUndispatchable: true },
    { projectKey: "k", candidate: YAML, "--allow-undispatchable": true },
    { projectKey: "k", candidate: YAML, rationale: "r" },
    { target: "host", projectKey: "k", candidate: YAML },
    { target: "host", projectDir: "/x", candidate: YAML },
    { target: "project", candidate: YAML },
    { target: "/etc/model-policy.yml", candidate: YAML },
  ]) {
    const out = parseModelPolicyRequest("model-policy-propose", body);
    assert.ok(isRefusal(out) && out.status === 400, JSON.stringify(body));
  }
  for (const body of [null, [], "x", {}, { projectKey: "k" }, { candidate: YAML }, { projectKey: " ", candidate: YAML }, { projectKey: "k", candidate: "  " }, { target: "host", candidate: 5 }]) {
    assert.ok(isRefusal(parseModelPolicyRequest("model-policy-propose", body)), JSON.stringify(body));
  }
  const apply = parseModelPolicyRequest("model-policy-apply", { target: "host", candidate: YAML, proposedSha256: "s", confirmKey: "host", rationale: "why" });
  assert.ok(!isRefusal(apply));
  assert.ok(isRefusal(parseModelPolicyRequest("model-policy-apply", { target: "host", candidate: YAML, rationale: 7 })));
});

test("parseModelPolicyRequest: the candidate is bounded at MAX_POLICY_CANDIDATE_BYTES (bytes, not characters)", () => {
  assert.ok(!isRefusal(parseModelPolicyRequest("model-policy-propose", { target: "host", candidate: "a".repeat(MAX_POLICY_CANDIDATE_BYTES) })));
  const over = parseModelPolicyRequest("model-policy-propose", { target: "host", candidate: "a".repeat(MAX_POLICY_CANDIDATE_BYTES + 1) });
  assert.ok(isRefusal(over) && over.status === 413);
  const multibyte = parseModelPolicyRequest("model-policy-propose", { target: "host", candidate: "é".repeat(MAX_POLICY_CANDIDATE_BYTES / 2 + 1) });
  assert.ok(isRefusal(multibyte) && multibyte.status === 413);
});

function request(over: Partial<ModelPolicyRequest> = {}): ModelPolicyRequest {
  return {
    target: { kind: "project", projectKey: "github.com/o/r", projectDir: undefined },
    candidate: YAML,
    candidateSha256: sha256Hex(YAML),
    proposedSha256: sha256Hex(YAML),
    confirmKey: "github.com/o/r",
    rationale: "move reviews to sonnet",
    ...over,
  };
}

test("confirmKeyFor: the project key, or the literal host", () => {
  assert.equal(confirmKeyFor({ kind: "host" }), HOST_CONFIRM_KEY);
  assert.equal(HOST_CONFIRM_KEY, "host");
  assert.equal(confirmKeyFor({ kind: "project", projectKey: "k", projectDir: undefined }), "k");
});

test("policyApplyRefusal: the named refusals, and null when every precondition holds", () => {
  const w = new ProposalWindow();
  const scope = "github.com/o/r\n/dir";
  assert.equal(policyApplyRefusal(request(), scope, w, T0)?.refusal, "candidate_not_proposed");
  w.record(scope, sha256Hex(YAML), T0);
  assert.equal(policyApplyRefusal(request(), scope, w, T0), null);
  assert.equal(policyApplyRefusal(request(), "host", w, T0)?.refusal, "candidate_not_proposed", "a project propose never admits a host apply");
  assert.equal(policyApplyRefusal(request(), scope, w, T0 + PROPOSAL_WINDOW_MS + 1)?.refusal, "candidate_not_proposed");
  assert.equal(policyApplyRefusal(request({ proposedSha256: sha256Hex("other") }), scope, w, T0)?.refusal, "candidate_changed");
  assert.equal(policyApplyRefusal(request({ proposedSha256: undefined }), scope, w, T0)?.refusal, "candidate_changed");
  for (const confirmKey of [undefined, "", "host", "github.com/o/R"]) {
    assert.equal(policyApplyRefusal(request({ confirmKey }), scope, w, T0)?.refusal, "confirm_key_mismatch", String(confirmKey));
  }
  for (const rationale of [undefined, "", "  \n"]) {
    assert.equal(policyApplyRefusal(request({ rationale }), scope, w, T0)?.refusal, "rationale_required");
  }
  for (const rationale of ["-x", "--allow-undispatchable", "  --force", "a".repeat(MAX_RATIONALE_CHARS + 1)]) {
    assert.equal(policyApplyRefusal(request({ rationale }), scope, w, T0)?.refusal, "rationale_invalid", rationale.slice(0, 20));
  }

  const hostReq = request({ target: { kind: "host" }, confirmKey: "host" });
  assert.equal(policyApplyRefusal(hostReq, "host", w, T0)?.refusal, "candidate_not_proposed");
  w.record("host", sha256Hex(YAML), T0);
  assert.equal(policyApplyRefusal(hostReq, "host", w, T0), null);
  assert.equal(policyApplyRefusal({ ...hostReq, confirmKey: "github.com/o/r" }, "host", w, T0)?.refusal, "confirm_key_mismatch");
});

test("buildModelPolicyArgv: fixed argv — the scratch path, the registry checkout (project only), never --force or --allow-undispatchable", () => {
  const scratch = "/home/f/.forge/dashboard/model-policy-candidates/c-1/model-policy.yml";
  const propose = buildModelPolicyArgv("model-policy-propose", scratch, "/src/repo", "dashboard");
  assert.ok(!isRefusal(propose));
  if (!isRefusal(propose)) assert.deepEqual(propose.argv, ["model", "policy", "propose", scratch, "--project", "/src/repo", "--json"]);
  const hostPropose = buildModelPolicyArgv("model-policy-propose", scratch, undefined, "dashboard");
  assert.ok(!isRefusal(hostPropose));
  if (!isRefusal(hostPropose)) assert.deepEqual(hostPropose.argv, ["model", "policy", "propose", scratch, "--json"], "the host target has no --project");

  const rationale = "reviews to sonnet; see FG-835 — \"quoted\" $(not a shell)";
  const apply = buildModelPolicyArgv("model-policy-apply", scratch, "/src/repo", "dashboard", rationale);
  assert.ok(!isRefusal(apply));
  if (!isRefusal(apply)) {
    assert.deepEqual(apply.argv, [
      "model", "policy", "apply", scratch, "--project", "/src/repo", "--confirm", "--by", "dashboard",
      "--source", "dashboard", "--rationale", rationale, "--json",
    ]);
    assert.ok(!apply.command.includes(rationale), "the display command never interpolates the rationale");
  }
  const hostApply = buildModelPolicyArgv("model-policy-apply", scratch, undefined, "dashboard", rationale);
  assert.ok(!isRefusal(hostApply));
  if (!isRefusal(hostApply)) {
    assert.deepEqual(hostApply.argv, ["model", "policy", "apply", scratch, "--confirm", "--by", "dashboard", "--source", "dashboard", "--rationale", rationale, "--json"]);
  }
  for (const built of [propose, hostPropose, apply, hostApply]) {
    assert.ok(!isRefusal(built) && !built.argv.includes("--force") && !built.argv.includes("--allow-undispatchable"));
  }
  for (const bad of [undefined, "", "   ", "-x", " --allow-undispatchable", "a".repeat(MAX_RATIONALE_CHARS + 1)]) {
    assert.ok(isRefusal(buildModelPolicyArgv("model-policy-apply", scratch, undefined, "dashboard", bad)), String(bad).slice(0, 20));
  }
  assert.ok(isRefusal(buildModelPolicyArgv("model-policy-propose", "relative.yml", undefined, "dashboard")));
  assert.ok(isRefusal(buildModelPolicyArgv("model-policy-propose", "/s.yml", "src/repo", "dashboard")));
});

test("listPolicyBackups: only <target>.bak-* files beside the target, newest first, with sha256 and size", () => {
  const dir = mkdtempSync(join(tmpdir(), "fg835-backups-"));
  const target = join(dir, "model-policy.yml");
  writeFileSync(target, "current\n");
  writeFileSync(join(dir, "model-policy.yml.bak-2026-09-01T00:00:00.000Z"), "old\n");
  writeFileSync(join(dir, "model-policy.yml.bak-2026-09-02T00:00:00.000Z"), "newer\n");
  writeFileSync(join(dir, "model-policy-audit.log"), "{}\n");
  writeFileSync(join(dir, "forge-raci.md.bak-2026-09-03T00:00:00.000Z"), "unrelated\n");
  const backups = listPolicyBackups(target);
  assert.deepEqual(backups.map((b) => b.timestamp), ["2026-09-02T00:00:00.000Z", "2026-09-01T00:00:00.000Z"]);
  assert.deepEqual(backups[0], {
    path: join(dir, "model-policy.yml.bak-2026-09-02T00:00:00.000Z"),
    name: "model-policy.yml.bak-2026-09-02T00:00:00.000Z",
    timestamp: "2026-09-02T00:00:00.000Z",
    sha256: sha256Hex("newer\n"),
    bytes: 6,
  });
  assert.equal(listPolicyBackups(target, 1).length, 1);
  assert.deepEqual(listPolicyBackups(join(dir, "missing", "model-policy.yml")), []);
});

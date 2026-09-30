// FG-834 — the pure half of the RACI routes: the proposal window, the body shape, the
// four named apply refusals, and the argv builder.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RACI_CANDIDATE_BYTES,
  MAX_RATIONALE_CHARS,
  PROPOSAL_WINDOW_MS,
  ProposalWindow,
  applyRefusal,
  buildRaciArgv,
  parseRaciRequest,
  sha256Hex,
  type RaciRequest,
} from "./raci-mutation.js";
import { isRefusal } from "./mutation-guards.js";

const T0 = Date.parse("2026-09-30T12:00:00Z");

test("ProposalWindow: a recorded propose is admissible for the window, then expires", () => {
  const w = new ProposalWindow(1000);
  assert.equal(w.record("p\n/dir", "abc", T0), T0 + 1000);
  assert.equal(w.has("p\n/dir", "abc", T0 + 1000), true);
  assert.equal(w.has("p\n/dir", "abc", T0 + 1001), false);
  assert.equal(w.size, 0, "expired entries are pruned");
});

test("ProposalWindow: keyed by scope AND sha — another checkout or another candidate is not admitted", () => {
  const w = new ProposalWindow();
  w.record("p\n/a", "sha1", T0);
  assert.equal(w.has("p\n/a", "sha1", T0), true);
  assert.equal(w.has("p\n/b", "sha1", T0), false);
  assert.equal(w.has("q\n/a", "sha1", T0), false);
  assert.equal(w.has("p\n/a", "sha2", T0), false);
});

test("ProposalWindow: re-proposing refreshes the window; consume spends it", () => {
  const w = new ProposalWindow(1000);
  w.record("s", "x", T0);
  w.record("s", "x", T0 + 900);
  assert.equal(w.has("s", "x", T0 + 1800), true);
  w.consume("s", "x");
  assert.equal(w.has("s", "x", T0 + 1800), false);
});

test("ProposalWindow: bounded — the oldest proposal is evicted past the cap", () => {
  const w = new ProposalWindow(PROPOSAL_WINDOW_MS, 3);
  for (const sha of ["a", "b", "c", "d"]) w.record("s", sha, T0);
  assert.equal(w.size, 3);
  assert.equal(w.has("s", "a", T0), false);
  assert.equal(w.has("s", "d", T0), true);
});

test("parseRaciRequest: the one shape each route takes; unknown fields (force) refused", () => {
  const ok = parseRaciRequest("raci-propose", { projectKey: "k", candidate: "# RACI\n" });
  assert.ok(!isRefusal(ok));
  if (!isRefusal(ok)) assert.equal(ok.candidateSha256, sha256Hex("# RACI\n"));
  for (const body of [{ projectKey: "k", candidate: "x", force: true }, { projectKey: "k", candidate: "x", rationale: "r" }]) {
    const out = parseRaciRequest("raci-propose", body);
    assert.ok(isRefusal(out) && out.status === 400, JSON.stringify(body));
  }
  for (const body of [null, [], "x", {}, { projectKey: "k" }, { candidate: "x" }, { projectKey: "k", candidate: "  " }, { projectKey: "k", candidate: 5 }]) {
    assert.ok(isRefusal(parseRaciRequest("raci-propose", body)), JSON.stringify(body));
  }
  const apply = parseRaciRequest("raci-apply", { projectKey: "k", candidate: "x", proposedSha256: "s", confirmKey: "k", rationale: "why" });
  assert.ok(!isRefusal(apply));
  assert.ok(isRefusal(parseRaciRequest("raci-apply", { projectKey: "k", candidate: "x", confirmKey: 7 })));
});

test("parseRaciRequest: the candidate is bounded at MAX_RACI_CANDIDATE_BYTES (bytes, not characters)", () => {
  assert.ok(!isRefusal(parseRaciRequest("raci-propose", { projectKey: "k", candidate: "a".repeat(MAX_RACI_CANDIDATE_BYTES) })));
  const over = parseRaciRequest("raci-propose", { projectKey: "k", candidate: "a".repeat(MAX_RACI_CANDIDATE_BYTES + 1) });
  assert.ok(isRefusal(over) && over.status === 413);
  const multibyte = parseRaciRequest("raci-propose", { projectKey: "k", candidate: "é".repeat(MAX_RACI_CANDIDATE_BYTES / 2 + 1) });
  assert.ok(isRefusal(multibyte) && multibyte.status === 413);
});

function applyRequest(over: Partial<RaciRequest> = {}): RaciRequest {
  const candidate = "# RACI\n";
  return { projectKey: "github.com/o/r", projectDir: undefined, candidate, candidateSha256: sha256Hex(candidate), proposedSha256: sha256Hex(candidate), confirmKey: "github.com/o/r", rationale: "tighten routing", ...over };
}

test("applyRefusal: the named refusals, and null when every precondition holds", () => {
  const w = new ProposalWindow();
  const scope = "github.com/o/r\n/dir";
  assert.equal(applyRefusal(applyRequest(), scope, w, T0)?.refusal, "candidate_not_proposed");
  w.record(scope, applyRequest().candidateSha256, T0);
  assert.equal(applyRefusal(applyRequest(), scope, w, T0), null);
  assert.equal(applyRefusal(applyRequest(), "github.com/o/r\n/other", w, T0)?.refusal, "candidate_not_proposed");
  assert.equal(applyRefusal(applyRequest(), scope, w, T0 + PROPOSAL_WINDOW_MS + 1)?.refusal, "candidate_not_proposed");
  assert.equal(applyRefusal(applyRequest({ proposedSha256: sha256Hex("other") }), scope, w, T0)?.refusal, "candidate_changed");
  assert.equal(applyRefusal(applyRequest({ proposedSha256: undefined }), scope, w, T0)?.refusal, "candidate_changed");
  assert.equal(applyRefusal(applyRequest({ confirmKey: "github.com/o/R" }), scope, w, T0)?.refusal, "confirm_key_mismatch");
  assert.equal(applyRefusal(applyRequest({ confirmKey: undefined }), scope, w, T0)?.refusal, "confirm_key_mismatch");
  for (const rationale of [undefined, "", "  \n"]) {
    assert.equal(applyRefusal(applyRequest({ rationale }), scope, w, T0)?.refusal, "rationale_required");
  }
  for (const rationale of ["-x", "--force", "  --confirm", "a".repeat(MAX_RATIONALE_CHARS + 1)]) {
    assert.equal(applyRefusal(applyRequest({ rationale }), scope, w, T0)?.refusal, "rationale_invalid", rationale.slice(0, 20));
  }
  w.record(scope, applyRequest().candidateSha256, T0);
  assert.equal(applyRefusal(applyRequest({ rationale: "a".repeat(MAX_RATIONALE_CHARS) }), scope, w, T0), null);
});

test("buildRaciArgv: fixed argv, the scratch path and the registry checkout only, never --force", () => {
  const propose = buildRaciArgv("raci-propose", "/home/f/.forge/dashboard/raci-candidates/c-1/forge-raci.md", "/src/repo", "dashboard");
  assert.ok(!isRefusal(propose));
  if (!isRefusal(propose)) {
    assert.deepEqual(propose.argv, ["raci", "propose", "/home/f/.forge/dashboard/raci-candidates/c-1/forge-raci.md", "--project", "/src/repo", "--json"]);
  }
  const rationale = "tighten routing; see FG-834 — \"quoted\" $(not a shell)";
  const apply = buildRaciArgv("raci-apply", "/s/forge-raci.md", "/src/repo", "dashboard", rationale);
  assert.ok(!isRefusal(apply));
  if (!isRefusal(apply)) {
    assert.deepEqual(apply.argv, [
      "raci", "apply", "/s/forge-raci.md", "--project", "/src/repo", "--confirm", "--by", "dashboard",
      "--source", "dashboard", "--rationale", rationale, "--json",
    ]);
    assert.ok(!apply.argv.includes("--force"));
    assert.ok(!apply.command.includes(rationale), "the display command never interpolates the rationale");
  }
  for (const bad of [undefined, "", "   ", "-x", " --force", "a".repeat(MAX_RATIONALE_CHARS + 1)]) {
    assert.ok(isRefusal(buildRaciArgv("raci-apply", "/s/forge-raci.md", "/src/repo", "dashboard", bad)), String(bad).slice(0, 20));
  }
  assert.ok(isRefusal(buildRaciArgv("raci-propose", "relative.md", "/src/repo", "dashboard")));
  assert.ok(isRefusal(buildRaciArgv("raci-propose", "/s.md", "src/repo", "dashboard")));
});

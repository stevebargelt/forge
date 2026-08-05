// FG-679 (BD-5/BD-7): observeCiGate — the required-CI probe that keeps the
// per-context detail CiGateStatus drops on the floor.
//
// The point of these tests is the DETAIL, and specifically the SUCCESS case:
// probeCiGateStatus's `success` carries no checks at all, `failed` carries only
// the first failing context, `pending` only the pending ones, and none of them
// carries an observation time — so persisting a CiGateStatus could never satisfy
// BD-5's "name the exact candidate sha and enumerate EACH required context with
// its state, URL and observation time".
//
// The other half is BD-7's "ONE observer": probeCiGateStatus is a projection of
// observeCiGate, so both walk the identical deriveRequiredGateList /
// projectCiRunsCommand fail-closed trust chain in ONE pass over the required
// jobs. The projection-identity and provider-call-count tests below are what
// stop that from silently becoming two pollers.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  observeCiGate,
  probeCiGateStatus,
  REQUIRED_CI_CHECK_CONTEXT,
  type CheckStatusProvider,
  type CiContextObservation,
} from "./host-verifications.js";

const GATE_CMD = "npm run test:all";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const EXTENDED_CONTEXT = "CI / test-extended";

let projectDir: string;

function writeWorkflow(body: string): void {
  rmSync(join(projectDir, ".github"), { recursive: true, force: true });
  mkdirSync(join(projectDir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(projectDir, ".github", "workflows", "ci.yml"), body);
}

function writeTwoJobWorkflow(): void {
  writeWorkflow(`name: CI\njobs:\n  test:\n    steps:\n      - run: ${GATE_CMD}\n  test-extended:\n    steps:\n      - run: npm run test:extended\n`);
}

function observe(provider: CheckStatusProvider, opts: { sha?: string; now?: () => number } = {}) {
  return observeCiGate({
    projectDir, sha: opts.sha ?? SHA, command: GATE_CMD, checkStatusProvider: provider,
    ...(opts.now ? { now: opts.now } : {}),
  });
}

function byContext(contexts: CiContextObservation[], context: string): CiContextObservation {
  const found = contexts.find((c) => c.context === context);
  assert.ok(found, `expected an observation for "${context}", got ${JSON.stringify(contexts.map((c) => c.context))}`);
  return found;
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "fg679-ci-obs-"));
  writeWorkflow(`name: CI\njobs:\n  test:\n    steps:\n      - run: ${GATE_CMD}\n`);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("observeCiGate: every required context, for every outcome", () => {
  test("SUCCESS — the case CiGateStatus drops entirely: every required context is still enumerated with state, url and observation time", () => {
    writeTwoJobWorkflow();
    const { status, observation } = observe(({ checkContext }) => ({
      sha: SHA, state: "success", detailsUrl: `https://example.com/run/${encodeURIComponent(checkContext)}`,
    }));

    // What the existing verdict carries: nothing at all beyond "success".
    assert.deepEqual(status, { kind: "success" });

    assert.equal(observation.outcome, "success");
    assert.equal(observation.candidateSha, SHA);
    assert.equal(observation.unavailableReason, null);
    assert.deepEqual(
      observation.contexts.map((c) => c.context).sort(),
      [REQUIRED_CI_CHECK_CONTEXT, EXTENDED_CONTEXT].sort(),
      "EVERY required context is enumerated on success — not just the paired job, and not a summary verdict",
    );
    for (const c of observation.contexts) {
      assert.equal(c.state, "success");
      assert.equal(c.url, `https://example.com/run/${encodeURIComponent(c.context)}`);
      assert.ok(!Number.isNaN(Date.parse(c.observedAt)), `per-context observedAt must parse as a date: ${c.observedAt}`);
    }
  });

  test("PENDING — a green sibling is enumerated alongside the pending one (CiGateStatus.checks carries only the pending ones)", () => {
    writeTwoJobWorkflow();
    const { status, observation } = observe(({ checkContext }) =>
      checkContext === REQUIRED_CI_CHECK_CONTEXT
        ? { sha: SHA, state: "pending", detailsUrl: "https://example.com/run/pending" }
        : { sha: SHA, state: "success", detailsUrl: "https://example.com/run/green" });

    assert.equal(status.kind, "pending");
    assert.deepEqual(
      (status as { kind: "pending"; checks: { context: string }[] }).checks.map((c) => c.context),
      [REQUIRED_CI_CHECK_CONTEXT],
      "the verdict names only the pending check — which is exactly why it cannot satisfy BD-5",
    );

    assert.equal(observation.outcome, "pending");
    assert.equal(observation.contexts.length, 2);
    assert.equal(byContext(observation.contexts, REQUIRED_CI_CHECK_CONTEXT).state, "pending");
    assert.equal(byContext(observation.contexts, EXTENDED_CONTEXT).state, "success");
    assert.equal(byContext(observation.contexts, EXTENDED_CONTEXT).url, "https://example.com/run/green");
  });

  test("FAILED — every required context is enumerated, not just the first failing one", () => {
    writeTwoJobWorkflow();
    const { status, observation } = observe(({ checkContext }) =>
      checkContext === REQUIRED_CI_CHECK_CONTEXT
        ? { sha: SHA, state: "failure", detailsUrl: "https://example.com/run/red" }
        : { sha: SHA, state: "pending" });

    assert.equal(status.kind, "failed");
    assert.deepEqual(
      (status as { kind: "failed"; failing: { context: string } }).failing.context,
      REQUIRED_CI_CHECK_CONTEXT,
    );

    assert.equal(observation.outcome, "failed");
    assert.equal(observation.unavailableReason, null);
    assert.equal(observation.contexts.length, 2);
    assert.equal(byContext(observation.contexts, REQUIRED_CI_CHECK_CONTEXT).state, "failure");
    assert.equal(byContext(observation.contexts, REQUIRED_CI_CHECK_CONTEXT).url, "https://example.com/run/red");
    assert.equal(byContext(observation.contexts, EXTENDED_CONTEXT).state, "pending");
  });

  test("UNAVAILABLE — a context the provider could not report on records `not_reported`, and the sibling it COULD report on is still enumerated", () => {
    writeTwoJobWorkflow();
    const { status, observation } = observe(({ checkContext }) =>
      checkContext === REQUIRED_CI_CHECK_CONTEXT ? null : { sha: SHA, state: "success", detailsUrl: "https://example.com/run/green" });

    assert.equal(status.kind, "unavailable");
    assert.equal(observation.outcome, "unavailable");
    assert.match(observation.unavailableReason ?? "", /no CI status available for check "CI \/ test"/);
    assert.equal(byContext(observation.contexts, REQUIRED_CI_CHECK_CONTEXT).state, "not_reported");
    assert.equal(byContext(observation.contexts, REQUIRED_CI_CHECK_CONTEXT).url, null);
    assert.equal(byContext(observation.contexts, EXTENDED_CONTEXT).state, "success");
  });

  test("a provider reporting a DIFFERENT sha records `sha_mismatch` and NEVER carries that run's url — foreign-sha evidence is not published under this candidate", () => {
    const { observation } = observe(() => ({ sha: OTHER_SHA, state: "success", detailsUrl: "https://example.com/run/other-sha" }));

    const ctxObs = byContext(observation.contexts, REQUIRED_CI_CHECK_CONTEXT);
    assert.equal(ctxObs.state, "sha_mismatch");
    assert.equal(ctxObs.url, null, "a url for a different sha must never be presented as evidence at this candidate");
    assert.equal(observation.outcome, "unavailable");
    assert.equal(observation.candidateSha, SHA, "the observation stays bound to the sha that was PROBED");
  });
});

describe("observeCiGate: what it never invents", () => {
  test("a failed precondition (no workflows dir) enumerates ZERO contexts and never consults the provider — an empty list is 'could not establish the required set', not 'nothing is required'", () => {
    rmSync(join(projectDir, ".github"), { recursive: true, force: true });
    let called = 0;
    const { status, observation } = observe(() => { called++; return { sha: SHA, state: "success" }; });

    assert.equal(called, 0);
    assert.equal(status.kind, "unavailable");
    assert.equal(observation.outcome, "unavailable");
    assert.deepEqual(observation.contexts, []);
    assert.ok((observation.unavailableReason ?? "").length > 0, "an unavailable observation always names why");
  });

  test("an invalid lookup sha fails closed before the provider, with no contexts", () => {
    let called = 0;
    const { observation } = observe(() => { called++; return { sha: SHA, state: "success" }; }, { sha: "not-a-sha" });

    assert.equal(called, 0);
    assert.equal(observation.outcome, "unavailable");
    assert.deepEqual(observation.contexts, []);
    assert.equal(observation.candidateSha, "not-a-sha");
  });

  test("every enumerated context is one the provider was actually asked about — the observation never names a check the pass did not probe", () => {
    writeTwoJobWorkflow();
    const asked: string[] = [];
    const { observation } = observe(({ checkContext }) => { asked.push(checkContext); return { sha: SHA, state: "success" }; });

    assert.deepEqual(observation.contexts.map((c) => c.context).sort(), asked.slice().sort());
  });

  test("the candidate sha is the FULL sha handed to the provider, never a short one", () => {
    const seen: string[] = [];
    const { observation } = observe(({ sha }) => { seen.push(sha); return { sha, state: "pending" }; });

    assert.equal(observation.candidateSha.length, 40);
    assert.deepEqual(new Set(seen), new Set([observation.candidateSha]));
  });
});

describe("observeCiGate: timestamps", () => {
  test("observedAt values are ISO 8601 and non-decreasing across the pass, from an injectable clock", () => {
    writeTwoJobWorkflow();
    let tick = 1_700_000_000_000;
    const now = (): number => { const v = tick; tick += 1000; return v; };
    const { observation } = observe(() => ({ sha: SHA, state: "success" }), { now });

    const stamps = [...observation.contexts.map((c) => c.observedAt), observation.observedAt];
    for (const s of stamps) {
      assert.equal(s, new Date(s).toISOString(), `${s} must be a round-trippable ISO 8601 timestamp`);
    }
    const sorted = [...stamps].sort();
    assert.deepEqual(stamps, sorted, "context times, then the pass's own time, must be non-decreasing");
    assert.notEqual(stamps[0], stamps[1], "each context carries the time IT was observed, not one time stamped over the whole pass");
  });

  test("an unusable injected clock degrades to the real one rather than throwing into the verification path it instruments", () => {
    const { observation } = observe(() => ({ sha: SHA, state: "success" }), { now: () => Number.NaN });
    assert.ok(!Number.isNaN(Date.parse(observation.observedAt)));
  });
});

describe("BD-7: ONE observer — probeCiGateStatus is a projection of observeCiGate", () => {
  const scenarios: { name: string; provider: CheckStatusProvider }[] = [
    { name: "all green", provider: () => ({ sha: SHA, state: "success", detailsUrl: "https://example.com/g" }) },
    { name: "pending", provider: () => ({ sha: SHA, state: "pending" }) },
    { name: "failing", provider: () => ({ sha: SHA, state: "failure", detailsUrl: "https://example.com/r" }) },
    { name: "completed-non-success (cancelled)", provider: () => ({ sha: SHA, state: "other" }) },
    { name: "unreportable", provider: () => null },
    { name: "sha mismatch", provider: () => ({ sha: OTHER_SHA, state: "success" }) },
    {
      name: "mixed: paired job green, sibling failing",
      provider: ({ checkContext }) => (checkContext === REQUIRED_CI_CHECK_CONTEXT
        ? { sha: SHA, state: "success" }
        : { sha: SHA, state: "failure", detailsUrl: "https://example.com/sib" }),
    },
  ];

  for (const s of scenarios) {
    test(`${s.name}: probeCiGateStatus returns exactly observeCiGate's status — no second, drifting classification`, () => {
      writeTwoJobWorkflow();
      assert.deepEqual(
        probeCiGateStatus({ projectDir, sha: SHA, command: GATE_CMD, checkStatusProvider: s.provider }),
        observe(s.provider).status,
      );
    });
  }

  test("capturing the detail costs no extra provider call: one pass over the required jobs, exactly as probeCiGateStatus always made", () => {
    writeTwoJobWorkflow();
    let probeCalls = 0;
    probeCiGateStatus({
      projectDir, sha: SHA, command: GATE_CMD,
      checkStatusProvider: () => { probeCalls++; return { sha: SHA, state: "pending" }; },
    });

    let observeCalls = 0;
    observe(() => { observeCalls++; return { sha: SHA, state: "pending" }; });

    assert.equal(observeCalls, 2, "one call per required job — no re-probe to collect the detail");
    assert.equal(observeCalls, probeCalls, "the detail-capturing observer must not poll CI any more than the status probe did");
  });
});

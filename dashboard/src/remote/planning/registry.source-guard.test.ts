// FG-783 (step 4) UNIT tier — the SOURCE GUARD over the closed planning registry (AC5).
// Spawns nothing: it enumerates the exported registry as data and proves two things a comment
// cannot: (1) the action set is EXACTLY the five planning wire actions and nothing else, and
// (2) not one of the capabilities the ticket names as out of scope is reachable through it —
// not as a key, not named by any authority, not anywhere in the registry's serialization.
//
// This is the AC5 migration of FG-781's "no non-GET branch" structural claim to "closed
// registry": the remote surface can dispatch these actions and only these.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REMOTE_PLANNING_ACTIONS,
  isRemotePlanningAction,
  planningActionSpec,
} from "./registry.js";

/** The complete, closed set. If a row is added or removed, THIS list must change with it —
 *  that is the point: widening the surface cannot be silent. */
const EXPECTED_ACTIONS = [
  "append-annotation",
  "change-rank",
  "dequeue",
  "enqueue",
  "reorder-queue",
] as const;

/** Every capability the ticket enumerates as OUT OF SCOPE for the remote surface. None may be
 *  reachable through the registry by any means. `arbitrary-cli` stands for "any CLI verb at
 *  all" — this surface delegates to in-process store authorities, never a shelled verb. */
const EXCLUDED_VERBS = [
  "completion",
  "complete",
  "closure",
  "close",
  "gate",
  "override",
  "run",
  "campaign",
  "merge",
  "publish",
  "review",
  "disposition",
  "terminal",
  "process",
  "cleanup",
  "credential",
  "raci",
  "routing",
  "model-policy",
  "arbitrary-cli",
  "exec",
  "shell",
  "spawn",
] as const;

test("the registry's action set is EXACTLY the five planning wire actions (AC5)", () => {
  const actual = Object.keys(REMOTE_PLANNING_ACTIONS).sort();
  assert.deepEqual(actual, [...EXPECTED_ACTIONS], "the closed registry must contain exactly these actions");
});

test("isRemotePlanningAction admits every registry member and rejects everything else", () => {
  for (const action of EXPECTED_ACTIONS) {
    assert.equal(isRemotePlanningAction(action), true, `${action} is a member`);
  }
  for (const excluded of EXCLUDED_VERBS) {
    assert.equal(isRemotePlanningAction(excluded), false, `${excluded} must not be a planning action`);
  }
  for (const junk of [null, undefined, "", "  ", 42, {}, ["enqueue"], "ENQUEUE", "queue enqueue"]) {
    assert.equal(isRemotePlanningAction(junk as unknown), false, `${JSON.stringify(junk)} must not be an action`);
  }
});

test("no excluded capability is reachable — not a key, not an authority, not anywhere in the registry", () => {
  const serialized = JSON.stringify(REMOTE_PLANNING_ACTIONS).toLowerCase();
  for (const excluded of EXCLUDED_VERBS) {
    assert.equal(
      Object.hasOwn(REMOTE_PLANNING_ACTIONS, excluded),
      false,
      `${excluded} must not be a registry key`,
    );
    assert.equal(
      serialized.includes(excluded),
      false,
      `the excluded capability "${excluded}" must appear NOWHERE in the registry (key, authority, or precondition)`,
    );
  }
});

test("every action delegates to an in-process store authority — no CLI-dispatch member exists", () => {
  for (const action of EXPECTED_ACTIONS) {
    const spec = planningActionSpec(action);
    assert.ok(spec, `${action} has a spec`);
    assert.equal(typeof spec.authority, "string");
    assert.notEqual(spec.authority.trim(), "", `${action} names a store authority`);
    // No authority may look like a shelled CLI invocation ("forge ...", "queue enqueue ...").
    assert.ok(
      !/\bforge\b/i.test(spec.authority) && !spec.authority.includes(" "),
      `${action}'s authority must be an in-process accessor name, not a CLI verb string (got ${spec.authority})`,
    );
  }
});

test("preconditions never key off a rank VALUE — only version / order / revision (D-invariant)", () => {
  const allowed = new Set(["queue-version", "readiness", "none", "ticket-revision"]);
  for (const action of EXPECTED_ACTIONS) {
    assert.ok(
      allowed.has(planningActionSpec(action).precondition),
      `${action} must use a version/order/revision precondition, never a rank value`,
    );
  }
});

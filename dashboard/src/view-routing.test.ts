import assert from "node:assert/strict";
import test from "node:test";
import { hashForView, initialView } from "../client/view-routing.js";

test("home is the default view for an empty or unknown hash", () => {
  assert.equal(initialView(""), "home");
  assert.equal(initialView("#"), "home");
  assert.equal(initialView("#unknown"), "home");
});

test("known view hashes remain directly addressable", () => {
  assert.equal(initialView("#activity"), "activity");
  assert.equal(initialView("#usage"), "usage");
  assert.equal(initialView("#governance"), "governance");
  // FG-638: the review ledger is a deep-linkable view, so a dashboard link in a
  // handoff note lands on it rather than silently falling back to home.
  assert.equal(initialView("#reviews"), "reviews");
  assert.equal(hashForView("reviews"), "#reviews");
  // FG-349: the Control Plane area is a deep-linkable view.
  assert.equal(initialView("#control-plane"), "control-plane");
  assert.equal(hashForView("control-plane"), "#control-plane");
});

test("FG-349: an unknown hash still falls back to home, control-plane is opt-in", () => {
  assert.equal(initialView("#control-planes"), "home");
});

test("home owns the hashless route while other views retain explicit hashes", () => {
  assert.equal(hashForView("home"), "");
  assert.equal(hashForView("activity"), "#activity");
  assert.equal(hashForView("usage"), "#usage");
});
